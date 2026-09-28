// components/hive/NewJobWizard.jsx
// ─────────────────────────────────────────────────────────────
// "Start a new job" — an existing client calls about more work. Kevin
// (2026-09-28): "Start in Bee Hub, not Jobber, so the conversation gets
// captured — what they want, when they called, what you said. Then it goes
// over to Jobber as a proper request."
//
// Reached from the client card's Engagements header (never the action bar,
// where the removed "+ New engagement" sat). Two steps:
//   1. THE JOB — what the work is (REQUIRED), which address (only when the
//      client has more than one), and what they said on the call.
//   2. SEND IT NOW OR LATER — two endings, each saying what it does:
//        · Send to Jobber now — founds the card, then opens THE Send to
//          Jobber window for this client with the card attached. Same
//          window, same route, same linked-client handling as every other
//          send; the request lands on the card rather than founding a
//          second one.
//        · Save — send to Jobber later — founds the card and stops. The
//          owner is told, at the moment of choosing, that this is a record
//          in Bee Hub only and needs sending to reach Jobber. The card then
//          reads "Not sent to Jobber" and carries its own Send to Jobber.
//
// WHY IT CANNOT MAKE THE 47 AGAIN. Those cards carried nothing — an auto
// title and no words — and looked like every other card. Here:
//   · the work must be described (describesTheWork, the SAME rule the route
//     and foundManualEngagement enforce — this screen is only the first of
//     three locks), so both endings stay disabled until it is;
//   · a card that has not reached Jobber says so, everywhere it shows.
//
// THIS COMPONENT WRITES ONE THING: POST /api/engagements. It hands the real
// returned row up through onFounded (never an optimistic stub) and leaves
// the send to the caller's onSendToJobber, exactly as the card's other sends.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useState } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import { inp, lbl } from './shared/formKit'
import { T } from './shared/tokens'
import { describesTheWork, WORK_MIN_CHARS } from './shared/engagementStatus'
import { buildAddressChoices, CURRENT_CHOICE_KEY } from '@/lib/address-choice'
import { IconSend, IconMapPin, IconClock } from '@/components/ui/icons'

const MODAL_WIDTH = 420

// The words at the moment of choosing (Kevin: "the wizard explains we will
// start a record but need to send it to Jobber for sync"). Exported so the
// test pins the exact copy the owner reads.
export const SAVE_LATER_EXPLAINER =
  'This starts a record of the job here in Bee Hub only. Nothing reaches Jobber until you send it — ' +
  'the card will say “Not sent to Jobber” and carry a Send to Jobber button until you do.'
export const SEND_NOW_EXPLAINER =
  'Starts the record here, then opens Send to Jobber for this client. What you wrote goes with the request.'
export const SAVED_TOAST = 'Saved on the card — not in Jobber yet. Send it from the card when you’re ready.'

const btnBase = {
  padding: '8px 15px', borderRadius: T.radius.control, border: 'none',
  fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', whiteSpace: 'nowrap',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
}
const ghostBtn = { ...btnBase, background: 'transparent', color: T.ink.muted, cursor: 'pointer' }
const primaryBtn = (enabled) => ({
  ...btnBase,
  background: enabled ? T.accent.fg : T.ink.disabled,
  color: enabled ? T.accent.onFill : T.ink.quiet,
  cursor: enabled ? 'pointer' : 'not-allowed',
})

// One ending: a full-width choice with its consequence written under it.
function Ending({ Icon, label, explainer, onChoose, disabled, primary, ...rest }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChoose}
      {...rest}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: '10px', width: '100%',
        padding: '11px 12px', textAlign: 'left', fontFamily: 'inherit',
        borderRadius: T.radius.control,
        border: primary ? `1px solid ${T.accent.fg}` : T.border.control,
        background: primary ? T.accent.soft : T.surface.raised,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ flexShrink: 0, marginTop: '1px', color: primary ? T.accent.fg : T.ink.muted }}><Icon size={16} /></span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: primary ? T.accent.deep : T.ink.primary }}>{label}</span>
        <span style={{ fontSize: '12px', color: T.ink.muted, lineHeight: 1.45 }}>{explainer}</span>
      </span>
    </button>
  )
}

