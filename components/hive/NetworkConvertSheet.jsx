// components/hive/NetworkConvertSheet.jsx
// ─────────────────────────────────────────────────────────────
// ONE door, TWO outcomes, chosen at press time — the lead → Network
// conversion sheet. People used the old system as a CRM, so plenty of
// "leads" are really contacts filed in the wrong place.
//
//   Add to Network  — they STAY in the pipeline AND become a Network
//                     person (Karen Pell buys from us AND refers us)
//   Move to Network — never really a client; leaves the Inbox
//
// Deliberately ONE menu entry rather than two: the consequences differ
// enough (one hides a record and pauses its drips) that the choice
// belongs next to its explanation, not in a menu label. It still reads
// as a quick action — one screen, two taps, no wizard.
//
// The SPECIALTY question is here for a reason: nothing on a lead can
// supply it, and a specialty-less partner falls into "Just met · no
// intent yet". Optional, but the hint says what skipping costs.
//
// DEDUP is server-side (GET on open → preview, POST re-checks before it
// writes). The other Network create doors match against the loaded
// partner pool, which is EMPTY on 'All Locations' — and the Inbox is
// usable there for elevated users, so a pool gate would blind-create a
// duplicate on exactly the records most likely to already exist.
//
// §8.5: props only, tokens only. The sheet OWNS its POST (like
// NetworkPersonRecord's touchpoint post) and hands the confirmed rows UP
// — never an optimistic stub.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import { T } from './shared/tokens'
import { lbl } from './shared/formKit'

const MODES = [
  {
    key: 'add',
    title: 'Add to Network',
    blurb: 'They stay a client too — same place in the pipeline, plus a Network record with a Client badge that links back here.',
  },
  {
    key: 'move',
    title: 'Move to Network',
    blurb: 'They were never really a client. Leaves the Inbox and pauses their drip emails. Still searchable, and you can put it back.',
  },
]

const primaryBtn = (enabled) => ({
  width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
  padding: '10px 14px', borderRadius: T.radius.control, border: 'none',
  background: enabled ? T.accent.fg : T.surface.sunken,
  color: enabled ? T.accent.onFill : T.ink.disabled,
  fontSize: '13px', fontWeight: 500, cursor: enabled ? 'pointer' : 'not-allowed',
  fontFamily: 'inherit', whiteSpace: 'nowrap',
})

const secondaryBtn = {
  width: '100%', padding: '10px 14px', borderRadius: T.radius.control,
  border: T.border.strong, background: 'transparent',
  fontSize: '13px', fontWeight: 500, color: T.ink.primary,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}

// Same pill vocabulary NetworkAddSheet uses for its specialty picker —
// one look for one question, wherever it's asked.
const pillBtn = (on) => ({
  padding: '5px 12px', borderRadius: T.radius.pill,
  border: `0.5px solid ${on ? T.hairline.strong : T.hairline.line}`,
  background: on ? T.accent.soft : T.surface.raised,
  fontSize: '12px', fontWeight: on ? 500 : 400,
  color: on ? T.accent.deep : T.ink.muted,
  cursor: 'pointer', fontFamily: 'inherit',
})

const modeCard = (on) => ({
  width: '100%', textAlign: 'left', display: 'block',
  padding: '11px 13px', borderRadius: T.radius.control,
  border: `1px solid ${on ? T.hairline.strong : T.hairline.line}`,
  background: on ? T.accent.soft : T.surface.raised,
  cursor: 'pointer', fontFamily: 'inherit',
})

