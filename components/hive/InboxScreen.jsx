// components/hive/InboxScreen.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the front-of-funnel worklist (doc §7, locked
// Inbox mockup): New (no contact yet) + Attempting (being worked), the
// people NOT yet in work-world. Send to Jobber is the one door across
// (§7) — it REUSES the app's existing SendToJobberPopup confirm flow
// (mounted by the beta branch in BeeHub scope; this screen only asks
// for it via onSendToJobber). No new write paths: 'Log call' posts the
// existing /api/touchpoints reach_out; snooze needs storage → 'soon'.
//
// Send gating mirrors the existing PersonPanel philosophy: hidden for
// clients already linked to Jobber (person.jobberRef — imported clients
// all carry their jobber_client_id; linked clients sync via webhooks).
// A fresh send this session flips jobberRef to 'REQ-…'/'JOB-…' (the
// popup's onDone patch) — that prefix drives the optimistic 'sent' row
// state. Rides in the beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { deriveClientStatus } from './shared/clientStatus'
import { relAge } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'

const TEAL_DARK = '#085041', TEAL_BG = '#E1F5EE'
const BLUE_DARK = '#0C447C', BLUE_BG = '#E6F1FB'
const SEND_GREEN = '#0F6E56'

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

const freshlySent = (p) => /^(REQ|JOB)-/.test(p.jobberRef || '')

function SectionLabel({ glyph, color, label, count, hint }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, letterSpacing: '0.6px', textTransform: 'uppercase', color, marginBottom: '8px' }}>
      <span style={{ marginRight: '5px' }}>{glyph}</span>
      {label} · {count} · <span style={{ color, opacity: 0.55, textTransform: 'none', letterSpacing: '0.3px' }}>{hint}</span>
    </p>
  )
}

const hairlineBtn = {
  padding: '6px 12px', borderRadius: '8px', border: '0.5px solid rgba(0,0,0,0.15)',
  background: '#fff', fontSize: '13px', fontWeight: 500, color: '#1a1a18',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}
const sendBtn = {
  padding: '6px 14px', borderRadius: '8px', border: 'none',
  background: SEND_GREEN, color: '#fff', fontSize: '13px', fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}

