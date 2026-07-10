// components/hive/ClientProfile.jsx
// ─────────────────────────────────────────────────────────────
// The CLIENT-level card (fullest of the three) — tabbed layout
// (approved): compact header → VITALS STRIP (Status / Lifetime / Last
// touch / Open — the four-cell client-health row, visible on every tab)
// → tabs (Overview / Timeline / Files) → content. Fetches
// GET /api/clients/:id/profile on open.
//
// The strip REPLACED the Overview money-tiles row (Lifetime/Open/Owing).
// Owing keeps a red Key-facts line when nonzero (plus each Final
// Processing engagement row's 'Owes $X' chip) — nothing silently drops.
//
// Overview: pinned buzz (client-level — the SAME note every engagement
// panel inherits) → key facts (contact + display-only
// source line + shared ReferrerField + referred-us) → request details
// (pre-Jobber only) → engagements list (open tappable → swaps to
// EngagementPanel; closed capped at 2) → recent activity (client-WIDE
// slice: kind='job' notes — INCLUDING client-level ones posted on
// PersonCard, the old inventory gap — + touchpoints, engagement-scoped
// items tagged '· re: <title>') + composer → soft-tinted equal-grid
// actions (cardKit ActionRow).
//
// Overlay model: HiveShell holds ONE overlay slot — ClientProfile and
// EngagementPanel REPLACE each other (no stacking); two taps loop,
// zero modal piles.
//
// Source stays display-only here (no meta pill — deliberate); the
// ReferrerField is the shared edit affordance. Beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { CHIP_STYLES, stageDisplayLabel, ACCENT_BLUE } from './shared/stageConfig'
import { deriveClientStatus, CLIENT_STATUS_META } from './shared/clientStatus'
import { deriveStatusChip, engagementValue, displayTitle, fmtMoney, formatFullDate } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import VitalsStrip, { vitalsAge } from './shared/VitalsStrip'
import {
  IconPhone, IconMail, IconMapPin, IconPlayerPause, IconExternalLink, IconSend,
  IconInbox, IconFileText, IconHammer, IconFileInvoice, IconCheck, IconX, IconPlus, IconPaperclip,
} from '@/components/ui/icons'
import EditableDesc from './EditableDesc'
import OverlayShell from './OverlayShell'
import ReferrerField from './shared/ReferrerField'
import Timeline from './shared/Timeline'
import CardTabs from './shared/CardTabs'
import PinnedBuzz from './shared/PinnedBuzz'
import InitialsAvatar from './shared/InitialsAvatar'
import NotesStream from './NotesStream'
import { MicroLabel, quietBtn, CardMenu, undoToast, ActionRow, actionBtn } from './shared/cardKit'
import useIsMobile from './shared/useIsMobile'

const QUIET = '#f7f6f4'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const monthYear = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  return isNaN(d) ? null : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

const STAGE_ICON = {
  'Request': IconInbox, 'Estimate': IconFileText,
  'Job in Progress': IconHammer, 'Final Processing': IconFileInvoice,
}