export default function NetworkConvertSheet({
  person,                       // the lead/person row — id + name are all this needs
  specialties = [],             // admin list [{ id, label }]
  onClose = () => {},
  onConverted = () => {},       // ({ partner, mode, linked, lead_patch }) — CONFIRMED rows
  setToast = () => {},
}) {
  const isMobile = useIsMobile()
  const [mode, setMode] = useState('add')
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  // ── preview: create or link? ──
  // null = still loading. The sheet stays usable either way; this only
  // changes what it PROMISES, never whether the button works.
  const [preview, setPreview] = useState(null)
  useEffect(() => {
    let dead = false
    fetch(`/api/leads/${person.id}/network`)
      .then(async r => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
        return j
      })
      .then(j => { if (!dead) setPreview(j) })
      // A failed preview is not a failed conversion — POST runs the real
      // dedup gate. Fall back to the neutral shape rather than an error
      // state that would imply the door is broken.
      .catch(() => { if (!dead) setPreview({ existing: null, matchedOn: null, alreadyLinked: false, matchError: true }) })
    return () => { dead = true }
  }, [person.id])

  const existing = preview?.existing || null
  const alreadyLinked = !!preview?.alreadyLinked
  const toggle = (id) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])

  async function submit() {
    if (busy || alreadyLinked) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/leads/${person.id}/network`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          specialties: picked,
          // Confirmed link: the user saw "already in your Network" and
          // pressed anyway. Without it the server matches on its own —
          // this only pins WHICH row when the preview already found one.
          ...(existing?.id ? { partner_id: existing.id } : {}),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 207) throw new Error(json?.error || `HTTP ${res.status}`)

      // 207: the partner row landed but the lead-side write didn't. Say so
      // precisely — a generic failure here would invite a second press and
      // a second partner.
      if (res.status === 207) {
        setToast({ kind: 'error', msg: `${json.partner?.name || person.name} was added to the Network, but the client record didn't update — try Move again from the record.` })
      } else {
        const where = json.linked ? 'Linked to' : 'Added to Network —'
        setToast({
          kind: 'success',
          msg: mode === 'move'
            ? `${json.partner?.name || person.name} moved to your Network — drips paused`
            : `${where} ${json.partner?.name || person.name}`,
        })
      }
      onConverted(json)
      onClose()
    } catch (e) {
      const msg = String(e?.message || e)
      setErr(msg === 'dedup_check_failed'
        ? "Couldn't check for an existing Network record — nothing was created. Try again in a moment."
        : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={520}>
      <div style={{ padding: '0 20px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        <div>
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>
            Add {person.name} to your Network
          </h2>
          <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '3px' }}>
            Your Network is the people who send you work — realtors, contractors, neighbours.
          </p>
        </div>

        {/* Dedup answer, stated before the choice rather than after the
            press. "Nothing found" is deliberately NOT rendered: a silent
            create is the expected case and doesn't need narrating. */}
        {alreadyLinked && (
          <div data-testid="convert-already-linked" style={{
            padding: '9px 11px', borderRadius: T.radius.control,
            background: T.accent.soft, fontSize: '12px', color: T.accent.deep,
          }}>
            {person.name} is already in your Network as <strong>{existing?.name}</strong>. Nothing to do here — open them from the Network tab.
          </div>
        )}
        {!alreadyLinked && existing && (
          <div data-testid="convert-match" style={{
            padding: '9px 11px', borderRadius: T.radius.control,
            background: T.accent.soft, fontSize: '12px', color: T.accent.deep,
          }}>
            Already in your Network as <strong>{existing.name}</strong>
            {preview?.matchedOn ? ` (same ${preview.matchedOn})` : ''} — we'll link these two records instead of creating a second one.
          </div>
        )}
        {preview?.matchError && (
          <p style={{ fontSize: '11px', color: T.ink.muted }}>
            Couldn't check for an existing Network record just now — we'll check again when you press.
          </p>
        )}

        {/* ── the choice ── */}
        {!alreadyLinked && (
          <div>
            <span style={lbl}>What are they to you?</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {MODES.map(m => {
                const on = mode === m.key
                return (
                  <button key={m.key} type="button" data-mode={m.key} aria-pressed={on}
                    onClick={() => setMode(m.key)} style={modeCard(on)}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                      <span aria-hidden style={{
                        width: '13px', height: '13px', borderRadius: T.radius.round, flexShrink: 0,
                        border: `1px solid ${on ? T.accent.fg : T.hairline.strong}`,
                        background: on ? T.accent.fg : 'transparent',
                        boxShadow: on ? `inset 0 0 0 2.5px ${T.surface.raised}` : 'none',
                      }} />
                      <span style={{ fontSize: '13px', fontWeight: 500, color: on ? T.accent.deep : T.ink.primary }}>
                        {m.title}
                      </span>
                    </span>
                    <span style={{ display: 'block', fontSize: '11.5px', color: T.ink.muted, marginTop: '4px', paddingLeft: '20px', lineHeight: 1.45 }}>
                      {m.blurb}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* ── specialty ──
            Not required, because forcing a taxonomy choice would make a
            two-tap action a decision. But an empty one has a cost and the
            hint names it, so skipping is informed rather than accidental. */}
        {!alreadyLinked && specialties.length > 0 && (
          <div>
            <span style={lbl}>What do they do? <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(optional)</span></span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {specialties.map(s => (
                <button key={s.id} type="button" aria-pressed={picked.includes(s.id)}
                  onClick={() => toggle(s.id)} style={pillBtn(picked.includes(s.id))}>
                  {s.label}
                </button>
              ))}
            </div>
            {picked.length === 0 && (
              <p style={{ fontSize: '11px', color: T.ink.quiet, marginTop: '6px' }}>
                Without one they'll sit under “Just met · no intent yet” until you pick.
              </p>
            )}
          </div>
        )}

        {err && (
          <div style={{
            padding: '8px 11px', borderRadius: T.radius.control,
            background: T.state.danger.soft, color: T.state.danger.fg, fontSize: '12px',
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {!alreadyLinked && (
            <button type="button" onClick={submit} disabled={busy} style={primaryBtn(!busy)}>
              {busy
                ? 'Working…'
                : mode === 'move' ? 'Move to Network' : (existing ? 'Link to Network record' : 'Add to Network')}
            </button>
          )}
          <button type="button" onClick={onClose} style={secondaryBtn}>
            {alreadyLinked ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </OverlayShell>
  )
}
