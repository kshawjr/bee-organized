// components/hive/shared/PreferencesBlock.jsx
// ─────────────────────────────────────────────────────────────
// ClientProfile's Preferences block — Build 3 makes the Build-2 display
// rows LIVE:
//   marketing — 'Opt out…' gets an INLINE CONFIRM (a wrong opt-out
//     silently kills every future email — the lifecycle hook cascades);
//     're-subscribe' commits immediately, no dialog (Kevin's rule:
//     friction on the destructive direction only).
//     PATCH /api/leads/:id { marketing_opt_out }.
//   snooze — presets (1w/2w/1m/3m) + custom date + optional note →
//     PATCH { snoozed_until, snoozed_note } (both whitelisted);
//     un-snooze nulls both. The Timeline tab reads snoozed_until on its
//     own fetch; propagation to Inbox rides onPatched → leadPatchMap's
//     snoozed_until → snoozeUntil mapping.
//   nurture drip — row HIDDEN with live business (v4 rule). Otherwise:
//     active → Pause (POST drip-pause), paused → Activate (POST
//     drip-resume — its seed path enrolls never-dripped leads too, so
//     one verb covers resume AND first activation; flag-synced since
//     13baa26 so leads.paused is trustworthy).
//
// All writes optimistic-with-revert; failures keep state honest and
// toast the truth. onPatched(cols) hands confirmed lead-column changes
// up (host merges + onLeadPatched propagation).
// §8.5: props only, no context.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { IconPlayerPause } from '@/components/ui/icons'
import { T } from './tokens'
import { MicroLabel } from './cardKit'
import { fmtShort } from './engagementStatus'

const QUIET = T.surface.sunken

// Quiet inline action — the row's trailing verb.
const rowBtn = (danger = false) => ({
  marginLeft: 'auto', padding: '3px 10px', borderRadius: T.radius.control, flexShrink: 0,
  border: T.border.control, background: T.surface.raised,
  fontSize: '11px', fontWeight: 500, color: danger ? T.state.danger.fg : T.ink.primary,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
})

const SNOOZE_PRESETS = [
  { key: '1w', label: '1 week', days: 7 },
  { key: '2w', label: '2 weeks', days: 14 },
  { key: '1m', label: '1 month', days: 30 },
  { key: '3m', label: '3 months', days: 90 },
]

