// components/hive/shared/ReferrerField.jsx
// ─────────────────────────────────────────────────────────────
// The referrer add/edit/clear field — extracted from ClientProfile
// (a574f70) so PersonCard and EngagementPanel get the SAME affordance
// without a copy. One editable "Referred by <name>" line (dashed-
// underline tap → ReferrerPicker) + × clear + "＋ Add referrer" when
// unset. All three lead-detail surfaces render THIS.
//
// The referrer lives on the LEAD — even on EngagementPanel (work-world)
// the PATCH targets /api/leads/[lead.id], never an engagement field.
//
// Write contract (a574f70, unchanged):
//   SET   → PATCH { referred_by_kind, referred_by_id, source:'Referral' }
//           — the source coupling: a retroactively-referred lead
//           shouldn't keep saying Webform/Jobber. One-shot only: the
//           coupling fires on SET events, so the user can clear source
//           back to None afterward and nothing re-locks it.
//   CLEAR → PATCH { referred_by_kind:null, referred_by_id:null }
//           — ASYMMETRIC on purpose: source is NOT reverted (the lead
//           may still be referral-sourced; guessing a replacement
//           source would be wrong more often than right).
//
// State flow: the surface owns the displayed client fields; this
// component drives them through onApply(fields) — optimistic before the
// PATCH, back to prev on failure — and fires onSaved(colPatch) once the
// PATCH lands so the surface can propagate to the shell's people state.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useMemo, useState } from 'react'
import ReferrerPicker from '../ReferrerPicker'

export default function ReferrerField({
  lead,               // { id, referred_by_kind, referred_by_id, referred_by_name, source }
  locationUuid,       // the lead's location — scopes clients + the partners fetch
  people = [],        // the shell's (unscoped) people list
  onApply = () => {}, // (fields) => merge into the surface's client state
  onSaved = () => {}, // (colPatch) => propagation after a confirmed PATCH
  onPartnerCreated = () => {}, // confirmed inline-created partner row → Classic seam
  setToast = () => {},
}) {
  const [picking, setPicking] = useState(false)

  // Clients universe — same location, self excluded (no self-referral).
  // Junk exclusion happens inside ReferrerPicker.
  const scopedPeople = useMemo(
    () => (people || []).filter(p => p.id !== lead?.id && p.locationId === locationUuid),
    [people, lead?.id, locationUuid],
  )

  async function patchLead(body) {
    const res = await fetch(`/api/leads/${lead.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
  }

  const prevFields = () => ({
    referred_by_kind: lead.referred_by_kind ?? null,
    referred_by_id: lead.referred_by_id ?? null,
    referred_by_name: lead.referred_by_name ?? null,
    source: lead.source ?? null,
  })

  async function save(r) {
    const prev = prevFields()
    const body = { referred_by_kind: r.kind, referred_by_id: r.id, source: 'Referral' }
    onApply({ ...body, referred_by_name: r.name })
    setPicking(false)
    try {
      await patchLead(body)
      onSaved(body)
      setToast({ kind: 'success', msg: `Referrer saved — ${r.name}` })
    } catch (e) {
      onApply(prev)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    }
  }

  async function clear() {
    const prev = prevFields()
    const body = { referred_by_kind: null, referred_by_id: null }
    onApply({ ...body, referred_by_name: null }) // source untouched — see header
    setPicking(false)
    try {
      await patchLead(body)
      onSaved(body)
      setToast({ kind: 'success', msg: 'Referrer removed' })
    } catch (e) {
      onApply(prev)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    }
  }

  if (!lead) return null

  return (
    <div style={{ fontSize: '12px', color: '#8a8a84' }}>
      {lead.referred_by_kind ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
          <button type="button" aria-label="Edit referrer" onClick={() => setPicking(v => !v)}
            style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', borderBottom: '1px dashed rgba(0,0,0,0.2)' }}>
            {/* Kind-only fallback covers a dangling id whose row was deleted. */}
            Referred by {lead.referred_by_name || (lead.referred_by_kind === 'lead' ? 'a client' : 'a partner')}
          </button>
          <button type="button" aria-label="Clear referrer" onClick={clear}
            style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: '#b5b3ac', fontSize: '13px', lineHeight: 1 }}>
            ×
          </button>
        </span>
      ) : (
        <button type="button" aria-label="Add referrer" onClick={() => setPicking(v => !v)}
          style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', cursor: 'pointer', color: '#8a8a84', borderBottom: '1px dashed rgba(0,0,0,0.2)' }}>
          ＋ Add referrer
        </button>
      )}
      {picking && (
        <ReferrerPicker
          people={scopedPeople}
          locationUuid={locationUuid}
          selectedId={lead.referred_by_id || null}
          onSelect={save}
          onPartnerCreated={onPartnerCreated}
          setToast={setToast}
        />
      )}
    </div>
  )
}
