// components/hive/NetworkPersonRecord.jsx
// ─────────────────────────────────────────────────────────────
// NETWORK — the person record (Phase 3). Retires the Classic
// PartnerPanel. Beta-chunk (§8.5): props only, tokens only, writes go up
// through the host's onUpdate (the makeUpdatePartner diff-PATCH path) or
// straight to the real routes where one exists.
//
// Deliberately CHERRY-PICKED from ClientProfile's left column — masthead,
// contact rows, badges, activity — and deliberately WITHOUT its spine:
// no MetricBand, no engagements, no Jobber links, no stage-derived
// status. A partner has a relationship, not a pipeline of money.
//
// THE FOUR FACTS the record answers (Kevin's core question):
//   stats     — leads sent · converted · revenue (REAL joins via
//               /api/partners/:id/referrals; '—' while loading, never a
//               fake zero) · last talked (partners.last_contacted_at)
//   touchpoints — TouchpointModal mounted VERBATIM (it does not write;
//               THIS caller owns the POST → /api/touchpoints with
//               partner_id, the one writer, which stamps
//               last_contacted_at) + the shared Timeline in partner mode
//   what's next — next_steps, checkable + addable (the same items the
//               Phase 2 strip surfaces)
//   referred  — the reverse list, each lead with status + value,
//               deep-linking to the client record
//
// BADGES derive from FACTS (deriveNetworkBadges), never a type field.
// CUSTOMER PATH: "Add as client" was a one-time state-only copy in
// Classic (fake id, no link). Here it is a real LINK: match an existing
// client first (shared clientMatch — no dupes), else POST /api/leads,
// then PATCH isCustomer + customerLeadId so the Client badge deep-links.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useState } from 'react'
import OverlayShell from './OverlayShell'
import TouchpointModal from './TouchpointModal'
import Timeline from './shared/Timeline'
import useIsMobile from './shared/useIsMobile'
import InitialsAvatar from './shared/InitialsAvatar'
import RecordMenu from './shared/RecordMenu'
import { T } from './shared/tokens'
import { matchPeople } from './shared/clientMatch'
import {
  deriveNetworkBadges, BadgeChip, StageRail, StatTile, SectionLabel,
  InlineText, fmtLastTalk,
} from './shared/networkKit'
import { contactRecency } from './shared/networkGroups'

const money = (n) => `$${Math.round(n).toLocaleString()}`
const REFERRED_SHOWN = 8

const statusChip = {
  client: { label: 'Client', fam: 'green' },
  active: { label: 'Active', fam: 'teal' },
  lost: { label: 'Lost', fam: 'quiet' },
  lead: { label: 'Lead', fam: 'blue' },
}

