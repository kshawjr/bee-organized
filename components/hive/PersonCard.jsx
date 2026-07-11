// components/hive/PersonCard.jsx
// ─────────────────────────────────────────────────────────────
// The PRE-ENGAGEMENT record card — what an Inbox row opens. Tabbed
// layout (approved): compact header (status-tinted avatar + name +
// chip + subtitle + ··· menu) → VITALS STRIP (Status / Inquired / Last
// touch / Next — visible on every tab; Next = soonest future item among
// snooze + any open engagement's assessments/jobs, usually '—'
// pre-engagement) → tabs → content.
//
// Tabs: Overview (default) / Timeline. NO Files tab — nothing to file
// pre-founding. Tab switching is a post-streaming JS stepper: only the
// active tab's content renders (never display:none).
//
// Overview (lean, pre-engagement): pinned buzz (lead-level — carries
// forward at founding) → key facts (tappable phone/email, Source/Type
// MetaSelects, shared ReferrerField) → 'What they want'
// (leads.request_details, EditableDesc — seeds engagements.description
// at founding, proven chain) → recent activity (SHORT slice of
// CLIENT-level kind='job' notes + touchpoints — real-dated only; the
// full merged stream w/ drip projections lives in the Timeline tab) +
// composer → quiet actions (Call / Log / Send to Jobber).
// NO money, NO engagements list, NO stage bar — none exist yet.
//
// Fetches GET /api/clients/:id/profile. Beta chunk only.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import NotesStream from './NotesStream'
import EditableDesc from './EditableDesc'
import MetaSelect from './MetaSelect'
import ReferrerField from './shared/ReferrerField'
import Timeline from './shared/Timeline'
import CardTabs from './shared/CardTabs'
import PinnedBuzz from './shared/PinnedBuzz'
import InitialsAvatar from './shared/InitialsAvatar'
import { MicroLabel, quietBtn, CardMenu, undoToast, ActionRow, actionBtn } from './shared/cardKit'
import VitalsStrip, { vitalsAge, vitalsFuture, nextFromChildren } from './shared/VitalsStrip'
import { formatFullDate } from './shared/engagementStatus'
import StatusChip from '@/components/ui/StatusChip'
import { deriveClientStatus, CLIENT_STATUS_META } from './shared/clientStatus'
import { CHIP_STYLES, ACCENT_BLUE } from './shared/stageConfig'
import { IconPhone, IconMail, IconSend } from '@/components/ui/icons'


