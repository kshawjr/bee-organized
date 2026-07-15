// components/hive/TouchpointModal.jsx
// ─────────────────────────────────────────────────────────────
// THE touchpoint composer — ONE center modal behind every logging
// surface (engagement card, client profile, Inbox row). It replaces the
// inline wedge that was copy-pasted onto the panel and the profile: a
// select + a single-line input + a Log button squeezed onto one flex row
// between Call and Send-to-Jobber. Logging a call is the most-repeated
// gesture in the app and it was the cramped one.
//
// SHAPE: method as tiles (the thing you always pick) → outcome as
// optional chips → a real notes textarea → Cancel / Log. The Log label
// restates the method, so the commit reads back what you're about to
// write ("Log voicemail" is one glance; "Log" was a shrug).
//
// The OUTCOME row writes touchpoints.status — free text in the schema
// (no CHECK), whitelisted straight through the route, and ALREADY
// rendered by Timeline (it underscore-splits the value), so 'no_answer'
// shows as "Status: no answer" with zero backend work. It stays optional
// and always visible: hiding it per-method would trade a dead chip for a
// jumping layout, and "no answer" is meaningful on a text too.
//
// THIS COMPONENT DOES NOT WRITE. onSubmit hands the caller the payload
// and the caller owns the POST — because the three surfaces genuinely
// differ (the panel rides engagement_id; the others don't) and each one
// hands the RAW returned row up its own seam. A modal that fetched would
// have to re-learn all three. The caller closes on success; a rejected
// onSubmit leaves the modal open with the notes intact so a failed log
// is retryable rather than retyped.
//
// Chrome ownership: OverlayShell brings the backdrop, the centered/sheet
// geometry, scroll-lock, swipe-dismiss and the X (handle row on mobile).
// It does NOT bring Esc, a dialog role, or padding — those are here.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import { inp, lbl } from './shared/formKit'
import { T } from './shared/tokens'
import { IconPhone, IconMessage, IconMail, IconUsers } from '@/components/ui/icons'

// method → the DB value (touchpoints.method CHECK) + the verb the Log
// button restates. 'sms' is the column value; "Text" is what people say.
export const METHODS = [
  { value: 'call', label: 'Call', icon: IconPhone, verb: 'Log call' },
  { value: 'sms', label: 'Text', icon: IconMessage, verb: 'Log text' },
  { value: 'email', label: 'Email', icon: IconMail, verb: 'Log email' },
  { value: 'in_person', label: 'In person', icon: IconUsers, verb: 'Log in person' },
]

// touchpoints.status values. Free text in the schema; these three are the
// vocabulary the UI commits to — Timeline renders them by de-underscoring.
export const OUTCOMES = [
  { value: 'reached', label: 'Reached' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'voicemail', label: 'Left voicemail' },
]

const verbFor = (m) => METHODS.find(x => x.value === m)?.verb || 'Log touchpoint'

// SIZING (standing preference — compact, square-ish, never chunky):
// the tile row is 4-up and flex:1, so the tile's WIDTH is a function of
// the shell width. That makes MODAL_WIDTH load-bearing geometry, not
// taste: at 460 the tiles come out 97×68 (a 1.4 wide bar — the thing
// this is meant not to be); at 380 the content column is 332, so each
// tile is (332 - 3×8)/4 ≈ 77 wide against 68 tall — square-ish, and the
// whole modal reads tighter. Widening the shell silently un-squares the
// tiles, so move these two together or not at all.
const MODAL_WIDTH = 380
const TILE_MIN_HEIGHT = '68px'

function MethodTile({ opt, selected, onSelect }) {
  const Icon = opt.icon
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={opt.label}
      onClick={() => onSelect(opt.value)}
      style={{
        flex: 1, minWidth: 0, minHeight: TILE_MIN_HEIGHT,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px',
        padding: '8px 4px', borderRadius: T.radius.control,
        border: selected ? `1px solid ${T.accent.fg}` : T.border.control,
        background: selected ? T.accent.soft : T.surface.raised,
        color: selected ? T.accent.deep : T.ink.muted,
        fontSize: '12px', fontWeight: 500, fontFamily: 'inherit', lineHeight: 1.3,
        cursor: 'pointer',
      }}
    >
      <Icon size={18} />
      <span>{opt.label}</span>
    </button>
  )
}

export default function TouchpointModal({
  personName = null,
  subline = null,
  initialMethod = 'call',
  onClose = () => {},
  onSubmit = async () => {},
}) {
  const isMobile = useIsMobile()
  const [method, setMethod] = useState(initialMethod)
  const [status, setStatus] = useState(null)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Esc — OverlayShell gives the backdrop tap and the X, not this.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Re-tapping the live outcome clears it back to null — the row is
  // optional, so every chip has to be un-pickable without a "none" chip.
  const toggleStatus = (v) => setStatus(cur => (cur === v ? null : v))

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    try {
      await onSubmit({ method, status, notes: notes.trim() || null })
      // No close here: the caller closes on a confirmed write, so a
      // failure keeps the typed notes on screen instead of eating them.
    } catch {
      // The caller owns the error surface (its own toast) — swallowed so a
      // rejected write leaves a live, retryable modal rather than an
      // unhandled rejection out of a click handler.
    } finally {
      setSubmitting(false)
    }
  }

  const head = [personName, subline].filter(Boolean).join(' · ')

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={MODAL_WIDTH}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Log touchpoint"
        style={{ padding: isMobile ? '0 16px 18px' : '0 24px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}
      >
        <div>
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>
            Log touchpoint
          </h2>
          {head && (
            <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '4px' }}>{head}</p>
          )}
        </div>

        <div>
          <label style={lbl}>Method</label>
          <div role="radiogroup" aria-label="Method" style={{ display: 'flex', gap: '8px' }}>
            {METHODS.map(opt => (
              <MethodTile key={opt.value} opt={opt} selected={method === opt.value} onSelect={setMethod} />
            ))}
          </div>
        </div>

        <div>
          <label style={lbl}>Outcome · optional</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {OUTCOMES.map(o => {
              const on = status === o.value
              return (
                <button
                  key={o.value}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleStatus(o.value)}
                  style={{
                    padding: '5px 11px', borderRadius: T.radius.pill,
                    border: on ? `0.5px solid ${T.accent.fg}` : T.border.control,
                    background: on ? T.accent.soft : T.surface.raised,
                    color: on ? T.accent.deep : T.ink.muted,
                    fontSize: '12px', fontWeight: 500, fontFamily: 'inherit',
                    lineHeight: 1.4, cursor: 'pointer',
                  }}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <label style={lbl}>Notes · optional</label>
          <textarea
            autoFocus
            style={{ ...inp, minHeight: '84px', resize: 'vertical', lineHeight: 1.4 }}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="What came of it? Anything the next person should know."
            aria-label="Notes"
          />
        </div>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 15px', borderRadius: T.radius.control, border: 'none',
              background: 'transparent', color: T.ink.muted,
              fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            style={{
              padding: '8px 15px', borderRadius: T.radius.control, border: 'none',
              background: submitting ? T.ink.disabled : T.accent.fg, color: T.accent.onFill,
              fontSize: '13px', fontWeight: 500, fontFamily: 'inherit',
              cursor: submitting ? 'default' : 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {verbFor(method)}
          </button>
        </div>
      </div>
    </OverlayShell>
  )
}
