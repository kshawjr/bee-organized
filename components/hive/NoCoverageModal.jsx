// components/hive/NoCoverageModal.jsx
// ─────────────────────────────────────────────────────────────
// The SECOND disposition for an unrouted lead, sibling to TransferLeadModal.
// Route says "this belongs to Boulder"; this says "nobody covers them" — we
// tell the person so, and offer a mailing-list link for when we do reach them.
//
// Same scaffold as its sibling, deliberately: OverlayShell owns the backdrop /
// centered-vs-sheet geometry / scroll-lock / X; this file owns the Esc
// listener, role="dialog", padding, and the submitting / errorMsg pattern.
// T.* tokens only — the beta-hive-tokens sweep fails on any raw hex/rgba,
// comments included.
//
// It is a CONFIRM, not a form: there is nothing to choose. So the body's whole
// job is showing the operator exactly what the person will receive before they
// commit — the real subject and the real body, built by the SAME pure module
// the send uses (lib/no-coverage-copy), so the preview cannot drift from the
// email. The link is shown as a placeholder because the real token doesn't
// exist until the endpoint mints it.
//
// KEVIN'S RULE, stated in the UI as plainly as it is in the endpoint: the lead
// is DISMISSED ON SEND, not on click. Corp has resolved it from their side;
// whether the person joins the list is their choice and doesn't hold the queue
// open. The primary button says so ("Send and dismiss") rather than leaving
// the second half of the action to be discovered afterward.
//
// A lead with no email address can't be sent to, so the action is refused HERE
// with an explanation rather than at the endpoint with a code — the endpoint
// still refuses it too (lead_has_no_email), this just says why first.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useMemo } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import { T } from './shared/tokens'
import { buildNoCoverageEmail } from '@/lib/no-coverage-copy'
import { IconMail, IconAlertTriangle, IconCheck } from '@/components/ui/icons'

const MODAL_WIDTH = 480

// Stand-in for the real opt-in URL. The token is minted server-side at send
// time and is the only key in the link, so there is nothing truthful to show
// here — a fake hex string would read as real.
const LINK_PLACEHOLDER = 'https://app.beeorganized.com/mailing-list/…'

// Compact button convention (same 8px 15px box as TransferLeadModal — there is
// no shared button module; this is the standing preference).
const btnBase = {
  padding: '8px 15px', borderRadius: T.radius.control, border: 'none',
  fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', whiteSpace: 'nowrap',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
}
const ghostBtn = { ...btnBase, background: 'transparent', color: T.ink.muted, cursor: 'pointer' }
// The CORPORATE sand, matching the Route pill this sits beside: both are
// corporate dispositions of a lead no location owns. Using the teal action
// accent here would put it in the family of controls that act on a lead the
// current location owns, which is the opposite of what this is.
const primaryBtn = (enabled) => ({
  ...btnBase,
  background: enabled ? T.corp.fill : T.ink.disabled,
  color: enabled ? T.corp.onFill : T.ink.quiet,
  cursor: enabled ? 'pointer' : 'not-allowed',
})