export default function InboxScreen({ people = [], engagements = [], locFilter = 'all', onOpenClient = () => {}, onSendToJobber = () => {}, setToast = () => {} }) {
  const [busyId, setBusyId] = useState(null)
  // Local session overrides: a logged call moves the row to Attempting
  // immediately (the real touchpoint is written; derivation catches up
  // on next load).
  const [loggedIds, setLoggedIds] = useState(() => new Set())
  const nowMs = Date.now()

  const [windowWidth, setWindowWidth] = useState(0)
  useEffect(() => {
    const check = () => setWindowWidth(window.innerWidth)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const isMobile = windowWidth > 0 && windowWidth < 768

  const scoped = useMemo(() => (
    locFilter === 'all' ? people : people.filter(p => p.locationId === locFilter)
  ), [people, locFilter])

  const openClientIds = useMemo(() => new Set(engagements.map(e => e.client_id)), [engagements])

  const { fresh, working } = useMemo(() => {
    const fresh = [], working = []
    for (const p of scoped) {
      const status = deriveClientStatus(p, openClientIds, nowMs)
      if (status === 'New') (loggedIds.has(p.id) ? working : fresh).push(p)
      else if (status === 'Attempting') working.push(p)
    }
    const created = (p) => new Date(p.created || 0).getTime() || 0
    fresh.sort((a, b) => created(b) - created(a))
    working.sort((a, b) => created(b) - created(a))
    return { fresh, working }
  }, [scoped, openClientIds, loggedIds]) // eslint-disable-line react-hooks/exhaustive-deps

  async function logCall(p) {
    setBusyId(p.id)
    try {
      const res = await fetch('/api/touchpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: p.id, kind: 'reach_out', label: 'Reach-out', method: 'call' }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setLoggedIds(prev => new Set(prev).add(p.id))
      setToast({ kind: 'success', msg: `Call logged for ${p.name}` })
    } catch (e) {
      setToast({ kind: 'error', msg: `Log failed: ${e.message}` })
    } finally {
      setBusyId(null)
    }
  }

  const lastReachOut = (p) => Math.max(0, ...(p.outreachTimeline || [])
    .filter(t => t.type === 'reach_out')
    .map(t => new Date(t.occurred_at || 0).getTime() || 0))

  const detailNew = (p) => {
    const bits = [p.source || 'inquiry', `${relAge(new Date(p.created || 0).getTime(), nowMs)} ago`]
    const snippet = (p.requestDetails || p.desc || '').trim()
    if (snippet) bits.push(`“${snippet.length > 60 ? snippet.slice(0, 57) + '…' : snippet}”`)
    return bits.join(' · ')
  }
  const detailWorking = (p) => {
    const reaches = (p.outreachTimeline || []).filter(t => t.type === 'reach_out').length + (loggedIds.has(p.id) ? 1 : 0)
    const last = loggedIds.has(p.id) ? nowMs : lastReachOut(p)
    return `${reaches} touchpoint${reaches === 1 ? '' : 's'}${last ? ` · last touch ${relAge(last, nowMs)} ago` : ''}`
  }

  function Row({ p, family, pill }) {
    const sent = freshlySent(p)
    const canSend = !p.jobberRef
    const actions = sent ? (
      <span style={{ fontSize: '12px', color: SEND_GREEN, fontWeight: 500, whiteSpace: 'nowrap' }}>
        ✓ sent — engagement will appear on the board
      </span>
    ) : (
      <>
        {pill === 'New' && (
          <button style={hairlineBtn} disabled={busyId === p.id}
            onClick={(ev) => { ev.stopPropagation(); logCall(p) }}>
            Log call
          </button>
        )}
        {canSend && (
          <button style={{ ...sendBtn, ...(isMobile ? { width: '100%' } : {}) }} disabled={busyId === p.id}
            onClick={(ev) => { ev.stopPropagation(); onSendToJobber(p) }}>
            Send to Jobber
          </button>
        )}
        <span title="Coming soon" style={{ fontSize: '11px', color: '#c9c7c0', cursor: 'default', whiteSpace: 'nowrap' }}>snooze · soon</span>
      </>
    )
    return (
      <div className="bee-inbox-row" onClick={() => onOpenClient(p.id)}
        style={{ padding: isMobile ? '12px 14px' : '13px 16px', borderBottom: '0.5px solid rgba(0,0,0,0.08)', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: family.bg, color: family.text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 600, flexShrink: 0 }}>
            {initialsOf(p.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '14px', fontWeight: 600, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <StatusChip label={pill} styleKey={pill === 'New' ? 'New' : 'Attempting'} />
            </p>
            <p style={{ fontSize: '11px', color: '#8a8a84', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' }}>
              {pill === 'New' ? detailNew(p) : detailWorking(p)}
            </p>
          </div>
          {!isMobile && (
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px' }} onClick={ev => ev.stopPropagation()}>
              {actions}
            </div>
          )}
        </div>
        {isMobile && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }} onClick={ev => ev.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
    )
  }

  const cardStyle = { background: '#fff', border: '0.5px solid rgba(0,0,0,0.08)', borderRadius: '12px', overflow: 'hidden' }

  return (
    <div>
      <style>{`.bee-inbox-row:hover { background:#f7f6f4 } .bee-inbox-row:last-child { border-bottom:none !important }`}</style>

      {fresh.length === 0 && working.length === 0 ? (
        <div style={{ padding: '36px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '12px' }}>
          new inquiries land here
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <SectionLabel glyph="✦" color={TEAL_DARK} label="New" count={fresh.length} hint="no contact yet" />
            {fresh.length > 0 ? (
              <div style={cardStyle}>
                {fresh.map(p => <Row key={p.id} p={p} family={{ bg: TEAL_BG, text: TEAL_DARK }} pill="New" />)}
              </div>
            ) : (
              <div style={{ padding: '20px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '12px' }}>
                new inquiries land here
              </div>
            )}
          </div>

          <div>
            <SectionLabel glyph="✆" color={BLUE_DARK} label="Attempting" count={working.length} hint="working the lead" />
            {working.length > 0 ? (
              <div style={cardStyle}>
                {working.map(p => <Row key={p.id} p={p} family={{ bg: BLUE_BG, text: BLUE_DARK }} pill="Attempting" />)}
              </div>
            ) : (
              <div style={{ padding: '20px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '12px' }}>
                leads you’ve reached out to appear here — log a call or email from any client
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
