'use client'

// CONFIRM A CHANGE (Network & Nurture, slice 6). One small box, used by the
// contact sheet (one partner's level or stage) and by the list's bulk bar
// (tags, level or stage on a whole selection).
//
// IT EXISTS SO NOTHING MOVES BY ACCIDENT, and it is kept cheap: one box, one
// question, the confirm button already focused, Enter confirms. A bulk change
// of twenty contacts is asked ONCE, here, never once per contact.
//
// CANCEL CHANGES NOTHING. This box writes nothing itself: it only hands the
// host a yes (and an optional note). Cancel, ✕ or Escape hand back nothing,
// and the host sends no request. (The server refuses a level, stage or bulk
// change without the yes, too.)
//
// It closes by its own Cancel, ✕ or Escape, never by a tap outside.

import React, { useEffect, useRef, useState } from 'react'
import { T, NET } from '@/components/design/tokens'

const S = '[data-network-confirm]'
const CSS = `
${S}{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(26,48,44,.35)}
${S} .nc{width:100%;max-width:440px;border:1px solid ${T.border};border-radius:16px;background:${T.card};box-shadow:0 24px 60px -20px rgba(26,48,44,.35);padding:18px 20px;display:grid;gap:12px;outline:none}
${S} h2{margin:0;font-family:inherit;font-size:17px!important;font-weight:700;color:${T.primary}}
${S} p{margin:0;font-size:13.5px;line-height:1.45;color:${T.primary}}
${S} .nc-quiet{color:${T.mutedFg};font-size:12.5px}
${S} ul{margin:0;padding-left:18px;font-size:13px;color:${T.mutedFg};display:grid;gap:2px}
${S} label{display:grid;gap:4px;font-size:12.5px;color:${T.mutedFg}}
${S} textarea{min-height:64px;padding:8px 10px;border:1px solid ${T.input};border-radius:10px;font:inherit;font-size:14px;color:${T.primary};background:${T.card};resize:vertical}
${S} .nc-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
${S} .nc-btn{min-height:44px;padding:0 16px;border-radius:10px;font-size:14px!important;font-weight:700;border:1px solid ${T.input};background:${T.card};color:${T.primary}}
${S} .nc-btn[data-primary]{background:${T.primary};border-color:${T.primary};color:${T.primaryFg}}
${S} .nc-btn:disabled{opacity:.6}
${S} .nc-error{color:${T.destructive};font-size:13px}
${S} .nc-warn{padding:8px 10px;border-radius:8px;background:${NET.warnSoft};border:1px solid ${NET.warn};font-size:12.5px}
@media (max-width:600px){ ${S}{align-items:flex-end;padding:0} ${S} .nc{border-radius:16px 16px 0 0;max-width:none;padding-bottom:calc(18px + env(safe-area-inset-bottom,0px))} }
`

/**
 * Props
 *   title        the question, e.g. "Move Tom Harper to Reaching Out?"
 *   detail       one line under it (optional)
 *   names        up to a few names it applies to (optional, bulk)
 *   warn         a line in the warning tone (optional), e.g. who is skipped
 *   withNote     offer an optional note box (the sheet does; bulk does not)
 *   confirmLabel the yes button's words
 *   busy, error  while saving / what went wrong
 *   onConfirm(note)  the yes
 *   onCancel()       the no: the host sends nothing
 */
export default function ConfirmChange({ title, detail = null, names = null, warn = null, withNote = false, confirmLabel = 'Yes, change it', busy = false, error = null, onConfirm, onCancel }) {
  const [note, setNote] = useState('')
  const yes = useRef(null)
  useEffect(() => {
    yes.current?.focus({ preventScroll: true })
    const key = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel() } }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [busy, onCancel])
  return (
    <div data-network-confirm role="presentation">
      <style>{CSS}</style>
      <form className="nc" role="alertdialog" aria-modal="true" aria-label={title} onSubmit={(e) => { e.preventDefault(); if (!busy) onConfirm(note.trim()) }} data-confirm>
        <h2>{title}</h2>
        {detail && <p className="nc-quiet" data-confirm-detail>{detail}</p>}
        {names && names.length > 0 && <ul data-confirm-names>{names.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        {warn && <p className="nc-warn" data-confirm-warn>{warn}</p>}
        {withNote && (
          <label>Note, if you want one (saved on their sheet)
            <textarea value={note} maxLength={500} disabled={busy} onChange={(e) => setNote(e.target.value)} data-confirm-note />
          </label>
        )}
        {error && <p className="nc-error" role="alert" data-confirm-error>{error}</p>}
        <div className="nc-foot">
          <button type="button" className="nc-btn" onClick={onCancel} disabled={busy} data-confirm-cancel>Cancel</button>
          <button type="submit" ref={yes} className="nc-btn" data-primary disabled={busy} data-confirm-yes>{busy ? 'Saving…' : confirmLabel}</button>
        </div>
      </form>
    </div>
  )
}
