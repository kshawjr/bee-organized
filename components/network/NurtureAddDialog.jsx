'use client'

// ADD TO NURTURING (FL-135, Kevin 2026-11-28).
//
// The Nurturing tab's Add comes back. The person goes straight into
// Nurturing: no 30-day wait. Name, email, phone, and two boxes, BOTH
// UNTICKED, separate so an owner can do one without the other:
//   · "Send to Mailchimp"       (only where Mailchimp is open)
//   · "Send the welcome email"  (Bee Hub's own greeting, in 24 hours)
// They are not an enquiry: no Inbox item, and the 35-day auto-close never
// touches them (the server, app/api/network/nurturing/add).
//
// SOMEONE ALREADY HERE (same email or phone at this location): the box says
// who, and offers to put THAT person in Nurturing instead. Never a second copy.
//
// It writes through one address: POST /api/network/nurturing/add.
// It closes by its own ✕, Cancel or Escape, never by a tap outside.

import React, { useEffect, useState } from 'react'
import { T, FONT } from '@/components/design/tokens'
import { mailchimpOpenFor } from '@/lib/mailchimp-rollout'

const S = '[data-nurture-add]'
const CSS = `
${S}{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(26,48,44,.35);font-family:${FONT.ui}}
${S} .xa-box{width:min(480px,100%);max-height:calc(100vh - 32px);overflow:auto;background:${T.card};border-radius:16px;border:1px solid ${T.border};padding:24px;display:grid;gap:16px;color:${T.primary}}
${S} .xa-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
${S} .xa-head h2{margin:0;font-size:22px;font-weight:300;line-height:1.25}
${S} .xa-head p{margin:4px 0 0;font-size:13px;color:${T.mutedFg}}
${S} .xa-x{min-width:44px;min-height:44px;border:0;background:none;font-size:22px;color:${T.mutedFg};cursor:pointer;border-radius:10px}
${S} .xa-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
${S} label.xa-f{display:grid;gap:6px;font-size:13px;font-weight:600}
${S} .xa-f input{min-height:44px;padding:0 12px;border:1px solid ${T.border};border-radius:10px;font:inherit;font-size:15px;font-weight:400;color:${T.foreground};background:${T.card}}
${S} .xa-f input:focus-visible{outline:2px solid ${T.sage};outline-offset:1px}
${S} .xa-box label.xa-check{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid ${T.border};border-radius:10px;cursor:pointer}
${S} .xa-check input{width:18px;height:18px;margin-top:2px;flex:none}
${S} .xa-check b{display:block;font-size:14px}
${S} .xa-check span{display:block;font-size:12px;color:${T.mutedFg};margin-top:2px}
${S} .xa-problem{padding:12px;border-radius:10px;background:${T.destructiveSoft};color:${T.destructive};font-size:13px}
${S} .xa-same{padding:12px;border-radius:10px;background:${T.warningSoft};color:${T.primary};font-size:13px;display:grid;gap:8px}
${S} .xa-foot{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
${S} .xa-btn{min-height:44px;padding:0 16px;border-radius:10px;font:inherit;font-size:14px!important;font-weight:700;cursor:pointer;border:1px solid ${T.border};background:${T.card};color:${T.primary}}
${S} .xa-btn[data-primary]{background:${T.primary};color:${T.primaryFg};border-color:${T.primary}}
${S} .xa-btn:disabled{opacity:.55;cursor:default}
@media (max-width:480px){ ${S} .xa-row{grid-template-columns:1fr} ${S} .xa-box{padding:18px} }
`

export default function NurtureAddDialog({ locationId, locationName = null, fetchImpl = null, onClose = () => {}, onAdded = () => {} }) {
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [sendMailchimp, setSendMailchimp] = useState(false)
  const [sendWelcome, setSendWelcome] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const [same, setSame] = useState(null) // { id, name }
  const mailchimpOpen = mailchimpOpenFor(locationId)
  const hasEmail = !!email.trim()

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  // The warning is about what was typed; typing something else clears it.
  useEffect(() => { setSame(null) }, [email, phone])

  async function save(existingId = null) {
    if (busy) return
    setBusy(true); setProblem(null)
    try {
      const res = await (fetchImpl || fetch)('/api/network/nurturing/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId, first_name: first, last_name: last, email, phone,
          send_mailchimp: mailchimpOpen && sendMailchimp, send_welcome: sendWelcome,
          ...(existingId ? { existing_id: existingId } : {}),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 409 && json?.person) { setSame(json.person); return }
      if (!res.ok) { setProblem(json?.words || 'That did not save. Nothing was changed. Try again.'); return }
      onAdded(json)
    } catch {
      setProblem('That did not save. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-nurture-add role="dialog" aria-modal="true" aria-labelledby="xa-title">
      <style>{CSS}</style>
      <div className="xa-box">
        <div className="xa-head">
          <div>
            <h2 id="xa-title">Add to Nurturing</h2>
            <p>{locationName ? `${locationName} · ` : ''}They go straight into Nurturing.</p>
          </div>
          <button type="button" className="xa-x" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
        </div>
        <div className="xa-row">
          <label className="xa-f">First name<input value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="off" data-field="first" /></label>
          <label className="xa-f">Last name<input value={last} onChange={(e) => setLast(e.target.value)} autoComplete="off" data-field="last" /></label>
        </div>
        <label className="xa-f">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" data-field="email" /></label>
        <label className="xa-f">Phone<input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" data-field="phone" /></label>

        {mailchimpOpen && (
          <label className="xa-check" data-box="mailchimp">
            <input type="checkbox" checked={sendMailchimp} disabled={busy || !hasEmail} onChange={(e) => setSendMailchimp(e.target.checked)} />
            <div><b>Send to Mailchimp</b><span>{hasEmail ? 'Adds them to your Mailchimp list.' : 'Needs an email address.'}</span></div>
          </label>
        )}
        <label className="xa-check" data-box="welcome">
          <input type="checkbox" checked={sendWelcome} disabled={busy || !hasEmail} onChange={(e) => setSendWelcome(e.target.checked)} />
          <div><b>Send the welcome email</b><span>{hasEmail ? 'Bee Hub’s own welcome, about 24 hours from now.' : 'Needs an email address.'}</span></div>
        </label>

        {same && (
          <div className="xa-same" role="alert" data-same>
            <div><b>{same.name}</b> is already in Bee Hub here, with this email or phone.</div>
            <div><button type="button" className="xa-btn" onClick={() => save(same.id)} disabled={busy} data-act="use-existing">Put {same.name} in Nurturing instead</button></div>
          </div>
        )}
        {problem && <div className="xa-problem" role="alert" data-problem>{problem}</div>}

        <div className="xa-foot">
          <button type="button" className="xa-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="xa-btn" data-primary onClick={() => save()} disabled={busy || !!same} data-act="add">{busy ? 'Adding…' : 'Add to Nurturing'}</button>
        </div>
      </div>
    </div>
  )
}