export default function NewJobWizard({
  client,
  formerAddresses = [],
  openCount = 0,
  onClose = () => {},
  onFounded = () => {},
  onSendToJobber = null,
  setToast = () => {},
  readOnly = false,
}) {
  const isMobile = useIsMobile()
  const [step, setStep] = useState('job')
  const [work, setWork] = useState('')
  const [said, setSaid] = useState('')
  const [addressKey, setAddressKey] = useState(CURRENT_CHOICE_KEY)
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Same list the Send to Jobber window builds, from the same helper, so
  // the key chosen here names the same house there.
  const addressChoices = useMemo(() => buildAddressChoices(
    { address: client?.address || '', city: client?.city || '', state: client?.state || '', zip: client?.zip || '' },
    null,
    formerAddresses,
    client?.address_label,
    client?.address_label_note,
  ), [client?.address, client?.city, client?.state, client?.zip, client?.address_label, client?.address_label_note, formerAddresses])
  const multiAddress = addressChoices.length > 1
  const chosenAddress = addressChoices.find(c => c.key === addressKey) || addressChoices[0] || null

  const workOk = describesTheWork(work)

  // What the card carries: the work is its title; what they said is its
  // description, with the address they named on the end when there was a
  // choice to make — so a card saved for later still answers "which house?"
  // on the day someone sends it.
  function description() {
    const parts = [said.trim()]
    if (multiAddress && chosenAddress) parts.push(`Address: ${chosenAddress.display}`)
    return parts.filter(Boolean).join('\n\n') || null
  }

  async function found() {
    const res = await fetch('/api/engagements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: client.id, title: work.trim(), description: description() }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || !j?.engagement?.id) throw new Error(j?.message || j?.error || `HTTP ${res.status}`)
    return j.engagement
  }

  async function finish(sendNow) {
    if (busy || readOnly || !workOk) return
    setErrorMsg(null)
    setBusy(true)
    let row
    try {
      row = await found()
    } catch (e) {
      setErrorMsg(`Not saved: ${e.message}`)
      setBusy(false)
      return
    }
    onFounded(row)
    if (sendNow && onSendToJobber) {
      onSendToJobber(client.id, {
        engagementId: row.id,
        addressKey: multiAddress ? addressKey : null,
        savedCard: true,
      })
    } else {
      setToast({ kind: 'success', msg: SAVED_TOAST })
    }
    setBusy(false)
    onClose()
  }

  const name = client?.name || 'this client'

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={MODAL_WIDTH}>
      <div role="dialog" aria-modal="true" aria-label="Start a new job"
        style={{ padding: isMobile ? '0 16px 18px' : '0 24px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>
            Start a new job
          </h2>
          <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '4px' }}>
            {name} · {step === 'job' ? 'step 1 of 2 — the job' : 'step 2 of 2 — send it now or later'}
          </p>
        </div>

        {step === 'job' && (
          <>
            {openCount > 0 && (
              <p data-open-note="1" style={{ fontSize: '12px', color: T.family.amber.text, background: T.family.amber.bg, padding: '8px 12px', borderRadius: T.radius.control }}>
                {name} already has {openCount} open {openCount === 1 ? 'engagement' : 'engagements'}. This starts a separate one beside {openCount === 1 ? 'it' : 'them'}.
              </p>
            )}

            <div>
              <label style={lbl} htmlFor="new-job-work">What’s the work?</label>
              <input id="new-job-work" style={inp} value={work} maxLength={200} autoFocus
                onChange={e => setWork(e.target.value)}
                placeholder="e.g. Primary bedroom closet"
                aria-label="What’s the work?" />
              {!workOk && (
                <p data-work-hint="1" style={{ fontSize: '11px', color: T.ink.muted, marginTop: '5px' }}>
                  Required — a few words about the job (at least {WORK_MIN_CHARS} characters).
                </p>
              )}
            </div>

            {multiAddress && (
              <div>
                <label style={lbl}>Which address?</label>
                <div role="radiogroup" aria-label="Which address is this job for?" data-address-picker="1"
                  style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {addressChoices.map(c => (
                    <button key={c.key} type="button" role="radio" aria-checked={addressKey === c.key}
                      data-address-choice={c.key} onClick={() => setAddressKey(c.key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
                        padding: '9px 12px', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                        background: addressKey === c.key ? T.accent.soft : T.surface.raised,
                        border: `1px solid ${addressKey === c.key ? T.accent.fg : T.hairline.line}`,
                        borderRadius: T.radius.control,
                      }}>
                      <span style={{ flexShrink: 0, color: addressKey === c.key ? T.accent.fg : T.ink.muted }}><IconMapPin size={15} /></span>
                      <span style={{ fontSize: '13px', color: T.ink.primary, minWidth: 0, wordBreak: 'break-word' }}>{c.display}</span>
                      {c.isCurrent && (
                        <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: '10px', fontWeight: 600, color: T.ink.muted, background: T.surface.sunken, padding: '2px 7px', borderRadius: T.radius.pill }}>
                          Current
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label style={lbl} htmlFor="new-job-said">What did they say? · optional</label>
              <textarea id="new-job-said" style={{ ...inp, minHeight: '84px', resize: 'vertical', lineHeight: 1.4 }}
                value={said} maxLength={1800} onChange={e => setSaid(e.target.value)}
                placeholder="What they want, when they want it, what you told them"
                aria-label="What did they say?" />
            </div>

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose} style={ghostBtn}>Cancel</button>
              <button type="button" disabled={!workOk} onClick={() => workOk && setStep('finish')} style={primaryBtn(workOk)}>
                Continue →
              </button>
            </div>
          </>
        )}

        {step === 'finish' && (
          <>
            {/* The recap — exactly what the card will carry. */}
            <div data-recap="1" style={{ background: T.surface.sunken, borderRadius: T.radius.inset, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <p style={{ fontSize: '13px', fontWeight: 600, color: T.ink.primary, wordBreak: 'break-word' }}>{work.trim()}</p>
              {multiAddress && chosenAddress && (
                <p style={{ fontSize: '12px', color: T.ink.muted }}>{chosenAddress.display}</p>
              )}
              {said.trim() && (
                <p style={{ fontSize: '12px', color: T.ink.strong, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{said.trim()}</p>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {onSendToJobber && (
                <Ending primary Icon={IconSend} label="Send to Jobber now" explainer={SEND_NOW_EXPLAINER}
                  disabled={busy || readOnly || !workOk} onChoose={() => finish(true)} data-ending="send-now" />
              )}
              <Ending Icon={IconClock} label="Save — send to Jobber later" explainer={SAVE_LATER_EXPLAINER}
                disabled={busy || readOnly || !workOk} onChoose={() => finish(false)} data-ending="save-later" />
            </div>

            {errorMsg && (
              <p style={{ fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 12px', borderRadius: T.radius.control }}>{errorMsg}</p>
            )}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-start' }}>
              <button type="button" onClick={() => setStep('job')} style={ghostBtn} disabled={busy}>← Back</button>
            </div>
          </>
        )}
      </div>
    </OverlayShell>
  )
}
