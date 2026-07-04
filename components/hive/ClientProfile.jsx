// components/hive/ClientProfile.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 step 4 — the person card (approved client-card mockup),
// replacing PersonPanel INSIDE THE BETA ONLY (the legacy PersonPanel is
// untouched and remains the classic view's panel). Fetches
// GET /api/clients/:id/profile on open.
//
// Overlay model: HiveShell holds ONE overlay slot — ClientProfile and
// EngagementPanel REPLACE each other (no stacking): 'View client →' on
// the engagement panel swaps to this card; tapping an engagement card
// here swaps back. Two taps loop, zero modal piles.
//
// READ-mostly: buzz note + touchpoint use the existing write paths
// (client-level); contact editing stays in the classic view tonight;
// 'Activate drips' is step 5's. Send to Jobber reuses the existing
// popup via the same gate as the Inbox (!jobber link). Beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useRef } from 'react'
import { CHIP_STYLES, stageDisplayLabel } from './shared/stageConfig'
import { deriveClientStatus, CLIENT_STATUS_META } from './shared/clientStatus'
import { deriveStatusChip, engagementValue, displayTitle, fmtMoney, relAge } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import MetricCard from '@/components/ui/MetricCard'
import {
  IconPhone, IconMail, IconMapPin, IconPlayerPause, IconExternalLink, IconSend,
  IconInbox, IconFileText, IconHammer, IconFileInvoice, IconCheck, IconX, IconPhoneOutgoing,
} from '@/components/ui/icons'

const QUIET = '#f7f6f4'
const SEND_GREEN = '#0F6E56'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'
const monthYear = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d) ? null : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

const STAGE_ICON = {
  'Request': IconInbox, 'Estimate': IconFileText,
  'Job in Progress': IconHammer, 'Final Processing': IconFileInvoice,
}
const METHOD_ICON = { call: IconPhone, sms: IconPhone, email: IconMail }

function MicroLabel({ children }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '8px' }}>
      {children}
    </p>
  )
}

const outlineBtn = {
  flex: 1, minWidth: '140px',
  padding: '9px 12px', borderRadius: '8px', border: '0.5px solid rgba(0,0,0,0.15)',
  background: '#fff', fontSize: '13px', fontWeight: 500, color: '#1a1a18',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', textAlign: 'center',
}