export default function PersonCard({ person, people = [], onClose, onSendToJobber = null, setToast = () => {}, onLeadPatched = () => {}, onPartnerCreated = () => {}, lookupOptions = { sources: [], projectTypes: [] } }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [tab, setTab] = useState('overview')
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
  const buzz = data?.buzz_notes ?? []
  // The profile route returns ALL kind='job' notes; this card's slice is
  // CLIENT-level only (engagement notes live with their engagement).
  const jobNotes = (data?.job_notes ?? []).filter(n => !n.engagement_id)
  const touches = data?.touchpoints ?? []

  // Same derivation the Inbox row used → same chip + avatar tint.
  const status = deriveClientStatus(person, new Set(), nowMs)
  const statusMeta = CLIENT_STATUS_META[status] || null
  const fam = statusMeta ? (CHIP_STYLES[statusMeta.styleKey] || CHIP_STYLES.gray) : CHIP_STYLES.gray

  const canSend = !person.jobberRef && !c?.jobber_client_id

  async function patchLead(patch) {
    const res = await fetch(`/api/leads/${person.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
  }

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
  // person; engagement notes start fresh on the engagement.
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
      await patchLead({ [field]: label })
      // Propagate to the shell's people state so the Inbox row / filters
      // reflect the change without a reload.
      onLeadPatched(person.id, { [field]: label })
    } catch (e) {
      setData(d => d ? { ...d, client: { ...d.client, [field]: prev } } : d)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    }
  }

  // Boolean return feeds EditableDesc's inline-edit standard: false
  // keeps the textarea open with the draft after the optimistic revert.
  async function saveDesc(text) {
    const prev = c?.request_details ?? null
    setData(d => d ? { ...d, client: { ...d.client, request_details: text || null } } : d)
    try {
      await patchLead({ request_details: text || null })
      setToast({ kind: 'success', msg: 'Description saved' })
      return true
    } catch (e) {
      setData(d => d ? { ...d, client: { ...d.client, request_details: prev } } : d)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
      return false
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

  // ··· menu — destructive/secondary lives here, not inline. Junk is
  // the existing soft-delete write path (server-side it also stops
  // drips + cancels stage emails); undo via the toast.
  async function markJunk() {
    try {
      await patchLead({ is_junk: true })
      onLeadPatched(person.id, { is_junk: true })
      setToast(undoToast('Marked as junk', async () => {
        try {
          await patchLead({ is_junk: false })
          onLeadPatched(person.id, { is_junk: false })
          setToast({ kind: 'success', msg: `${person.name} restored` })
        } catch (e) { setToast({ kind: 'error', msg: `Undo failed: ${e.message}` }) }
      }))
    } catch (e) { setToast({ kind: 'error', msg: `Junk failed: ${e.message}` }) }
  }

  // SHORT recent slice — real-dated notes + touchpoints only (drip
  // projections stay in the Timeline tab, not the at-a-glance view).
  const stream = [
    ...jobNotes.map(n => ({ t: 'note', ts: n.created_at, ...n })),
    ...touches.map(tp => ({ t: 'touch', ts: tp.occurred_at, ...tp })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 8)

  // Vitals-strip inputs — everything already on hand, no new queries.
  // Last touch: most recent touchpoint from the profile fetch. Next:
  // soonest future item among the lead's snooze (Inbox prop) and any
  // open engagement's future assessments/job starts from the profile
  // payload — pre-engagement that's usually nothing → '—'.
  const lastTouchTs = touches
    .reduce((m, t) => Math.max(m, new Date(t.occurred_at).getTime() || 0), 0) || null
  const nextTs = (() => {
    const cands = []
    const snooze = person.snoozeUntil ? new Date(person.snoozeUntil).getTime() : NaN
    if (Number.isFinite(snooze) && snooze > nowMs) cands.push(snooze)
    for (const e of data?.engagements || []) {
      const t = nextFromChildren(e, nowMs)
      if (t) cands.push(t)
    }
    return cands.length ? Math.min(...cands) : null
  })()

  // Once the profile row is loaded it is authoritative INCLUDING null —
  // the old `c?.source ?? person.source` fallback resurrected the stale
  // prop whenever the loaded (or None-cleared) value was null.
  const effSource = data ? (c?.source ?? null) : (person.source ?? null)

  const contactRow = (Icon, value, href) => value ? (
    <p style={{ fontSize: '12px', color: '#1a1a18', display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
      <span style={{ color: '#8a8a84', display: 'inline-flex' }}><Icon size={13} /></span>
      {href ? (
        <a href={href} style={{ color: ACCENT_BLUE, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</a>
      ) : (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      )}
    </p>
  ) : null

  const overview = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* Pinned buzz — lead-level; carries forward at founding. */}
      <PinnedBuzz notes={buzz} onPost={addBuzz} emptyLabel="Add a note about this client" nowMs={nowMs} />

      {/* Key facts */}
      <div style={{ background: '#f7f6f4', borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <MicroLabel>Key facts</MicroLabel>
        {contactRow(IconPhone, person.phone, person.phone ? `tel:${person.phone}` : null)}
        {contactRow(IconMail, person.email, person.email ? `mailto:${person.email}` : null)}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <MetaSelect label="Source" value={effSource} options={lookupOptions.sources} onPick={(v) => saveLeadField('source', v)} />
          <MetaSelect label="Type" value={c?.project_type || null} options={lookupOptions.projectTypes} onPick={(v) => saveLeadField('project_type', v)} />
        </div>
        {/* Referrer — the shared field (lead-level, same as the profile). */}
        {c && (
          <ReferrerField
            lead={c}
            locationUuid={c.location_uuid}
            people={people}
            onApply={fields => setData(d => d ? { ...d, client: { ...d.client, ...fields } } : d)}
            onSaved={cols => onLeadPatched(person.id, cols)}
            onPartnerCreated={onPartnerCreated}
            setToast={setToast}
          />
        )}
      </div>

      {/* What they want — request_details, seeds the engagement at founding */}
      <div>
        <MicroLabel>What they want</MicroLabel>
        {data
          ? <EditableDesc text={c?.request_details} showEmpty onSave={saveDesc} placeholder="Describe the request…" />
          : !loadErr && <div style={{ padding: '14px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>Loading…</div>}
      </div>

      {/* Recent activity — quick-glance slice + composer; the exhaustive
          merged stream (incl. future) is the Timeline tab. */}
      <NotesStream label="Recent activity" items={stream} onPost={addNote} nowMs={nowMs} />

      {/* Actions — soft-tinted equal-width grid (cardKit ActionRow);
          Send (the founding door) carries the green forward tone. */}
      <div>
        <ActionRow>
          {person.phone && (
            <a href={`tel:${person.phone}`} style={actionBtn('blue')}>
              <IconPhone size={14} /> Call
            </a>
          )}
          <button style={actionBtn('gray')} disabled={busy} onClick={() => setTouchOpen(v => !v)}>
            Log touchpoint
          </button>
          {canSend && onSendToJobber && (
            <button style={actionBtn('green')} disabled={busy} onClick={() => onSendToJobber(person)}>
              <IconSend size={14} /> Send to Jobber
            </button>
          )}
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

  const body = (
    <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {loadErr && (
        <p style={{ fontSize: '12px', color: '#791F1F', background: '#FCEBEB', padding: '8px 12px', borderRadius: '8px' }}>
          Couldn’t load person: {loadErr}
        </p>
      )}

      {/* Header — compact: tinted avatar + name + chip + subtitle + ··· */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <InitialsAvatar name={person.name} bg={fam.bg} text={fam.text} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h2 style={{ minWidth: 0, fontSize: '16px', fontWeight: 500, color: '#1a1a18', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {person.name}
            </h2>
            {statusMeta && (
              <span style={{ flexShrink: 0 }}>
                <StatusChip label={statusMeta.label} styleKey={statusMeta.styleKey} />
              </span>
            )}
          </div>
          <p style={{ fontSize: '12px', color: '#8a8a84', marginTop: '2px' }}>
            Prospect · inquired {formatFullDate(person.created) || '—'} · via {(effSource || 'unknown').toLowerCase()}
          </p>
        </div>
        <CardMenu items={[{ key: 'junk', label: 'Mark as junk', danger: true, onPick: markJunk }]} />
      </div>

      {/* Vitals strip — lead-health row; Status in its status color,
          Next in the accent. */}
      <VitalsStrip cells={[
        { label: 'Status', value: statusMeta?.label ?? null, color: fam.text },
        { label: 'Inquired', value: person.created ? vitalsAge(person.created, nowMs) : null },
        { label: 'Last touch', value: lastTouchTs ? vitalsAge(lastTouchTs, nowMs) : null },
        { label: 'Next', value: nextTs ? vitalsFuture(nextTs, nowMs) : null, color: ACCENT_BLUE },
      ]} />

      {/* Tabs — Overview default; NO Files pre-founding. */}
      <CardTabs
        tabs={[{ key: 'overview', label: 'Overview' }, { key: 'timeline', label: 'Timeline' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && overview}
      {tab === 'timeline' && (
        <Timeline
          leadId={person.id}
          locationUuid={c?.location_uuid}
          setToast={setToast}
          onLeadPatched={onLeadPatched}
        />
      )}
    </div>
  )

  return <OverlayShell isMobile={isMobile} onClose={onClose}>{body}</OverlayShell>
}
