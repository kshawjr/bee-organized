// components/hive/shared/PreferencesBlock.jsx
// ─────────────────────────────────────────────────────────────
// ClientProfile's Preferences block — Build 3 makes the Build-2 display
// rows LIVE:
//   marketing — 'Opt out…' gets an INLINE CONFIRM (a wrong opt-out
//     silently kills every future email — the lifecycle hook cascades);
//     're-subscribe' commits immediately, no dialog (Kevin's rule:
//     friction on the destructive direction only).
//     PATCH /api/leads/:id { marketing_opt_out }.
//   snooze — GONE from this block (Kevin, 2026-09-16). The column and every
//     reader of it remain; the only hand-operated exit is now the Timeline
//     tab's "Snoozed until …" item and its Un-snooze action. See the note at
//     the render site.
//   nurture drip — row HIDDEN with live business (v4 rule). Otherwise
//     five states in precedence order (issue 112 added the first two,
//     issue 243 the fourth):
//       stopped        → reason + guidance, no button (dead sequence)
//       completed      → display only
//       paused         → Activate (POST drip-resume — its seed path
//                        enrolls never-dripped leads too, so one verb
//                        covers resume AND first activation; flag-synced
//                        since 13baa26 so leads.paused is trustworthy)
//       never enrolled → reason + guidance, no button (nothing to pause,
//                        and Activate would re-hit the same gate that
//                        skipped it — see DRIP_NEVER_COPY)
//       active         → Pause (POST drip-pause)
//
// All writes optimistic-with-revert; failures keep state honest and
// toast the truth. onPatched(cols) hands confirmed lead-column changes
// up (host merges + onLeadPatched propagation).
// §8.5: props only, no context.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { IconPlayerPause, IconMail } from '@/components/ui/icons'
import { T } from './tokens'
import { MicroLabel, rowActionBtn } from './cardKit'

const QUIET = T.surface.sunken

// The row's trailing verb — the shared kit control (height single-homed in
// T.badge.height so it sits level with the +Add / +Tag pills above).
const rowBtn = rowActionBtn


// issue 112 — a terminally-stopped nurture drip must read in plain English, never
// as the raw stopped_reason enum. `reason` = why the sequence ended; `guide` =
// what the owner can do about it (audience is non-technical). There is NO
// restart button: the owner-accessible resume path (drip-resume) only revives
// PAUSED rows and silently no-ops on a stopped one, so the guidance points at
// the real recovery instead of a dead control. Unknown reasons fall back.
const DRIP_STOP_COPY = {
  hard_bounce:       { reason: 'the client’s email address bounced',       guide: 'Fix the client’s email address, then contact support to restart nurture emails.' },
  invalid_recipient: { reason: 'the client’s email address looks invalid', guide: 'Fix the client’s email address, then contact support to restart nurture emails.' },
  no_email:          { reason: 'there’s no email address on file',         guide: 'Add the client’s email address, then contact support to restart nurture emails.' },
  max_send_retries:  { reason: 'emails kept failing to send',              guide: 'Check the client’s email address, then contact support to restart nurture emails.' },
  spam_complaint:    { reason: 'the client marked our email as spam',      guide: 'Nurture emails won’t restart for this client.' },
  opted_out:         { reason: 'the client opted out of marketing',        guide: 'Re-subscribe them above to resume nurture emails.' },
  stage_changed:     { reason: 'the client moved forward in the pipeline', guide: 'This is normal — nurture stops once a client is active.' },
  junk:              { reason: 'the client was marked as junk',            guide: 'Restore the client to resume nurture emails.' },
}
const DRIP_STOP_FALLBACK = { reason: 'nurture emails were stopped', guide: 'Contact support to restart nurture emails.' }