// person: { id, name, email, firstName, city, state }; subline: pre-composed
// origin string; onDone(result): success handler — the caller closes + removes
// the row (and ONLY when the endpoint actually dismissed it).
export default function NoCoverageModal({ person, subline = null, onDone = () => {}, onClose = () => {} }) {
  const isMobile = useIsMobile()
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  // Esc closes — self-owned (OverlayShell doesn't).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const to = (person?.email || '').trim()
  const canSend = !!to && !submitting

  // The preview. Same builder the server sends with — see the header note.
  const areaLabel = useMemo(() => {
    const parts = [person?.city, person?.state].map(s => (s || '').trim()).filter(Boolean)
    return parts.length ? parts.join(', ') : null
  }, [person])
  const preview = useMemo(() => buildNoCoverageEmail({
    optInUrl: LINK_PLACEHOLDER,
    firstName: person?.firstName || (person?.name || '').trim().split(/\s+/)[0] || null,
    areaLabel,
  }), [person, areaLabel])

  async function confirm() {
    if (!canSend) return
    setErrorMsg(null)
    setSubmitting(true)
    let json
    try {
      const res = await fetch(`/api/leads/${person.id}/no-coverage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      json = await res.json().catch(() => ({}))
      if (!res.ok || !json || json.success !== true) {
        setErrorMsg((json && json.error) ? json.error : `Send failed (HTTP ${res.status})`)
        setSubmitting(false)
        return
      }
    } catch (e) {
      setErrorMsg('Network error — please try again')
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    // Hand the WHOLE result up. `dismissed` may be false — the email went out
    // but the dismiss write didn't land — and in that case the caller must
    // leave the row where it is rather than optimistically removing it.
    onDone(json)
  }

  const head = [person?.name, subline].filter(Boolean).join(' · ')

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={MODAL_WIDTH}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="No coverage"
        style={{ padding: isMobile ? '0 16px 18px' : '0 24px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}
      >
        {/* Header */}
        <div>
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>
            No coverage
          </h2>
          {head && (
            <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '3px' }}>{head}</p>
          )}
        </div>

        {/* What this does — stated before the preview, because the second half
            (the lead leaves the queue) isn't visible in the email itself. */}
        <div style={{ display: 'flex', gap: '9px', padding: '10px 12px', background: T.corp.bg, border: `1px solid ${T.corp.border}`, borderRadius: T.radius.control }}>
          <span style={{ color: T.corp.fg, flexShrink: 0, marginTop: '1px', display: 'inline-flex' }}><IconMail size={15} /></span>
          <p style={{ fontSize: '12px', color: T.corp.deep, lineHeight: 1.45 }}>
            Emails {to || 'this lead'} from Bee Organized to say we don&apos;t serve {areaLabel || 'their area'} yet,
            with a link to join the mailing list. <strong>The lead leaves this queue as soon as the email sends</strong> —
            joining the list is their choice and won&apos;t hold it open.
          </p>
        </div>

        {/* No address, no action. */}
        {!to && (
          <div style={{ display: 'flex', gap: '9px', padding: '10px 12px', background: T.state.warning.bg, border: `1px solid ${T.state.warning.soft}`, borderRadius: T.radius.control }}>
            <span style={{ color: T.state.warning.fg, flexShrink: 0, marginTop: '1px', display: 'inline-flex' }}><IconAlertTriangle size={15} /></span>
            <p style={{ fontSize: '12px', color: T.state.warning.deep, lineHeight: 1.45 }}>
              This lead has no email address, so there&apos;s nothing to send. Route it instead, or reach them another way.
            </p>
          </div>
        )}

        {/* The preview — the real subject and the real body. */}
        {to && (
          <div>
            <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase', color: T.ink.quiet, marginBottom: '6px' }}>
              What they&apos;ll receive
            </p>
            <div style={{ border: T.border.control, borderRadius: T.radius.control, background: T.surface.raised, overflow: 'hidden' }}>
              <div style={{ padding: '9px 11px', borderBottom: T.border.divider }}>
                <p style={{ fontSize: '11px', color: T.ink.quiet }}>To</p>
                <p style={{ fontSize: '12.5px', color: T.ink.primary, wordBreak: 'break-word' }}>{to}</p>
                <p style={{ fontSize: '11px', color: T.ink.quiet, marginTop: '6px' }}>Subject</p>
                <p style={{ fontSize: '12.5px', fontWeight: 600, color: T.ink.primary }}>{preview.subject}</p>
              </div>
              <div
                data-bee-no-coverage-preview
                style={{
                  padding: '10px 11px', maxHeight: '190px', overflowY: 'auto',
                  fontSize: '12px', lineHeight: 1.5, color: T.ink.secondary,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}
              >
                {preview.text}
              </div>
            </div>
          </div>
        )}

        {/* Error banner (mirrors TransferLeadModal / SendToJobberModal) */}
        {errorMsg && (
          <div style={{ padding: '10px 12px', background: T.state.danger.soft, border: `1px solid ${T.state.danger.strong}`, borderRadius: T.radius.control }}>
            <p style={{ fontSize: '12px', fontWeight: 600, color: T.state.danger.strong, marginBottom: '2px' }}>Couldn&apos;t send</p>
            <p style={{ fontSize: '12px', color: T.state.danger.fg, wordBreak: 'break-word' }}>{errorMsg}</p>
            {/* The endpoint sends BEFORE it dismisses, so a failure here always
                leaves the lead exactly where it was. Say so — otherwise the
                operator has to guess whether they half-did something. */}
            <p style={{ fontSize: '11.5px', color: T.state.danger.fg, marginTop: '4px' }}>
              Nothing was sent and the lead is still in the queue. You can try again.
            </p>
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button type="button" style={ghostBtn} onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" style={primaryBtn(canSend)} onClick={confirm} disabled={!canSend}>
            {submitting ? 'Sending…' : (<><IconCheck size={13} /> Send and dismiss</>)}
          </button>
        </div>
      </div>
    </OverlayShell>
  )
}
