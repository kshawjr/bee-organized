// components/hive/shared/MailchimpRefusedDialog.jsx
// ─────────────────────────────────────────────────────────────
// FL-137/135 fix 2 (Kevin, 2026-11-28: "the message did pop up but it didn't
// stay on screen long enough. I'd suggest a centre pop up").
//
// When Bee Hub was asked to send someone to Mailchimp mid-task (the Closed
// Lost box, a write-off, Send to Jobber, the Nurturing Add) and the send was
// REFUSED, the owner is told in a dialog in the middle of the screen that
// stays until they press "Got it". Never a toast: it is an instruction (go
// and pause something), not a passing status.
//
// It says three things, in this order:
//   1. what DID happen ("Pat Lee is in Nurturing.") — so the owner knows the
//      rest of what they did stands;
//   2. that they were NOT sent to Mailchimp, and why (the journey by name);
//   3. what to do about it.
//
// It is opened with showMailchimpRefused(), which draws it on its own on the
// page: the close wizard that asked for the send shuts the moment the close
// saves, and this must outlive it. Nothing here writes or sends anything.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { T } from './tokens'

// Outcomes that are NOT a refusal: sent, or already there (nothing to send),
// or Mailchimp not open here (the box was never offered).
const NOT_A_REFUSAL = new Set(['added', 'already_there', 'not_open'])

/** Does this Mailchimp answer need the dialog? */
export function isMailchimpRefusal(result) {
  return !!result && result.sent !== true && !!result.outcome && !NOT_A_REFUSAL.has(result.outcome)
}

const quoteList = (names) => names.map((n) => `“${n}”`).join(names.length > 2 ? ', ' : ' and ')

/** The words, worked out once (pure, so tests read them). */
export function refusalWords({ name, did, result }) {
  const who = (name && String(name).trim()) || 'This person'
  const flows = Array.isArray(result?.flows) ? result.flows.filter(Boolean) : []
  if (result?.outcome === 'signup_flows_live') {
    return {
      did: did ? `${who} ${did}.` : null,
      notSent: `${who} was not sent to Mailchimp.`,
      why: flows.length
        ? `${flows.length === 1 ? 'A welcome journey is' : 'Welcome journeys are'} switched on in Mailchimp: ${quoteList(flows)}. Mailchimp would email them the moment they were added, so Bee Hub held them back.`
        : 'A welcome journey is switched on in Mailchimp. Mailchimp would email them the moment they were added, so Bee Hub held them back.',
      todo: `To send them, pause ${flows.length === 1 ? 'that journey' : 'those journeys'} in Mailchimp first: go to Automations, open it by its name, and choose Pause.`,
    }
  }
  return {
    did: did ? `${who} ${did}.` : null,
    notSent: `${who} was not sent to Mailchimp.`,
    why: String(result?.words || '').replace(/^Not sent to Mailchimp( yet)?:\s*/i, '').replace(/^./, (c) => c.toUpperCase()) || 'Something went wrong. Nothing was changed in Mailchimp.',
    todo: null,
  }
}

export default function MailchimpRefusedDialog({ name, did, result, onClose }) {
  const w = refusalWords({ name, did, result })
  const ok = useRef(null)
  useEffect(() => { ok.current?.focus() }, [])
  return (
    <div data-mailchimp-refused role="alertdialog" aria-modal="true" aria-labelledby="mcr-title" aria-describedby="mcr-body"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: T.surface.scrim }}>
      <div style={{ width: 'min(440px, 100%)', maxHeight: 'calc(100vh - 32px)', overflow: 'auto', background: T.surface.raised, borderRadius: '16px', boxShadow: T.shadow.overlay, padding: '22px 22px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <h2 id="mcr-title" style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary }}>Not sent to Mailchimp</h2>
        <div id="mcr-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px', lineHeight: 1.5, color: T.ink.secondary }}>
          {w.did && <p data-did style={{ color: T.ink.primary, fontWeight: 500 }}>{w.did}</p>}
          <p data-not-sent>{w.notSent} {w.why}</p>
          {w.todo && <p data-todo style={{ padding: '10px 12px', borderRadius: '10px', background: T.state.warning.bg, color: T.state.warning.deep }}>{w.todo}</p>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
          <button ref={ok} type="button" onClick={onClose} data-act="got-it"
            style={{ minHeight: '44px', padding: '0 20px', borderRadius: '10px', border: 'none', background: T.ink.primary, color: T.ink.inverse, fontSize: '14px', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Open the dialog on its own, on top of everything. Only when the answer is
 * a refusal; returns true when it opened. Closes only by "Got it".
 *   name   the person's name
 *   did    what DID happen, finishing "Pat Lee …": 'is in Nurturing',
 *          'was sent to Jobber', 'was added to Nurturing'
 *   result the Mailchimp answer ({ sent, outcome, words, flows })
 */
export function showMailchimpRefused({ name, did, result }) {
  if (!isMailchimpRefusal(result) || typeof document === 'undefined') return false
  const host = document.createElement('div')
  host.setAttribute('data-mailchimp-refused-host', '')
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = () => { root.unmount(); host.remove() }
  root.render(<MailchimpRefusedDialog name={name} did={did} result={result} onClose={close} />)
  return true
}