// issue 243 — NEVER STARTED, which is not the same as stopped and is very much
// not "active". Same two-line shape as DRIP_STOP_COPY (plain-English `reason`,
// actionable `guide`) rather than a parallel vocabulary. Also NO button, for
// the same reason 112 gave: the owner-accessible Activate path (drip-resume →
// resumePausedDripsForLead → startDripForLead) re-enters startDripForLead's
// interface-active gate, so on the dominant reason here — the location isn't
// active — it would return having enrolled nothing and toast success. A silent
// no-op is worse than no control. `reason` may be null when the cause isn't
// knowable; the headline then stands alone rather than inventing one.
const DRIP_NEVER_COPY = {
  location_not_active:      { reason: 'this location isn’t live yet',                  guide: 'Nurture emails start once the location is activated. Leads that arrive before then aren’t enrolled.' },
  location_activated_later: { reason: 'this client arrived before the location went live', guide: 'Contact support to start nurture emails for this client.' },
}
const DRIP_NEVER_FALLBACK = { reason: null, guide: 'Contact support to start nurture emails for this client.' }

export default function PreferencesBlock({ client, openCount = 0, onPatched = () => {}, setToast = () => {}, nowMs = Date.now(), readOnly = false }) {
  const c = client
  const [busy, setBusy] = useState(false)
  const [confirmOptOut, setConfirmOptOut] = useState(false)


  // issue 112 — nurture-drip lifecycle. The panel historically read only
  // leads.paused (c.paused), so every TERMINAL stop (hard_bounce et al.,
  // written to lead_drip_progress alone) rendered "active" with a live Pause.
  // The profile route now surfaces the effective terminal state; stopped
  // outranks completed outranks the paused/active flag rows below.
  const dripStopCopy = c.drip_stopped_reason
    ? (DRIP_STOP_COPY[c.drip_stopped_reason] || DRIP_STOP_FALLBACK)
    : null
  const dripCompleted = !dripStopCopy && !!c.drip_completed

  // issue 243 — never-enrolled sits BELOW paused in precedence on purpose. An
  // imported lead is both (it lands paused = true with zero progress rows) and
  // its Activate button is the genuine first-enrollment path, so paused must
  // keep winning or 14k imported leads lose the only control that works for
  // them. Everything else with no progress rows lands here instead of being
  // mislabelled "active".
  const dripNeverCopy = !dripStopCopy && !dripCompleted && !c.paused && c.drip_never_enrolled
    ? (DRIP_NEVER_COPY[c.drip_never_enrolled_reason] || DRIP_NEVER_FALLBACK)
    : null

  async function patchLead(patch) {
    const res = await fetch(`/api/leads/${c.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
  }

  async function setMarketing(optOut) {
    setBusy(true)
    try {
      await patchLead({ marketing_opt_out: optOut })
      onPatched({ marketing_opt_out: optOut })
      setConfirmOptOut(false)
      setToast({ kind: 'success', msg: optOut ? 'Opted out of marketing' : 'Re-subscribed to marketing' })
    } catch (e) {
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    } finally { setBusy(false) }
  }


  // Pause/Activate through the dedicated routes (NOT the leads PATCH):
  // they keep the paused flag and the progress-row state in lockstep,
  // and drip-resume's seed path enrolls never-dripped leads.
  async function setDrip(pause) {
    setBusy(true)
    try {
      const res = await fetch(`/api/leads/${c.id}/${pause ? 'drip-pause' : 'drip-resume'}`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      onPatched({ paused: pause })
      setToast({ kind: 'success', msg: pause ? 'Nurture drips paused' : 'Nurture drips active' })
    } catch (e) {
      setToast({ kind: 'error', msg: `Drip ${pause ? 'pause' : 'activate'} failed: ${e.message}` })
    } finally { setBusy(false) }
  }


  return (
    <div style={{ background: QUIET, borderRadius: T.radius.inset, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <MicroLabel>Preferences</MicroLabel>

      {/* Marketing — confirm the destructive direction only. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <p style={{ fontSize: '12px', color: c.marketing_opt_out ? T.state.danger.fg : T.ink.secondary, minWidth: 0 }}>
          {c.marketing_opt_out ? 'Opted out of marketing' : 'Marketing emails OK'}
        </p>
        {readOnly ? null : c.marketing_opt_out ? (
          <button className="bee-small-action" style={rowBtn()} disabled={busy} onClick={() => setMarketing(false)}>Re-subscribe</button>
        ) : confirmOptOut ? (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: '11px', color: T.state.danger.fg }}>Stop all marketing email?</span>
            <button className="bee-small-action" style={{ ...rowBtn(true), marginLeft: 0 }} disabled={busy} onClick={() => setMarketing(true)}>Confirm opt-out</button>
            <button className="bee-small-action" aria-label="Cancel opt-out" style={{ ...rowBtn(), marginLeft: 0 }} disabled={busy} onClick={() => setConfirmOptOut(false)}>✗</button>
          </span>
        ) : (
          <button className="bee-small-action" style={rowBtn(true)} disabled={busy} onClick={() => setConfirmOptOut(true)}>Opt out…</button>
        )}
      </div>

      {/* SNOOZE IS GONE FROM THE CARD (Kevin, 2026-09-16). cd03c92 removed the
          two Inbox menu items and kept this row; the ruling is that snooze
          goes, not just the menu entries. The status line, Un-snooze, the
          Snooze… picker and its note are all removed.

          WHAT STAYS, because 3 leads are snoozed in production right now and
          must wake correctly AND stay wake-able by hand:
            · leads.snoozed_until / snoozed_note — untouched
            · isSoftRemovedFromInbox's future-snooze test — untouched, so
              those 3 stay off the worklist until their date passes
            · the Timeline's "Snoozed until …" item and its Un-snooze action
              (shared/Timeline.jsx) — untouched, and now the ONLY way to wake
              one by hand. That is why this row could go: the exit did not
              live here alone.
          Removing the way IN was the job. */}

      {/* Nurture drip — hidden with live business (v4 rule). issue 112: three
          states ahead of the paused/active flag. STOPPED (terminal — bounce,
          opt-out, …) shows the plain reason + what to do, and NO button (a
          dead sequence can't be paused and resume no-ops). COMPLETED (ran to
          the end) is display-only too. Only a live drip gets Pause/Activate. */}
      {openCount === 0 && (
        dripStopCopy ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <p style={{ fontSize: '12px', color: T.state.warning.deep, display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
              <IconPlayerPause size={13} /> Nurture drips stopped — {dripStopCopy.reason}
            </p>
            <p style={{ fontSize: '11px', color: T.ink.muted, lineHeight: 1.45 }}>{dripStopCopy.guide}</p>
          </div>
        ) : dripCompleted ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <p style={{ fontSize: '12px', color: T.ink.secondary, display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
              <IconPlayerPause size={13} /> Nurture drips completed
            </p>
          </div>
        ) : dripNeverCopy ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <p style={{ fontSize: '12px', color: T.state.warning.deep, display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
              <IconMail size={13} /> Not receiving nurture emails
              {dripNeverCopy.reason ? ` — ${dripNeverCopy.reason}` : ''}
            </p>
            <p style={{ fontSize: '11px', color: T.ink.muted, lineHeight: 1.45 }}>{dripNeverCopy.guide}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <p style={{ fontSize: '12px', color: c.paused ? T.state.warning.deep : T.accent.deep, display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
              <IconPlayerPause size={13} /> {c.paused ? 'Nurture drips paused' : 'Nurture drips active'}
            </p>
            {readOnly ? null : c.paused ? (
              <button className="bee-small-action" style={rowBtn()} disabled={busy} onClick={() => setDrip(false)}>Activate</button>
            ) : (
              <button className="bee-small-action" style={rowBtn()} disabled={busy} onClick={() => setDrip(true)}>Pause</button>
            )}
          </div>
        )
      )}
    </div>
  )
}
