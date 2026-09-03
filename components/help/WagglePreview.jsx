// components/help/WagglePreview.jsx
// ─────────────────────────────────────────────────────────────
// "Preview the Slack post." The Waggle, as it will land in
// #tech-updates-info, in a textarea Kevin can edit, and ONE button that
// posts it AND publishes the week to Help.
//
// WHAT WRITES THE TEXT: GET /api/help/releases/<id>/slack — the pure
// builder in lib/help-releases (buildWaggleMessage) over the draft's lines.
// Assembly, not authorship: every fact is a line Kevin edited; the header,
// one opener, the group headings and one closer are the only words that
// are not his, and "Different version" cycles the opener and closer.
// NO MODEL WRITES ANY OF IT.
//
// WHAT GETS SENT: the textarea, exactly. The publish route posts
// slack_text as given (falling back to the same builder only when the
// textarea is empty), so what he sees is what goes.
//
// A SLACK FAILURE DOES NOT LOSE THE WEEK. The route publishes first, posts
// second, and reports both. This sheet stays open on a failure with the
// text still in the box, so he can copy it into Slack by hand.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useCallback } from 'react'
import OverlayShell from '@/components/hive/OverlayShell'
import { T } from '@/components/hive/shared/tokens'
import { inp, lbl } from '@/components/hive/shared/formKit'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import { WAGGLE_CHANNEL } from '@/lib/help-releases'

const btnPrimary = {
  minHeight: '46px', padding: '10px 18px', background: T.ink.primary, color: T.ink.inverse,
  border: 'none', borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const btnQuiet = {
  minHeight: '46px', padding: '10px 16px', background: T.surface.raised, color: T.ink.primary,
  border: T.border.control, borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const btnLink = {
  minHeight: '44px', padding: '8px 6px', background: 'transparent', color: T.ink.muted,
  border: 'none', fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline',
}

export default function WagglePreview({ isMobile = false, release, onClose, onPublished }) {
  const [variant, setVariant] = useState(0)
  const [preview, setPreview] = useState(null) // { text, included, left_out, variants }
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(null) // { ok, message, tone }

  const load = useCallback(async (v) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/help/releases/${release.id}/slack?variant=${v}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setPreview(data)
      setText(data.text || '')
    } catch (err) { setError(err?.message || 'Couldn’t build the post. Please try again.') }
    finally { setLoading(false) }
  }, [release.id])
  useEffect(() => { load(variant) }, [load, variant])

  async function publish(postSlack) {
    if (busy) return
    setBusy(true); setError(null); setOutcome(null)
    try {
      const res = await fetch(`/api/help/releases/${release.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publish: true, post_slack: postSlack, slack_text: postSlack ? text : null, variant }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const left = data.left_out > 0
        ? ` ${data.left_out === 1 ? '1 line still in the owner’s words moved' : `${data.left_out} lines still in the owner’s words moved`} to next week’s draft.`
        : ''
      if (!postSlack) {
        setOutcome({ ok: true, tone: 'ok', message: `Published to Help.${left}` })
      } else if (data.slack?.posted) {
        setOutcome({ ok: true, tone: 'ok', message: `Published to Help and posted to ${WAGGLE_CHANNEL.name}.${left}` })
      } else {
        setOutcome({ ok: false, tone: 'bad', message: `Published to Help. The Slack post didn’t go: ${data.slack?.problem || 'unknown problem'} The text is still above — copy it into ${WAGGLE_CHANNEL.name} by hand.${left}` })
      }
      onPublished?.(data)
    } catch (err) {
      setError(err?.message || 'Couldn’t publish. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const published = !!outcome?.ok || (outcome && !outcome.ok) // either way the week is out
  const leftOut = preview?.left_out || []

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={620}>
      <div data-whatsnew-waggle style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '14px', fontFamily: '"DM Sans",system-ui,sans-serif' }}>
        <div>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: '20px', fontWeight: 600, color: T.ink.primary, margin: 0 }}>The Slack post</h2>
          <p style={{ fontSize: '13px', color: T.ink.muted, margin: '3px 0 0' }}>Goes to {WAGGLE_CHANNEL.name}. Edit anything below — what you see is what gets sent.</p>
        </div>

        {loading ? <BeeLoader label="Building the post…" /> : (
          <>
            <div>
              <label style={lbl} htmlFor="wn-slack-text">Message</label>
              <textarea id="wn-slack-text" data-whatsnew-slack-text value={text} onChange={e => setText(e.target.value)} rows={isMobile ? 12 : 14}
                disabled={!!published}
                style={{ ...inp, resize: 'vertical', lineHeight: 1.5, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: '16px' }} />
              <p style={{ fontSize: '12px', color: T.ink.quiet, margin: '6px 0 0', lineHeight: 1.45 }}>
                *stars* are bold in Slack. {preview ? `${preview.included} ${preview.included === 1 ? 'line' : 'lines'} in the post.` : ''}
              </p>
            </div>

            {leftOut.length > 0 && (
              <div data-whatsnew-left-out style={{ background: T.state.warning.bg, borderRadius: T.radius.control, padding: '10px 12px' }}>
                <p style={{ margin: '0 0 4px', fontSize: '13.5px', fontWeight: 600, color: T.state.warning.deep }}>
                  Left out of the post ({leftOut.length}):
                </p>
                <ul style={{ margin: 0, padding: '0 0 0 18px', fontSize: '13.5px', color: T.state.warning.deep, lineHeight: 1.5 }}>
                  {leftOut.map(l => (
                    <li key={l.id}>{l.title} <span style={{ opacity: 0.8 }}>· {l.reason === 'their_words' ? 'still in the owner’s words' : l.reason === 'over_cap' ? 'in Help, but the post takes three questions' : 'no sentence yet'}</span></li>
                  ))}
                </ul>
                <p style={{ margin: '6px 0 0', fontSize: '12.5px', color: T.state.warning.deep, lineHeight: 1.45 }}>
                  Lines still in the owner’s words also stay out of Help and move to next week’s draft. Lines with a headline but no sentence publish to Help and only skip the post.
                </p>
              </div>
            )}

            {error && <p style={{ fontSize: '13.5px', color: T.state.danger.strong, margin: 0 }}>{error}</p>}
            {outcome && (
              <p data-whatsnew-outcome data-tone={outcome.tone} style={{ fontSize: '14px', margin: 0, lineHeight: 1.5, color: outcome.tone === 'ok' ? T.family.green.text : T.state.danger.strong, background: outcome.tone === 'ok' ? T.family.green.bg : T.family.red.bg, padding: '10px 12px', borderRadius: T.radius.control }}>
                {outcome.message}
              </p>
            )}

            {!published ? (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="button" onClick={() => publish(true)} disabled={busy || !text.trim()} data-whatsnew-post
                  style={{ ...btnPrimary, opacity: busy || !text.trim() ? 0.55 : 1, flex: isMobile ? '1 1 100%' : 'none' }}>
                  {busy ? 'Posting…' : `Post to ${WAGGLE_CHANNEL.name} and publish`}
                </button>
                <button type="button" onClick={() => setVariant(v => v + 1)} disabled={busy} data-whatsnew-different style={btnQuiet}>
                  Different version
                </button>
                <button type="button" onClick={() => publish(false)} disabled={busy} data-whatsnew-publish-only style={{ ...btnLink, marginLeft: isMobile ? 0 : 'auto' }}>
                  Publish to Help only
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" onClick={onClose} style={{ ...btnPrimary, flex: isMobile ? 1 : 'none' }}>Done</button>
              </div>
            )}
          </>
        )}
      </div>
    </OverlayShell>
  )
}
