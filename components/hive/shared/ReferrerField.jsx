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
//
// VISIBILITY (7/23, Kevin — the "Refer" line on every Inbox card):
// the referrer is only meaningful on a referral-sourced lead, and the
// create side already knows it (NewClientSheet shows the picker only
// when Source = Referral; a SET here PATCHes source:'Referral' with it).
// The card wasn't honoring the same rule, so the "add referrer"
// affordance sat on Website / Google / Manual / MAKE-slug leads too.
// The gate is ASYMMETRIC on purpose — see isReferralSourced below:
//   · nothing stored + non-referral source → render NOTHING. There is
//     no referrer to show and no reason to invite one; set Source to
//     Referral first and the affordance appears.
//   · a STORED referrer → always render, whatever the source says.
//     Hiding stored attribution because someone later re-picked Source
//     would erase who sent us this client from every screen while the
//     columns still hold it — a silent data blind spot, and the exact
//     shape of bug the clear-path asymmetry above was written to avoid.
//     It also keeps the referrer CLEARABLE: hide it and a wrong
//     referrer would be stuck with no UI able to reach it.
// Match is substring, case-insensitive ('referral'), because source
// labels are an admin-managed per-location lookup — 'Referral',
// 'referral', 'Client Referral' all mean the same thing, while
// 'Website' / 'Google' / 'seattle_assessment' match none of it.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useMemo, useState } from 'react'
import ReferrerPicker from '../ReferrerPicker'
import { IconUserCheck } from '@/components/ui/icons'
import { T } from './tokens'
import { metaRowStyle, metaIconStyle, metaLabelStyle, metaValueStyle, metaAddStyle, META_ICON } from './metaRow'

// The display gate. Exported so a surface can ask the same question
// without re-deriving it (and so the rule has ONE definition).
export const isReferralSourced = (source) =>
  String(source || '').trim().toLowerCase().includes('referral')

export default function ReferrerField({
  lead,               // { id, referred_by_kind, referred_by_id, referred_by_name, source }
  locationUuid,       // the lead's location — scopes clients + the partners fetch
  people = [],        // the shell's (unscoped) people list
  onApply = () => {}, // (fields) => merge into the surface's client state
  onSaved = () => {}, // (colPatch) => propagation after a confirmed PATCH
  onPartnerCreated = () => {}, // confirmed inline-created partner row → Classic seam
  setToast = () => {},
  readOnly = false,
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

  const hasReferrer = !!lead.referred_by_kind

  // THE gate (see header). Stored attribution always shows; the invite
  // to add one only appears on a referral-sourced lead.
  if (!hasReferrer && !isReferralSourced(lead.source)) return null

  // Dangling id (route flagged referred_by_missing) → an explicit
  // "removed referrer"; a name-less-but-not-flagged lead (older
  // payloads) still degrades to the kind.
  const referrerName = lead.referred_by_name
    || (lead.referred_by_missing ? 'a removed referrer'
      : lead.referred_by_kind === 'lead' ? 'a client'
      : lead.referred_by_kind === 'company' ? 'a company' : 'a partner')

  return (
    <div>
      {hasReferrer ? (
        // The shared meta-row anatomy — same icon well, gap, type size
        // and muted-label treatment as the Source / phone / email rows
        // it sits under (metaRow.js).
        <p style={metaRowStyle()} data-meta-row="referrer">
          <span style={metaIconStyle}><IconUserCheck size={META_ICON} /></span>
          {readOnly ? (
            // Read-only: referrer display stays; no edit toggle, no × clear.
            <span style={metaValueStyle}>
              <span style={metaLabelStyle}>Referred by </span>{referrerName}
            </span>
          ) : (
            <>
              <button type="button" aria-label="Edit referrer" onClick={() => setPicking(v => !v)}
                style={{ ...metaValueStyle, border: 'none', background: 'transparent', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', borderBottom: T.border.underline }}>
                <span style={metaLabelStyle}>Referred by </span>{referrerName}
              </button>
              <button type="button" aria-label="Clear referrer" onClick={clear}
                style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: T.ink.quiet, fontSize: '13px', lineHeight: 1, flexShrink: 0 }}>
                ×
              </button>
            </>
          )}
        </p>
      ) : readOnly ? null : (
        <p style={metaRowStyle({ tone: 'faint' })} data-meta-row="referrer">
          <span style={{ ...metaIconStyle, color: 'inherit' }}><IconUserCheck size={META_ICON} /></span>
          <button type="button" aria-label="Add referrer" onClick={() => setPicking(v => !v)}
            style={{ ...metaAddStyle, border: 'none', background: 'transparent', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}>
            add referrer
          </button>
        </p>
      )}
      {picking && (
        <ReferrerPicker
          people={scopedPeople}
          locationUuid={locationUuid}
          selectedId={lead.referred_by_id || null}
          onSelect={save}
          onPartnerCreated={onPartnerCreated}
          setToast={setToast}
          readOnly={readOnly}
        />
      )}
    </div>
  )
}