export default function PreferencesBlock({ client, openCount = 0, onPatched = () => {}, setToast = () => {}, nowMs = Date.now(), readOnly = false }) {
  const c = client
  const [busy, setBusy] = useState(false)
  const [confirmOptOut, setConfirmOptOut] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [snoozePick, setSnoozePick] = useState('1w')
  const [snoozeDate, setSnoozeDate] = useState('')
  const [snoozeNote, setSnoozeNote] = useState('')

  const snoozed = !!(c.snoozed_until && new Date(c.snoozed_until).getTime() > nowMs)

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

  async function saveSnooze() {
    const preset = SNOOZE_PRESETS.find(p => p.key === snoozePick)
    const until = snoozePick === 'custom'
      ? (snoozeDate ? new Date(`${snoozeDate}T09:00:00`).toISOString() : null)
      : new Date(nowMs + preset.days * 86400000).toISOString()
    if (!until) { setToast({ kind: 'error', msg: 'Pick a snooze date' }); return }
    setBusy(true)
    try {
      await patchLead({ snoozed_until: until, snoozed_note: snoozeNote.trim() || null })
      onPatched({ snoozed_until: until, snoozed_note: snoozeNote.trim() || null })
      setSnoozeOpen(false); setSnoozeNote('')
      setToast({ kind: 'success', msg: `Snoozed until ${fmtShort(until)}` })
    } catch (e) {
      setToast({ kind: 'error', msg: `Snooze failed: ${e.message}` })
    } finally { setBusy(false) }
  }

  async function unSnooze() {
    setBusy(true)
    try {
      await patchLead({ snoozed_until: null, snoozed_note: null })
      onPatched({ snoozed_until: null, snoozed_note: null })
      setToast({ kind: 'success', msg: 'Snooze cleared' })
    } catch (e) {
      setToast({ kind: 'error', msg: `Un-snooze failed: ${e.message}` })
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

  const inputStyle = { padding: '6px 9px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', background: T.surface.raised, outline: 'none' }

  return (
    <div style={{ background: QUIET, borderRadius: T.radius.inset, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <MicroLabel>Preferences</MicroLabel>

      {/* Marketing — confirm the destructive direction only. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <p style={{ fontSize: '12px', color: c.marketing_opt_out ? T.state.danger.fg : T.ink.secondary, minWidth: 0 }}>
          {c.marketing_opt_out ? 'Opted out of marketing' : 'Marketing emails OK'}
        </p>
        {readOnly ? null : c.marketing_opt_out ? (
          <button style={rowBtn()} disabled={busy} onClick={() => setMarketing(false)}>Re-subscribe</button>
        ) : confirmOptOut ? (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: '11px', color: T.state.danger.fg }}>Stop all marketing email?</span>
            <button style={{ ...rowBtn(true), marginLeft: 0 }} disabled={busy} onClick={() => setMarketing(true)}>Confirm opt-out</button>
            <button aria-label="Cancel opt-out" style={{ ...rowBtn(), marginLeft: 0 }} disabled={busy} onClick={() => setConfirmOptOut(false)}>✗</button>
          </span>
        ) : (
          <button style={rowBtn(true)} disabled={busy} onClick={() => setConfirmOptOut(true)}>Opt out…</button>
        )}
      </div>

      {/* Snooze — presets + custom date + note; un-snooze clears both. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <p style={{ fontSize: '12px', color: snoozed ? T.state.warning.deep : T.ink.secondary, minWidth: 0 }}>
            {snoozed ? `Snoozed until ${fmtShort(c.snoozed_until)}` : 'Not snoozed'}
          </p>
          {readOnly ? null : snoozed ? (
            <button style={rowBtn()} disabled={busy} onClick={unSnooze}>Un-snooze</button>
          ) : !snoozeOpen && (
            <button style={rowBtn()} disabled={busy} onClick={() => setSnoozeOpen(true)}>Snooze…</button>
          )}
        </div>
        {snoozed && (c.snoozed_note || '').trim() && (
          <p style={{ fontSize: '11px', fontStyle: 'italic', color: T.ink.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            “{c.snoozed_note.trim()}”
          </p>
        )}
        {snoozeOpen && !snoozed && !readOnly && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <select value={snoozePick} onChange={e => setSnoozePick(e.target.value)} aria-label="Snooze length" style={inputStyle}>
                {SNOOZE_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                <option value="custom">Custom date…</option>
              </select>
              {snoozePick === 'custom' && (
                <input type="date" value={snoozeDate} onChange={e => setSnoozeDate(e.target.value)} aria-label="Snooze until" style={inputStyle} />
              )}
            </div>
            <input value={snoozeNote} onChange={e => setSnoozeNote(e.target.value)} placeholder="Note (optional)…" aria-label="Snooze note" style={inputStyle} />
            <div style={{ display: 'flex', gap: '6px' }}>
              <button style={{ ...rowBtn(), marginLeft: 0 }} disabled={busy} onClick={saveSnooze}>Snooze</button>
              <button style={{ ...rowBtn(), marginLeft: 0, color: T.ink.muted }} disabled={busy} onClick={() => setSnoozeOpen(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Nurture drip — hidden with live business (v4 rule). */}
      {openCount === 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <p style={{ fontSize: '12px', color: c.paused ? T.state.warning.deep : T.accent.deep, display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
            <IconPlayerPause size={13} /> {c.paused ? 'Nurture drips paused' : 'Nurture drips active'}
          </p>
          {readOnly ? null : c.paused ? (
            <button style={rowBtn()} disabled={busy} onClick={() => setDrip(false)}>Activate</button>
          ) : (
            <button style={rowBtn()} disabled={busy} onClick={() => setDrip(true)}>Pause</button>
          )}
        </div>
      )}
    </div>
  )
}