export default function ClientProfile({ clientId, people = [], onClose, onOpenEngagement = () => {}, onSendToJobber = null, setToast = () => {}, onLeadPatched = () => {}, onPartnerCreated = () => {} }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [tab, setTab] = useState('overview')
  const [showContacts, setShowContacts] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchMethod, setTouchMethod] = useState('call')
  const [touchNote, setTouchNote] = useState('')
  const [busy, setBusy] = useState(false)
  const nowMs = Date.now()

  const isMobile = useIsMobile()

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
  const jobNotes = data?.job_notes ?? []
  const engTitleById = Object.fromEntries(engagements.map(e => [e.id, displayTitle(e)]))

  // Won roll-up from the profile's own (complete, current) engagement set —
  // same shape the hub-page sweep ships as person.wonEngagements.
  const won = engagements.filter(e => e.stage === 'Closed Won')
  const wonSummary = won.length > 0 ? {
    count: won.length,
    value: won.reduce((s, e) => s + (Number(e.total_paid) || Number(e.total_invoiced) || 0), 0),
    lastClosedAt: won.map(e => e.closed_at).filter(Boolean).sort().pop() || null,
  } : null
  const status = c ? deriveClientStatus(
    {
      // || not ??: the aggregate is always numeric once loaded, so ?? never
      // falls back — a $0 engagement sum must not mask the leads.paid_amount
      // denorm for the Past existence test (paidAmount > 0).
      id: c.id, email: c.email, phone: c.phone, paidAmount: agg?.lifetime_paid || c.paid_amount,
      created: c.created_at,
      outreachTimeline: touches.map(t => ({ type: t.kind, occurred_at: t.occurred_at })),
      wonEngagements: wonSummary,
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

  async function patchLead(patch) {
    const res = await fetch(`/api/leads/${c.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
  }

  // Posted from the pinned buzz band (append-only; it owns the draft,
  // we own the notes array + optimistic prepend).
  async function addBuzzNote(text) {
    if (!text || !c) return
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: c.id, kind: 'buzz', text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, buzz_notes: [j.note, ...d.buzz_notes] } : d)
    } catch (e) { setToast({ kind: 'error', msg: `Note failed: ${e.message}` }) }
  }

  // Client-level note (kind='job', no engagement_id) — the same write
  // PersonCard's composer uses; both cards read the same rows now.
  async function addNote(text) {
    if (!text || !c) return
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: c.id, kind: 'job', text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, job_notes: [j.note, ...(d.job_notes || [])] } : d)
    } catch (e) { setToast({ kind: 'error', msg: `Note failed: ${e.message}` }) }
  }

  async function saveReqDetails(text) {
    if (!c) return
    const prev = c.request_details
    setData(d => d ? { ...d, client: { ...d.client, request_details: text || null } } : d)
    try {
      await patchLead({ request_details: text || null })
      setToast({ kind: 'success', msg: 'Description saved' })
    } catch (e) {
      setData(d => d ? { ...d, client: { ...d.client, request_details: prev } } : d)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    }
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

  // Manual founding — POST /api/engagements (founded_by='manual'), then
  // swap straight to the new engagement's panel (same overlay slot).
  async function newEngagement() {
    if (!c) return
    setBusy(true)
    try {
      const res = await fetch('/api/engagements', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: c.id }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setToast({ kind: 'success', msg: 'Engagement created' })
      if (j.engagement) onOpenEngagement(j.engagement)
    } catch (e) { setToast({ kind: 'error', msg: `Create failed: ${e.message}` }) }
    finally { setBusy(false) }
  }

  async function markJunk() {
    if (!c) return
    try {
      await patchLead({ is_junk: true })
      onLeadPatched(c.id, { is_junk: true })
      setToast(undoToast('Marked as junk', async () => {
        try {
          await patchLead({ is_junk: false })
          onLeadPatched(c.id, { is_junk: false })
          setToast({ kind: 'success', msg: `${c.name} restored` })
        } catch (e) { setToast({ kind: 'error', msg: `Undo failed: ${e.message}` }) }
      }))
    } catch (e) { setToast({ kind: 'error', msg: `Junk failed: ${e.message}` }) }
  }

  const contactRow = (Icon, value, href, missingLabel) => value ? (
    <p style={{ fontSize: '12px', color: '#1a1a18', display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
      <span style={{ color: '#8a8a84', display: 'inline-flex' }}><Icon size={13} /></span>
      {href ? (
        <a className="bee-contact-link" href={href} style={{ color: ACCENT_BLUE, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</a>
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

  // Client-WIDE recent slice — job notes (client-level + engagement-
  // scoped, the latter tagged) + touchpoints (tagged when scoped).
  const stream = [
    ...jobNotes.map(n => ({ t: 'note', ts: n.created_at, tag: n.engagement_id ? engTitleById[n.engagement_id] : null, ...n })),
    ...touches.map(tp => ({ t: 'touch', ts: tp.occurred_at, tag: tp.engagement_id ? engTitleById[tp.engagement_id] : null, ...tp })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 8)

  const overview = c && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* Pinned buzz — the client's standing note; the SAME rows show on
          this client's EngagementPanel(s). */}
      <PinnedBuzz notes={buzz} onPost={addBuzzNote} emptyLabel="Add a note about this client" nowMs={nowMs} />

      {/* Key facts — contact + marketing state; Source stays display-only
          on this surface (deliberate: the ReferrerField below is the edit
          affordance, shared with the other two cards). */}
      <div style={{ background: QUIET, borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
        <MicroLabel>Key facts</MicroLabel>
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <StatusChip label="Jobber linked" styleKey="teal" />
            {jobberHref && (
              <a className="bee-contact-link" href={jobberHref} target="_blank" rel="noreferrer" style={{ fontSize: '11px', color: ACCENT_BLUE, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                <IconExternalLink size={11} /> open
              </a>
            )}
          </span>
        )}
        {/* Nonzero owing stays loud after the money tiles' removal — the
            strip has no Owing cell (Open replaced it). */}
        {(agg?.owing || 0) > 0 && (
          <p style={{ fontSize: '12px', fontWeight: 500, color: '#791F1F' }}>Owing {fmtMoney(agg.owing)}</p>
        )}
        <p style={{ fontSize: '12px', color: c.paused ? '#633806' : '#085041', display: 'flex', alignItems: 'center', gap: '7px' }}>
          <IconPlayerPause size={13} /> {c.paused ? 'Drips paused' : 'Drips active'}
        </p>
        {c.marketing_opt_out && (
          <p style={{ fontSize: '12px', color: '#791F1F' }}>Opted out of marketing</p>
        )}
        <p style={{ fontSize: '12px', color: '#8a8a84' }}>
          {c.source ? `Source: ${String(c.source).toLowerCase()}` : 'Source unknown'}
        </p>
        <ReferrerField
          lead={c}
          locationUuid={c.location_uuid}
          people={people}
          onApply={fields => setData(d => d ? { ...d, client: { ...d.client, ...fields } } : d)}
          onSaved={cols => onLeadPatched(c.id, cols)}
          onPartnerCreated={onPartnerCreated}
          setToast={setToast}
        />
        {/* Reverse direction — leads this client referred. */}
        {(data.referred_us || []).length > 0 && (
          <div style={{ marginTop: '2px' }}>
            <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '3px' }}>
              Referred us · {data.referred_us.length}
            </p>
            {data.referred_us.map(r => (
              <p key={r.id} style={{ fontSize: '12px', color: '#1a1a18' }}>{r.name}</p>
            ))}
          </div>
        )}
      </div>

      {/* Request details — pre-Jobber people whose request hasn't founded
          an engagement yet (the SAME field the Inbox edits and
          foundEngagement seeds from). No client-level job description
          exists — each engagement owns its own. */}
      {!jobberLinked && (
        <div>
          <MicroLabel>Request details</MicroLabel>
          <EditableDesc text={c.request_details} showEmpty onSave={saveReqDetails} />
        </div>
      )}

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
                  {(e.description || '').trim() && (
                    <p style={{ fontSize: '11px', color: '#8a8a84', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.description.trim().split('\n')[0]}
                    </p>
                  )}
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

      {/* Recent activity — client-wide quick-glance slice + composer;
          the exhaustive merged stream is the Timeline tab. */}
      <NotesStream label="Recent activity" items={stream} onPost={addNote} nowMs={nowMs} />

      {/* Actions — soft-tinted equal-width grid (cardKit ActionRow). */}
      <div>
        <ActionRow>
          {c.phone && (
            <a href={`tel:${c.phone}`} style={actionBtn('blue')}>
              <IconPhone size={14} /> Call
            </a>
          )}
          <button style={actionBtn('gray')} disabled={busy} onClick={() => setTouchOpen(v => !v)}>
            Log touchpoint
          </button>
          {jobberLinked ? (
            jobberHref ? (
              <a href={jobberHref} target="_blank" rel="noreferrer" style={actionBtn('gray')}>
                <IconExternalLink size={14} /> Open in Jobber
              </a>
            ) : (
              <span title="No Jobber record link available" style={{ ...actionBtn('gray'), color: '#c9c7c0', cursor: 'default' }}>
                <IconExternalLink size={14} /> Open in Jobber
              </span>
            )
          ) : (
            onSendToJobber && (
              <button style={actionBtn('green')} disabled={busy} onClick={() => onSendToJobber(c.id)}>
                <IconSend size={14} /> Send to Jobber
              </button>
            )
          )}
          <button style={actionBtn('gray')} disabled={busy} onClick={newEngagement}>
            <IconPlus size={14} /> New engagement
          </button>
        </ActionRow>
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
            <button style={{ ...quietBtn(), minHeight: 0 }} disabled={busy} onClick={logTouchpoint}>Log</button>
          </div>
        )}
      </div>
    </div>
  )

  const filesTab = (
    <div style={{ padding: '18px 12px', border: '0.5px dashed rgba(0,0,0,0.15)', borderRadius: '8px', textAlign: 'center' }}>
      <p style={{ fontSize: '12px', color: '#b5b3ac', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
        <IconPaperclip size={14} /> No files yet — quotes, photos, and attachments will land here
      </p>
    </div>
  )

  const body = c && (
    <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <style>{`.bee-contact-link:hover { text-decoration: underline !important; text-underline-offset: 2px }`}</style>

      {/* Header — compact: tinted avatar + name + chip + subtitle + ··· */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <InitialsAvatar name={c.name} bg={fam.bg} text={fam.text} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '16px', fontWeight: 500, color: '#1a1a18', display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            {statusMeta && <StatusChip label={statusMeta.label} styleKey={statusMeta.styleKey} />}
          </p>
          {/* 'client since' rides the full prose date (header has the
              room); closed-engagement rows below keep compact monthYear. */}
          <p style={{ fontSize: '12px', color: '#8a8a84', marginTop: '2px' }}>
            {fmtMoney(agg?.lifetime_paid || 0)} lifetime · client since {formatFullDate(c.created_at) || '—'}{c.location_name ? ` · ${c.location_name}` : ''}
          </p>
        </div>
        <CardMenu items={[{ key: 'junk', label: 'Mark as junk', danger: true, onPick: markJunk }]} />
      </div>

      {/* Vitals strip — client-health row; Status in its status color.
          Replaces the old Overview money tiles (owing → Key facts line). */}
      <VitalsStrip cells={[
        { label: 'Status', value: statusMeta?.label ?? null, color: fam.text },
        { label: 'Lifetime', value: (agg?.lifetime_paid || 0) > 0 ? fmtMoney(agg.lifetime_paid) : null },
        { label: 'Last touch', value: touches.length ? vitalsAge(touches.reduce((m, t) => Math.max(m, new Date(t.occurred_at).getTime() || 0), 0), nowMs) : null },
        { label: 'Open', value: (agg?.open_pipeline || 0) > 0 ? fmtMoney(agg.open_pipeline) : null },
      ]} />

      <CardTabs
        tabs={[{ key: 'overview', label: 'Overview' }, { key: 'timeline', label: 'Timeline' }, { key: 'files', label: 'Files' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && overview}
      {tab === 'timeline' && (
        <Timeline
          leadId={c.id}
          locationUuid={c.location_uuid}
          setToast={setToast}
          onLeadPatched={onLeadPatched}
        />
      )}
      {tab === 'files' && filesTab}
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

  return <OverlayShell isMobile={isMobile} onClose={onClose}>{loading}{errBlock}{body}</OverlayShell>
}
