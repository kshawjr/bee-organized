// components/hive/PersonCard.jsx
// ─────────────────────────────────────────────────────────────
// The PRE-ENGAGEMENT record card — what an Inbox row opens. Mirrors the
// EngagementPanel's anatomy exactly, minus what doesn't exist yet, built
// from the SAME shared sections (OverlayShell, ClientStrip + BuzzDrawer,
// EditableDesc, NotesStream):
//   header (name + client-status chip, 'Prospect · inquired…' subtitle)
//   → client strip (contact + buzz drawer)
//   → RECORDS (editable description standalone — the panel's
//     no-request-row variant — + a dashed 'Request · created when sent
//     to Jobber' promise slot)
//   → NOTES · this person (client-level kind='job' notes + touchpoints)
//   → actions (Log touchpoint + Send to Jobber).
// The description saves to leads.request_details and seeds
// engagements.description at founding (proven chain); notes/touchpoints
// stay on the client — engagement notes start fresh on the engagement.
// Fetches GET /api/clients/:id/profile. Beta chunk only.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import ClientStrip from './ClientStrip'
import NotesStream from './NotesStream'
import EditableDesc from './EditableDesc'
import MetaSelect from './MetaSelect'
import ReferrerField from './shared/ReferrerField'
import Timeline from './shared/Timeline'
import StatusChip from '@/components/ui/StatusChip'
import { deriveClientStatus, CLIENT_STATUS_META } from './shared/clientStatus'
import { fmtMoney } from './shared/engagementStatus'
import { IconInbox, IconPhone, IconSend } from '@/components/ui/icons'

const SEND_GREEN = '#0F6E56'
const fmtDate = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function MicroLabel({ children }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '8px' }}>
      {children}
    </p>
  )
}

const outlineBtn = {
  flex: 1, minWidth: '150px',
  padding: '9px 12px', borderRadius: '8px', border: '0.5px solid rgba(0,0,0,0.15)',
  background: '#fff', fontSize: '13px', fontWeight: 500, color: '#1a1a18',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', textAlign: 'center',
}

