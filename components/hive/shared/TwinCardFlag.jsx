// components/hive/shared/TwinCardFlag.jsx
// ─────────────────────────────────────────────────────────────
// The two-open-cards flag on an engagement card, and its one button.
// The rule and every word live in ./twinCards.js; the server decides whether
// a close is allowed (app/api/engagements/[id]/close-duplicate). This file
// only draws what it is handed.
//
// THREE THINGS IT CAN SHOW
//   · the flag (twin) — two cards are open, and which one has the work;
//   · "Close as duplicate" — ONLY when twin.canCloseAsDuplicate and the
//     viewer may write. Otherwise the button is not drawn at all: nothing to
//     click, nothing to tab to;
//   · the line straight after the tap (closedLine) — what just happened, and
//     the way to the card that has the work.
//
// The close is posted from HERE, not from the panel: the panel must never
// carry its own copy of a close write (the beta-stage-control source pin).
// ─────────────────────────────────────────────────────────────
'use client'

import { useRef, useState } from 'react'
import { T } from './tokens'
import { rowActionBtn } from './cardKit'
import { twinFlagText, CLOSE_AS_DUPLICATE_ACTION, OPEN_OTHER_CARD_ACTION, DUPLICATE_REOPEN_HINT } from './twinCards'

export async function postCloseAsDuplicate(engagementId) {
  const res = await fetch(`/api/engagements/${engagementId}/close-duplicate`, { method: 'POST' })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`)
  return j
}

export default function TwinCardFlag({ twin = null, closedLine = null, closedOther = null, firstName = '', engagementId, readOnly = false, onOpenOther = null, onClosed = () => {}, setToast = () => {} }) {
  const [busy, setBusy] = useState(false)
  // A ref as well as state: two taps in the same instant both see busy=false
  // (state has not re-rendered yet), and each would post. The ref is read and
  // set synchronously, so the second tap stops here.
  const inFlight = useRef(false)
  const other = closedLine ? closedOther : twin?.other
  const text = closedLine ? null : twinFlagText(twin, firstName)
  if (!closedLine && !text) return null

  const canClose = !closedLine && !readOnly && !!twin?.canCloseAsDuplicate

  async function close() {
    if (inFlight.current || !canClose) return
    inFlight.current = true
    setBusy(true)
    try {
      const j = await postCloseAsDuplicate(engagementId)
      onClosed(j)
    } catch (e) {
      setToast({ kind: 'error', msg: `Not closed: ${e.message}` })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  // Taller than the card's other small buttons (20px) and set further apart:
  // one of these closes the card in one tap, and on a phone it sits beside
  // the one that only opens the other card.
  const btn = { ...rowActionBtn(), marginLeft: 0, height: '30px', padding: '0 12px' }
  const tone = closedLine ? { bg: T.surface.sunken, ink: T.ink.secondary } : { bg: T.family.amber.bg, ink: T.family.amber.text }
  return (
    <div role="note" data-twin-flag={closedLine ? 'closed' : twin.role}
      style={{ background: tone.bg, color: tone.ink, borderRadius: T.radius.inset, padding: '11px 14px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
      {closedLine ? (
        <>
          <p data-twin-closed-line style={{ fontSize: '12px', lineHeight: 1.5, color: T.ink.primary }}>{closedLine}</p>
          <p data-twin-reopen-hint style={{ fontSize: '12px', lineHeight: 1.5 }}>{DUPLICATE_REOPEN_HINT}</p>
        </>
      ) : (
        <>
          <p data-twin-headline style={{ fontSize: '12px', fontWeight: 600, lineHeight: 1.45 }}>{text.headline}</p>
          <p data-twin-body style={{ fontSize: '12px', lineHeight: 1.5 }}>{text.body}</p>
        </>
      )}
      {(canClose || (onOpenOther && other)) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '6px' }}>
          {onOpenOther && other && (
            <button type="button" className="bee-small-action" data-twin-open-other={other.id}
              onClick={() => onOpenOther(other)}
              style={btn}>
              {OPEN_OTHER_CARD_ACTION}
            </button>
          )}
          {canClose && (
            <button type="button" className="bee-small-action" data-twin-close-duplicate
              onClick={close} disabled={busy}
              style={{ ...btn, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Closing…' : CLOSE_AS_DUPLICATE_ACTION}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