export default function ClientProfile({ clientId, onClose, onOpenEngagement = () => {}, onSendToJobber = null, setToast = () => {} }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [showContacts, setShowContacts] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [showAllNotes, setShowAllNotes] = useState(false)
  const [showAllTouches, setShowAllTouches] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchMethod, setTouchMethod] = useState('call')
  const [touchNote, setTouchNote] = useState('')
  const [busy, setBusy] = useState(false)
  const touchY = useRef(null)
  const nowMs = Date.now()

  const [windowWidth, setWindowWidth] = useState(0)
  useEffect(() => {
    const check = () => setWindowWidth(window.innerWidth)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const isMobile = windowWidth > 0 && windowWidth < 768

  useEffect(() => {
    let dead = false
    setData(null); setLoadErr(null)
    fetch(`/api/clients/${clientId}/profile`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(d => { if (!dead) setData(d) })
      .catch(e => { if (!dead) setLoadErr(String(e.message || e)) })
    return () => { dead = true }
  }, [clientId])

  const c = data?.client
  const agg = data?.aggregates
  const engagements = data?.engagements ?? []
  const open = engagements.filter(e => e.stage !== 'Closed Won' && e.stage !== 'Closed Lost')
  const closed = engagements.filter(e => e.stage === 'Closed Won' || e.stage === 'Closed Lost')
  const buzz = data?.buzz_notes ?? []
  const touches = data?.touchpoints ?? []

  const status = c ? deriveClientStatus(
    {
      id: c.id, email: c.email, phone: c.phone, paidAmount: agg?.lifetime_paid ?? c.paid_amount,
      created: c.created_at,
      outreachTimeline: touches.map(t => ({ type: t.kind, occurred_at: t.occurred_at })),
    },
    new Set(open.length > 0 ? [c.id] : []),
    nowMs,
  ) : null
  const statusMeta = status ? CLIENT_STATUS_META[status] : null
  const fam = statusMeta ? (CHIP_STYLES[statusMeta.styleKey] || CHIP_STYLES.gray) : CHIP_STYLES.gray

  const jobberLinked = !!c?.jobber_client_id
  const jobberHref = (() => {
    for (const e of open.concat(closed)) {
      const j = (e.jobs || [])[0]
      if (j?.job_url) return j.job_url
    }
    return null
  })()

  async function addBuzzNote() {
    const text = noteText.trim()
    if (!text || !c) return
    setBusy(true)
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: c.id, kind: 'buzz', text }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setNoteText(''); setNoteOpen(false)
      setData(d => d ? { ...d, buzz_notes: [{ id: `tmp-${Date.now()}`, kind: 'buzz', text, created_at: new Date().toISOString() }, ...d.buzz_notes] } : d)
      setToast({ kind: 'success', msg: 'Buzz note added' })
    } catch (e) { setToast({ kind: 'error', msg: `Note failed: ${e.message}` }) }
    finally { setBusy(false) }
  }

  async function logTouchpoint() {
    if (!c) return
    setBusy(true)
    try {
      const res = await fetch('/api/touchpoints', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: c.id, kind: 'reach_out', label: 'Reach-out', method: touchMethod, notes: touchNote.trim() || null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setTouchNote(''); setTouchOpen(false)
      setData(d => d ? { ...d, touchpoints: [{ id: `tmp-${Date.now()}`, kind: 'reach_out', method: touchMethod, label: 'Reach-out', occurred_at: new Date().toISOString() }, ...d.touchpoints] } : d)
      setToast({ kind: 'success', msg: 'Touchpoint logged' })
    } catch (e) { setToast({ kind: 'error', msg: `Touchpoint failed: ${e.message}` }) }
    finally { setBusy(false) }
  }

  const contactRow = (Icon, value, href, missingLabel) => value ? (
    <p style={{ fontSize: '12px', color: '#1a1a18', display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
      <span style={{ color: '#8a8a84', display: 'inline-flex' }}><Icon size={13} /></span>
      {href ? (
        <a href={href} style={{ color: '#1a1a18', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</a>
      ) : (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      )}
    </p>
  ) : (
    <p title="Edit in the classic view (beta editing soon)" style={{ fontSize: '12px', color: '#c9c7c0', display: 'flex', alignItems: 'center', gap: '7px', cursor: 'default' }}>
      <span style={{ display: 'inline-flex' }}><Icon size={13} /></span>
      <span style={{ borderBottom: '1px dashed rgba(0,0,0,0.15)' }}>{missingLabel}</span>
    </p>
  )

  const address = c ? [c.address, [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ') : null

  const closedVisible = showClosed ? closed : closed.slice(0, 2)

  const body = c && (
    <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: fam.bg, color: fam.text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 600, flexShrink: 0 }}>
          {initialsOf(c.name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '16px', fontWeight: 500, color: '#1a1a18', display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            {statusMeta && <StatusChip label={statusMeta.label} styleKey={statusMeta.styleKey} />}
          </p>
          <p style={{ fontSize: '12px', color: '#8a8a84', marginTop: '2px' }}>
            {fmtMoney(agg?.lifetime_paid || 0)} lifetime · client since {monthYear(c.created_at) || '—'}{c.location_name ? ` · ${c.location_name}` : ''}
          </p>
        </div>
      </div>

      {/* Contact + Marketing */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px' }}>
        <div style={{ background: QUIET, borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <MicroLabel>Contact</MicroLabel>
          {contactRow(IconPhone, c.phone, c.phone ? `tel:${c.phone}` : null, 'add phone')}
          {contactRow(IconMail, c.email, c.email ? `mailto:${c.email}` : null, 'add email')}
          {contactRow(IconMapPin, address, null, 'add address')}
          {(data.contacts || []).length > 0 && (
            <button onClick={() => setShowContacts(v => !v)} style={{ border: 'none', background: 'transparent', padding: 0, textAlign: 'left', fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
              +{data.contacts.length} contact{data.contacts.length === 1 ? '' : 's'}: {data.contacts[0].name}{data.contacts[0].role ? ` (${data.contacts[0].role})` : ''}{data.contacts.length > 1 ? ' …' : ''}
            </button>
          )}
          {showContacts && data.contacts.map(ct => (
            <p key={ct.id} style={{ fontSize: '11px', color: '#6b6b66', paddingLeft: '20px' }}>
              {ct.name}{ct.role ? ` (${ct.role})` : ''}{ct.phone ? ` · ${ct.phone}` : ''}{ct.email ? ` · ${ct.email}` : ''}
            </p>
          ))}
          {jobberLinked && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
              <StatusChip label="Jobber linked" styleKey="teal" />
              {jobberHref && (
                <a href={jobberHref} target="_blank" rel="noreferrer" style={{ fontSize: '11px', color: '#378ADD', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                  <IconExternalLink size={11} /> open
                </a>
              )}
            </span>
          )}
        </div>
        <div style={{ background: QUIET, borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <MicroLabel>Marketing</MicroLabel>
          <p style={{ fontSize: '12px', color: c.paused ? '#633806' : '#085041', display: 'flex', alignItems: 'center', gap: '7px' }}>
            <IconPlayerPause size={13} /> {c.paused ? 'Drips paused' : 'Drips active'}
            <span title="Coming with drip activation (step 5)" style={{ fontSize: '11px', color: '#b5b3ac', cursor: 'default' }}>Activate · soon</span>
          </p>
          <p style={{ fontSize: '12px', color: c.marketing_opt_out ? '#791F1F' : '#8a8a84' }}>
            {c.marketing_opt_out ? 'Opted out of marketing' : 'No opt-outs'}
          </p>
          <p style={{ fontSize: '12px', color: '#8a8a84' }}>
            {c.referred_by_kind ? `Referred via ${String(c.referred_by_kind).replace(/_/g, ' ')}` : (c.source ? `Source: ${String(c.source).toLowerCase()}` : 'Source unknown')}
          </p>
        </div>
      </div>

      {/* Engagements */}
      <div>
        <MicroLabel>Engagements · {agg?.total_count ?? engagements.length} · {agg?.open_count ?? open.length} open</MicroLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {open.map(e => {
            const chip = deriveStatusChip(e, { nowMs })
            const StageIcon = STAGE_ICON[e.stage] || IconInbox
            const value = engagementValue(e)
            const statusColor = chip ? (CHIP_STYLES[chip.styleKey] || CHIP_STYLES.gray).text : '#8a8a84'
            return (
              <div key={e.id} onClick={() => onOpenEngagement(e)}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: '#fff', border: '0.5px solid rgba(0,0,0,0.08)', borderRadius: '8px', cursor: 'pointer' }}>
                <span style={{ color: (CHIP_STYLES[e.stage] || CHIP_STYLES.gray).text, display: 'inline-flex', flexShrink: 0 }}><StageIcon size={15} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayTitle(e)}{value != null ? ` · ${fmtMoney(value)}` : ''}
                  </p>
                  {chip && <p style={{ fontSize: '11px', fontWeight: 500, color: statusColor, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chip.label}</p>}
                </div>
                <span style={{ flexShrink: 0 }}><StatusChip label={stageDisplayLabel(e.stage)} styleKey={e.stage} /></span>
              </div>
            )
          })}
          {open.length === 0 && (
            <div style={{ padding: '14px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px', border: '0.5px dashed rgba(0,0,0,0.12)', borderRadius: '8px' }}>
              No open engagements
            </div>
          )}
          {closedVisible.map(e => {
            const won = e.stage === 'Closed Won'
            const money = Number(e.total_paid) > 0 ? e.total_paid : e.total_invoiced
            return (
              <div key={e.id} onClick={() => onOpenEngagement(e)}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 12px', cursor: 'pointer', opacity: 0.65 }}>
                <span style={{ color: won ? '#1D9E75' : '#b5b3ac', display: 'inline-flex', flexShrink: 0 }}>
                  {won ? <IconCheck size={12} /> : <IconX size={12} />}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: '11px', color: '#6b6b66', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayTitle(e)}{Number(money) > 0 ? ` · ${fmtMoney(money)}` : ''} · {won ? 'won' : 'lost'} {monthYear(e.closed_at) || ''}
                </span>
              </div>
            )
          })}
          {closed.length > 2 && !showClosed && (
            <button onClick={() => setShowClosed(true)} style={{ border: 'none', background: 'transparent', padding: '2px 12px', textAlign: 'left', fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
              Show {closed.length - 2} more closed
            </button>
          )}
        </div>
      </div>

      {/* Money tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: '8px' }}>
        <MetricCard label="Lifetime paid" value={fmtMoney(agg?.lifetime_paid || 0)} />
        <MetricCard label="Open pipeline" value={fmtMoney(agg?.open_pipeline || 0)} />
        <MetricCard label="Owing" value={fmtMoney(agg?.owing || 0)} tone={(agg?.owing || 0) > 0 ? 'red' : null} />
      </div>

      {/* Buzz notes + Outreach */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px' }}>
        <div style={{ background: QUIET, borderRadius: '8px', padding: '12px 14px' }}>
          <MicroLabel>Buzz notes</MicroLabel>
          {(showAllNotes ? buzz : buzz.slice(0, 3)).map(n => (
            <p key={n.id} style={{ fontSize: '12px', color: '#1a1a18', marginBottom: '6px', lineHeight: 1.4 }}>
              🐝 {n.text}
              <span style={{ fontSize: '10px', color: '#b5b3ac', marginLeft: '6px' }}>{relAge(new Date(n.created_at).getTime(), nowMs)} ago</span>
            </p>
          ))}
          {buzz.length === 0 && <p style={{ fontSize: '11px', color: '#b5b3ac' }}>No buzz notes yet</p>}
          {buzz.length > 3 && !showAllNotes && (
            <button onClick={() => setShowAllNotes(true)} style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>Show more</button>
          )}
        </div>
        <div style={{ background: QUIET, borderRadius: '8px', padding: '12px 14px' }}>
          <MicroLabel>Outreach</MicroLabel>
          {(showAllTouches ? touches : touches.slice(0, 3)).map(t => {
            const MIcon = METHOD_ICON[t.method] || IconPhoneOutgoing
            return (
              <p key={t.id} style={{ fontSize: '12px', color: '#1a1a18', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: '#8a8a84', display: 'inline-flex' }}><MIcon size={12} /></span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}{t.method ? ` (${t.method.replace('_', ' ')})` : ''}</span>
                <span style={{ fontSize: '10px', color: '#b5b3ac', flexShrink: 0 }}>{relAge(new Date(t.occurred_at).getTime(), nowMs)} ago</span>
              </p>
            )
          })}
          {touches.length === 0 && <p style={{ fontSize: '11px', color: '#b5b3ac' }}>No outreach logged yet</p>}
          {touches.length > 3 && !showAllTouches && (
            <button onClick={() => setShowAllTouches(true)} style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>Show more</button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div>
        <MicroLabel>Actions</MicroLabel>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button style={outlineBtn} disabled={busy} onClick={() => { setNoteOpen(v => !v); setTouchOpen(false) }}>🐝 Add buzz note</button>
          <button style={outlineBtn} disabled={busy} onClick={() => { setTouchOpen(v => !v); setNoteOpen(false) }}>
            <IconPhone size={14} style={{ marginRight: '5px' }} /> Log touchpoint
          </button>
          {jobberLinked ? (
            jobberHref ? (
              <a href={jobberHref} target="_blank" rel="noreferrer" style={{ ...outlineBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <IconExternalLink size={14} style={{ marginRight: '5px' }} /> Open in Jobber
              </a>
            ) : (
              <span title="No Jobber record link available" style={{ ...outlineBtn, color: '#c9c7c0', cursor: 'default', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <IconExternalLink size={14} style={{ marginRight: '5px' }} /> Open in Jobber
              </span>
            )
          ) : (
            onSendToJobber && (
              <button
                style={{ ...outlineBtn, background: SEND_GREEN, color: '#fff', border: 'none' }}
                disabled={busy}
                onClick={() => onSendToJobber(c.id)}
              >
                <IconSend size={14} style={{ marginRight: '5px' }} /> Send to Jobber
              </button>
            )
          )}
        </div>
        {noteOpen && (
          <div style={{ marginTop: '10px', display: 'flex', gap: '8px' }}>
            <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Buzz note…" autoFocus
              onKeyDown={e => { if (e.key === 'Enter') addBuzzNote() }}
              style={{ flex: 1, padding: '8px 12px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
            <button style={{ ...outlineBtn, flex: '0 0 auto', minWidth: 0 }} disabled={busy || !noteText.trim()} onClick={addBuzzNote}>Save</button>
          </div>
        )}
        {touchOpen && (
          <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <select value={touchMethod} onChange={e => setTouchMethod(e.target.value)}
              style={{ padding: '8px 10px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', background: '#fff' }}>
              <option value="call">Call</option>
              <option value="sms">Text</option>
              <option value="email">Email</option>
              <option value="in_person">In person</option>
            </select>
            <input value={touchNote} onChange={e => setTouchNote(e.target.value)} placeholder="Notes (optional)…"
              onKeyDown={e => { if (e.key === 'Enter') logTouchpoint() }}
              style={{ flex: 1, minWidth: '140px', padding: '8px 12px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
            <button style={{ ...outlineBtn, flex: '0 0 auto', minWidth: 0 }} disabled={busy} onClick={logTouchpoint}>Log</button>
          </div>
        )}
      </div>
    </div>
  )

  const loading = !data && !loadErr && (
    <div style={{ padding: '40px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>Loading…</div>
  )
  const errBlock = loadErr && (
    <p style={{ margin: '0 24px 24px', fontSize: '12px', color: '#791F1F', background: '#FCEBEB', padding: '8px 12px', borderRadius: '8px' }}>
      Couldn’t load client: {loadErr}
    </p>
  )

  if (isMobile) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 10005, display: 'flex', alignItems: 'flex-end', background: 'rgba(26,26,24,0.35)' }} onClick={onClose}>
        <div onClick={e => e.stopPropagation()}
          style={{ background: '#fff', width: '100%', maxHeight: '88vh', overflowY: 'auto', borderRadius: '20px 20px 0 0', boxShadow: '0 -8px 40px rgba(26,26,24,0.2)' }}>
          <div
            onTouchStart={e => { touchY.current = e.touches[0].clientY }}
            onTouchEnd={e => {
              if (touchY.current == null) return
              const dy = e.changedTouches[0].clientY - touchY.current
              touchY.current = null
              if (dy > 60) onClose()
            }}
            style={{ padding: '10px 0 8px', cursor: 'grab' }}
          >
            <div style={{ width: '36px', height: '4px', background: 'rgba(0,0,0,0.15)', borderRadius: '2px', margin: '0 auto' }} />
          </div>
          {loading}{errBlock}{body}
        </div>
      </div>
    )
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10005, background: 'rgba(26,26,24,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '740px', maxHeight: '88vh', overflowY: 'auto', background: '#fff', borderRadius: '16px', boxShadow: '0 24px 80px rgba(26,26,24,0.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 16px 4px' }}>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#b5b3ac', cursor: 'pointer', lineHeight: 1, padding: '2px 4px' }}><IconX size={16} /></button>
        </div>
        {loading}{errBlock}{body}
      </div>
    </div>
  )
}