export default function PersonCard({ person, people = [], onClose, onSendToJobber = null, setToast = () => {}, onLeadPatched = () => {}, onPartnerCreated = () => {}, lookupOptions = { sources: [], projectTypes: [] } }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [buzzOpen, setBuzzOpen] = useState(false)
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchMethod, setTouchMethod] = useState('call')
  const [touchNote, setTouchNote] = useState('')
  const [busy, setBusy] = useState(false)
  const nowMs = Date.now()

  const isMobile = useIsMobile()

  useEffect(() => {
    let dead = false
    setData(null); setLoadErr(null)
    fetch(`/api/clients/${person.id}/profile`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(d => { if (!dead) setData(d) })
      .catch(e => { if (!dead) setLoadErr(String(e.message || e)) })
    return () => { dead = true }
  }, [person.id])

  const c = data?.client
  const agg = data?.aggregates
  const buzz = data?.buzz_notes ?? []
  const jobNotes = data?.job_notes ?? []
  const touches = data?.touchpoints ?? []

  // Same derivation the Inbox row used → same chip.
  const status = deriveClientStatus(person, new Set(), nowMs)
  const statusMeta = CLIENT_STATUS_META[status] || null

  const canSend = !person.jobberRef && !c?.jobber_client_id

  async function addBuzz(text) {
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: person.id, kind: 'buzz', text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, buzz_notes: [j.note, ...(d.buzz_notes || [])] } : d)
    } catch (e) { setToast({ kind: 'error', msg: `Buzz failed: ${e.message}` }) }
  }

  // Client-level note: kind='job', NO engagement_id — stays with the
  // person; engagement notes start fresh on the engagement at founding.
  async function addNote(text) {
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: person.id, kind: 'job', text }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, job_notes: [j.note, ...(d.job_notes || [])] } : d)
    } catch (e) { setToast({ kind: 'error', msg: `Note failed: ${e.message}` }) }
  }

  // Source + project type both live on the LEAD pre-founding; project
  // type seeds engagements.project_type at request-founding (same chain
  // as description). label may be null — None clears the field.
  async function saveLeadField(field, label) {
    const prev = c?.[field] ?? null
    setData(d => d ? { ...d, client: { ...d.client, [field]: label } } : d)
    try {
      const res = await fetch(`/api/leads/${person.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: label }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      // Propagate to the shell's people state so the Inbox row / filters
      // reflect the change without a reload.
      onLeadPatched(person.id, { [field]: label })
    } catch (e) {
      setData(d => d ? { ...d, client: { ...d.client, [field]: prev } } : d)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    }
  }

  async function saveDesc(text) {
    const prev = c?.request_details ?? null
    setData(d => d ? { ...d, client: { ...d.client, request_details: text || null } } : d)
    try {
      const res = await fetch(`/api/leads/${person.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_details: text || null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      setToast({ kind: 'success', msg: 'Description saved' })
    } catch (e) {
      setData(d => d ? { ...d, client: { ...d.client, request_details: prev } } : d)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    }
  }

  async function logTouchpoint() {
    setBusy(true)
    try {
      const res = await fetch('/api/touchpoints', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: person.id, kind: 'reach_out', label: 'Reach-out', method: touchMethod, notes: touchNote.trim() || null }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setTouchNote(''); setTouchOpen(false)
      if (j.touchpoint) {
        setData(d => d ? { ...d, touchpoints: [{ ...j.touchpoint, user_label: 'You' }, ...(d.touchpoints || [])] } : d)
      }
      setToast({ kind: 'success', msg: 'Touchpoint logged' })
    } catch (e) { setToast({ kind: 'error', msg: `Touchpoint failed: ${e.message}` }) }
    finally { setBusy(false) }
  }

  const stream = [
    ...jobNotes.map(n => ({ t: 'note', ts: n.created_at, ...n })),
    ...touches.map(tp => ({ t: 'touch', ts: tp.occurred_at, ...tp })),
  ]

  // Once the profile row is loaded it is authoritative INCLUDING null —
  // the old `c?.source ?? person.source` fallback resurrected the stale
  // prop whenever the loaded (or None-cleared) value was null.
  const effSource = data ? (c?.source ?? null) : (person.source ?? null)

  const metaLine = (agg?.total_count ?? 0) > 0
    ? `${agg.total_count} prior engagement${agg.total_count === 1 ? '' : 's'} · ${fmtMoney(agg.lifetime_paid || 0)} lifetime`
    : 'No engagements yet'

  const body = (
    <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {loadErr && (
        <p style={{ fontSize: '12px', color: '#791F1F', background: '#FCEBEB', padding: '8px 12px', borderRadius: '8px' }}>
          Couldn’t load person: {loadErr}
        </p>
      )}

      {/* Header — same idiom as the panel's title + stage chip */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <h2 style={{ flex: 1, minWidth: 0, fontSize: '16px', fontWeight: 500, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {person.name}
          </h2>
          {statusMeta && (
            <span style={{ flexShrink: 0 }}>
              <StatusChip label={statusMeta.label} styleKey={statusMeta.styleKey} />
            </span>
          )}
        </div>
        <p style={{ fontSize: '12px', color: '#8a8a84', marginTop: '4px' }}>
          Prospect · inquired {fmtDate(person.created) || '—'} · via {(effSource || 'unknown').toLowerCase()}
        </p>
        {/* Meta row — same spot as the panel's; both fields live on the
            lead pre-founding (type seeds the engagement at founding). */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
          <MetaSelect label="Source" value={effSource} options={lookupOptions.sources} onPick={(v) => saveLeadField('source', v)} />
          <MetaSelect label="Type" value={c?.project_type || null} options={lookupOptions.projectTypes} onPick={(v) => saveLeadField('project_type', v)} />
        </div>
        {/* Referrer — the shared field (lead-level, same as the profile). */}
        {c && (
          <div style={{ marginTop: '8px' }}>
            <ReferrerField
              lead={c}
              locationUuid={c.location_uuid}
              people={people}
              onApply={fields => setData(d => d ? { ...d, client: { ...d.client, ...fields } } : d)}
              onSaved={cols => onLeadPatched(person.id, cols)}
              onPartnerCreated={onPartnerCreated}
              setToast={setToast}
            />
          </div>
        )}
      </div>

      {/* Client strip — the SAME shared component as the panel's */}
      <ClientStrip
        name={person.name}
        meta={metaLine}
        phone={person.phone}
        email={person.email}
        buzz={buzz}
        buzzOpen={buzzOpen}
        onToggleBuzz={() => setBuzzOpen(v => !v)}
        onPostBuzz={addBuzz}
        isMobile={isMobile}
      />

      {/* Records — description standalone (the panel's no-request-row
          variant) + the dashed slot founding will fill */}
      <div>
        <MicroLabel>Records</MicroLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {data && <EditableDesc text={c?.request_details} showEmpty onSave={saveDesc} placeholder="Describe the request…" />}
          <div style={{ padding: '10px 12px', border: '0.5px dashed rgba(0,0,0,0.18)', borderRadius: '8px', fontSize: '11px', color: '#b5b3ac' }}>
            <IconInbox size={13} style={{ marginRight: '6px', verticalAlign: '-2px' }} /> Request — created when sent to Jobber
          </div>
          {!data && !loadErr && (
            <div style={{ padding: '14px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>Loading…</div>
          )}
        </div>
      </div>

      {/* Notes — the SAME shared stream as the panel's */}
      <NotesStream label="Notes · this person" items={stream} onPost={addNote} nowMs={nowMs} />

      {/* Timeline — the shared unified stream (upcoming + history). */}
      {c && (
        <div>
          <MicroLabel>Timeline</MicroLabel>
          <Timeline
            leadId={person.id}
            locationUuid={c.location_uuid}
            setToast={setToast}
            onLeadPatched={onLeadPatched}
          />
        </div>
      )}

      {/* Actions — same button idiom as the panel's */}
      <div>
        <MicroLabel>Actions</MicroLabel>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button style={outlineBtn} disabled={busy} onClick={() => setTouchOpen(v => !v)}>
            <IconPhone size={14} style={{ marginRight: '5px' }} /> Log touchpoint
          </button>
          {canSend && onSendToJobber && (
            <button style={{ ...outlineBtn, background: SEND_GREEN, color: '#fff', border: 'none' }} disabled={busy}
              onClick={() => onSendToJobber(person)}>
              <IconSend size={14} style={{ marginRight: '5px' }} /> Send to Jobber
            </button>
          )}
        </div>
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

  return <OverlayShell isMobile={isMobile} onClose={onClose}>{body}</OverlayShell>
}