export default function NetworkPersonRecord({
  partner,
  companies = [],
  people = [],              // loaded leads — the client-match universe
  onClose = () => {},
  onUpdate = () => {},      // host updatePartner (diff PATCH + revert + toast)
  onDelete = () => {},
  onOpenCompany = () => {},
  setToast = () => {},
  readOnly = false,
}) {
  const isMobile = useIsMobile()
  const nowMs = Date.now()

  // ── referral rollup (REAL numbers; null = loading → '—') ──
  const [referrals, setReferrals] = useState(null)
  const [referralsErr, setReferralsErr] = useState(null)
  useEffect(() => {
    let dead = false
    setReferrals(null); setReferralsErr(null)
    fetch(`/api/partners/${partner.id}/referrals`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(json => { if (!dead) setReferrals(json) })
      .catch(e => { if (!dead) { setReferralsErr(String(e?.message || e)); setReferrals({ referred: [], totals: null }) } })
    return () => { dead = true }
  }, [partner.id])

  const totals = referrals?.totals ?? null
  const badges = useMemo(
    () => deriveNetworkBadges({ partner, referralCount: totals ? totals.count : null }),
    [partner, totals]
  )

  const company = partner.companyId ? companies.find(c => c.id === partner.companyId) : null
  const recency = contactRecency(partner.lastContactedAt, nowMs)
  const lastTalk = fmtLastTalk(partner.lastContactedAt, nowMs)

  const patch = (fields) => onUpdate({ ...partner, ...fields })

  // ── touchpoints ──
  const [logging, setLogging] = useState(false)
  const [timelineKey, setTimelineKey] = useState(0)
  async function submitTouchpoint({ method, status, notes }) {
    const res = await fetch('/api/touchpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partner_id: partner.id, kind: 'reach_out', method,
        label: 'Reach-out', status, notes,
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setToast({ kind: 'error', msg: `Couldn't log touchpoint: ${json?.error || res.status}` })
      throw new Error(json?.error || `HTTP ${res.status}`)
    }
    // The route's writer stamped last_contacted_at server-side; mirror it
    // into state. lastContactedAt is NOT a PATCHable field (the writer
    // owns it), so this onUpdate is a state-only reconcile — the diff is
    // empty and no network fires.
    const occurredAt = json?.touchpoint?.occurred_at || new Date().toISOString()
    patch({ lastContactedAt: occurredAt })
    setTimelineKey(k => k + 1)
    setLogging(false)
    setToast({ kind: 'success', msg: 'Touchpoint logged' })
  }

  // ── next steps ──
  const [newStep, setNewStep] = useState('')
  const [newStepDate, setNewStepDate] = useState('')
  const steps = partner.nextSteps || []
  const addStep = () => {
    if (!newStep.trim()) return
    patch({ nextSteps: [...steps, { id: `step${Date.now()}`, text: newStep.trim(), date: newStepDate || null, done: false, createdAt: new Date().toISOString() }] })
    setNewStep(''); setNewStepDate('')
  }
  const toggleStep = (id) => patch({ nextSteps: steps.map(s => s.id === id ? { ...s, done: !s.done } : s) })
  const removeStep = (id) => patch({ nextSteps: steps.filter(s => s.id !== id) })

  // ── notes (partner jsonb — legacy free-text ts entries render raw) ──
  const [noteDraft, setNoteDraft] = useState('')
  const addNote = () => {
    if (!noteDraft.trim()) return
    patch({ notes: [...(partner.notes || []), { id: `n${Date.now()}`, text: noteDraft.trim(), ts: new Date().toISOString(), user: 'You' }] })
    setNoteDraft('')
  }
  const fmtNoteTs = (ts) => {
    const t = new Date(ts).getTime()
    return Number.isFinite(t) && String(ts).includes('-') ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : String(ts || '')
  }

  // ── customer path: match-first, then create; always end LINKED ──
  const [linkingClient, setLinkingClient] = useState(false)
  async function addAsClient() {
    if (linkingClient) return
    setLinkingClient(true)
    try {
      // 1) An existing client with this email/phone IS this person —
      // link, don't duplicate (the intake doors dedupe the same way).
      const hit = matchPeople(people, partner.email || partner.phone || partner.name)[0]
      if (hit) {
        patch({ isCustomer: true, customerLeadId: hit.person.id })
        setToast({ kind: 'success', msg: `Linked to existing client ${hit.person.name}` })
        return
      }
      // 2) No match → mint the real lead, then store the REAL id (the
      // Classic path minted a fake local id and linked nothing).
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: partner.name, phone: partner.phone || null, email: partner.email || null,
          location_id: partner.locationId, source: 'Referral',
          request_details: `From the Network — ${[partner.title, partner.company].filter(Boolean).join(' at ')}`,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.lead?.id) throw new Error(json?.error || `HTTP ${res.status}`)
      patch({ isCustomer: true, customerLeadId: json.lead.id })
      setToast({ kind: 'success', msg: `${partner.name} added as a client` })
    } catch (e) {
      setToast({ kind: 'error', msg: `Couldn't add as client: ${String(e?.message || e)}` })
    } finally {
      setLinkingClient(false)
    }
  }

  // ── delete (two-tap confirm) ──
  const [confirmDelete, setConfirmDelete] = useState(false)

  const addresses = partner.addresses || []
  const firstAddress = addresses[0]?.value || ''

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={840}>
      <div style={{ padding: '0 20px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* ── masthead ── */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          <InitialsAvatar name={partner.name} bg={T.family.teal.bg} text={T.family.teal.text} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: '19px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{partner.name}</h2>
              {badges.map(b => <BadgeChip key={b.key} badge={b} />)}
            </div>
            <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '2px', display: 'flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap' }}>
              {partner.title && <span>{partner.title}</span>}
              {company
                ? <button type="button" onClick={() => onOpenCompany(company)}
                    style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontSize: '12px', color: T.accent.deep, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
                    {company.name}
                  </button>
                : partner.company ? <span>{partner.company}</span> : null}
              {partner.howWeMet && <span style={{ color: T.ink.quiet }}>· met via {partner.howWeMet}{partner.metDate ? ` (${partner.metDate})` : ''}</span>}
            </p>
          </div>
          {!readOnly && (
            <RecordMenu ariaLabel="Partner actions" items={[
              ...(!partner.isCustomer ? [{ key: 'add-client', label: linkingClient ? 'Linking…' : 'Add as client', onClick: addAsClient }] : []),
              { key: 'remove', label: 'Remove from network', danger: true, onClick: () => setConfirmDelete(true) },
            ]} />
          )}
        </div>

        {confirmDelete && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: T.state.danger.soft, borderRadius: T.radius.control, padding: '10px 12px' }}>
            <span style={{ fontSize: '12px', color: T.state.danger.fg, flex: 1 }}>Remove {partner.name} from your network? (Recoverable from the recycle bin.)</span>
            <button onClick={() => { onDelete(partner.id); onClose() }} style={{ border: 'none', background: T.state.danger.strong, color: T.ink.inverse, borderRadius: T.radius.control, padding: '6px 12px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>Remove</button>
            <button onClick={() => setConfirmDelete(false)} style={{ border: 'none', background: 'transparent', color: T.ink.muted, fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          </div>
        )}

        {/* ── relationship stage rail (partner vocabulary ONLY) ── */}
        <StageRail stage={partner.stage} readOnly={readOnly} onChange={(s) => patch({ stage: s })} />

        {/* ── stats — real joins, '—' while loading ── */}
        <div data-testid="person-stats" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <StatTile label="Leads sent" value={totals ? totals.count : '—'} />
          <StatTile label="Converted" value={totals ? totals.converted : '—'} />
          <StatTile label="Revenue" value={totals ? money(totals.revenue) : '—'} />
          <StatTile label="Last talked" value={lastTalk || '—'} danger={recency === 'stale'} />
        </div>
        {referralsErr && <p style={{ fontSize: '11px', color: T.state.danger.fg }}>Referral numbers unavailable ({referralsErr}).</p>}

        {/* ── contact ── */}
        <div>
          <SectionLabel>Contact</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <InlineText label="Phone" value={partner.phone} href={partner.phone ? `tel:${partner.phone}` : null} placeholder="add phone" readOnly={readOnly} onSave={v => patch({ phone: v })} />
            <InlineText label="Email" value={partner.email} href={partner.email ? `mailto:${partner.email}` : null} placeholder="add email" readOnly={readOnly} onSave={v => patch({ email: v })} />
            <InlineText label="Website" value={partner.website} placeholder="add website" readOnly={readOnly} onSave={v => patch({ website: v })} />
            <InlineText label="Address" value={firstAddress} placeholder="add address" readOnly={readOnly}
              onSave={v => patch({ addresses: v ? [{ type: addresses[0]?.type || 'Office', value: v }, ...addresses.slice(1)] : addresses.slice(1) })} />
            <InlineText label="Role" value={partner.title} placeholder="add role" readOnly={readOnly} onSave={v => patch({ title: v })} />
            <InlineText label="How met" value={partner.howWeMet} placeholder="add how you met" readOnly={readOnly} onSave={v => patch({ howWeMet: v })} />
          </div>
        </div>

        {/* ── what's next (the Phase 2 strip's items, at their home) ── */}
        <div data-testid="next-steps">
          <SectionLabel>What’s next</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {steps.filter(s => !s.done).map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button aria-label={`Mark done: ${s.text}`} disabled={readOnly} onClick={() => toggleStep(s.id)}
                  style={{ width: '16px', height: '16px', borderRadius: '4px', border: T.border.control, background: T.surface.raised, cursor: readOnly ? 'default' : 'pointer', flexShrink: 0, padding: 0 }} />
                <span style={{ fontSize: '12px', color: T.ink.primary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.text}</span>
                {s.date && <span style={{ fontSize: '11px', color: new Date(`${s.date}T00:00:00`).getTime() < nowMs - 86400000 ? T.state.danger.fg : T.ink.quiet, fontVariantNumeric: T.type.tabular }}>{s.date.slice(5).replace('-', '/')}</span>}
                {!readOnly && <button aria-label={`Delete step: ${s.text}`} onClick={() => removeStep(s.id)} style={{ border: 'none', background: 'transparent', color: T.ink.quiet, cursor: 'pointer', fontSize: '13px', lineHeight: 1, padding: '2px' }}>×</button>}
              </div>
            ))}
            {steps.filter(s => !s.done).length === 0 && (
              <p style={{ fontSize: '12px', color: T.ink.quiet }}>Nothing scheduled</p>
            )}
            {!readOnly && (
              <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                <input value={newStep} onChange={e => setNewStep(e.target.value)} placeholder="Add a next step…"
                  onKeyDown={e => { if (e.key === 'Enter') addStep() }}
                  aria-label="New next step"
                  style={{ flex: 1, padding: '6px 10px', border: T.border.control, borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none', minWidth: 0 }} />
                <input type="date" value={newStepDate} onChange={e => setNewStepDate(e.target.value)} aria-label="Due date"
                  style={{ padding: '6px 8px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none' }} />
                <button onClick={addStep} disabled={!newStep.trim()}
                  style={{ border: 'none', borderRadius: T.radius.control, background: newStep.trim() ? T.accent.fg : T.surface.sunken, color: newStep.trim() ? T.accent.onFill : T.ink.disabled, fontSize: '12px', fontWeight: 500, padding: '6px 12px', cursor: newStep.trim() ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>Add</button>
              </div>
            )}
          </div>
        </div>

        {/* ── touchpoints (real rows since Phase 1) ── */}
        <div data-testid="touchpoints">
          <SectionLabel action={!readOnly && (
            <button onClick={() => setLogging(true)}
              style={{ border: 'none', borderRadius: T.radius.control, background: T.accent.fg, color: T.accent.onFill, fontSize: '12px', fontWeight: 500, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>
              + Log touchpoint
            </button>
          )}>Touchpoints</SectionLabel>
          <Timeline partnerId={partner.id} refreshKey={timelineKey} setToast={setToast} readOnly={readOnly} />
        </div>

        {/* ── leads referred (the reverse link, real values) ── */}
        <div data-testid="leads-referred">
          <SectionLabel>Leads referred{totals ? ` · ${totals.count}` : ''}</SectionLabel>
          {referrals == null && <p style={{ fontSize: '12px', color: T.ink.quiet }}>Loading…</p>}
          {referrals != null && (referrals.referred || []).length === 0 && (
            <p style={{ fontSize: '12px', color: T.ink.quiet }}>No referred leads yet — log one by setting “Referred by” on a new client.</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {(referrals?.referred || []).slice(0, REFERRED_SHOWN).map(r => {
              const chip = statusChip[r.status] || statusChip.lead
              const fam = T.family[chip.fam] || T.family.gray
              return (
                <a key={r.id} href={`/clients/${r.id}`}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none', padding: '6px 8px', borderRadius: T.radius.control, background: T.surface.sunken }}>
                  <span style={{ fontSize: '12px', fontWeight: 500, color: T.ink.primary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ fontSize: T.badge.font, fontWeight: 500, color: fam.text, background: fam.bg, borderRadius: T.radius.chip, padding: '1px 7px' }}>{chip.label}</span>
                  {r.revenue > 0 && <span style={{ fontSize: '12px', color: T.ink.primary, fontVariantNumeric: T.type.tabular }}>{money(r.revenue)}</span>}
                </a>
              )
            })}
            {(referrals?.referred || []).length > REFERRED_SHOWN && (
              <p style={{ fontSize: '11px', color: T.ink.quiet }}>+ {referrals.referred.length - REFERRED_SHOWN} more</p>
            )}
          </div>
        </div>

        {/* ── notes ── */}
        <div>
          <SectionLabel>Notes</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {(partner.notes || []).slice().reverse().map(n => (
              <div key={n.id} style={{ background: T.surface.sunken, borderRadius: T.radius.control, padding: '8px 10px' }}>
                <p style={{ fontSize: '12px', color: T.ink.primary, lineHeight: 1.5 }}>{n.text}</p>
                <p style={{ fontSize: '10px', color: T.ink.quiet, marginTop: '2px' }}>{fmtNoteTs(n.ts)}{n.user ? ` · ${n.user}` : ''}</p>
              </div>
            ))}
            {!readOnly && (
              <div style={{ display: 'flex', gap: '6px' }}>
                <input value={noteDraft} onChange={e => setNoteDraft(e.target.value)} placeholder="Add a note…"
                  onKeyDown={e => { if (e.key === 'Enter') addNote() }}
                  aria-label="New note"
                  style={{ flex: 1, padding: '6px 10px', border: T.border.control, borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none', minWidth: 0 }} />
                <button onClick={addNote} disabled={!noteDraft.trim()}
                  style={{ border: 'none', borderRadius: T.radius.control, background: noteDraft.trim() ? T.accent.fg : T.surface.sunken, color: noteDraft.trim() ? T.accent.onFill : T.ink.disabled, fontSize: '12px', fontWeight: 500, padding: '6px 12px', cursor: noteDraft.trim() ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>Add</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {logging && (
        <TouchpointModal
          personName={partner.name}
          onClose={() => setLogging(false)}
          onSubmit={submitTouchpoint}
        />
      )}
    </OverlayShell>
  )
}
