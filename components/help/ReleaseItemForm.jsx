// components/help/ReleaseItemForm.jsx
// ─────────────────────────────────────────────────────────────
// The sheet for ONE line of the release note — and, in mode="summary",
// for the week's one-line summary. Bottom sheet on a phone, centred on a
// desktop (OverlayShell). 16px inputs so iOS never zooms; 46px buttons.
//
//   mode 'edit'     group / headline / sentence, with the ORIGINAL REPORT
//                   underneath as reference when the line was seeded from
//                   a feedback entry: what they wrote, and what we told
//                   them. Remove lives here, behind a one-tap confirm.
//   mode 'add'      the same fields, blank — for something that shipped
//                   with no report behind it.
//   mode 'summary'  one input for the week's summary line.
//
// Saving a line stamps edited_at on the server: it is now in Kevin's words
// and may publish. Nothing here touches the feedback entry.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import OverlayShell from '@/components/hive/OverlayShell'
import { T } from '@/components/hive/shared/tokens'
import { inp, lbl } from '@/components/hive/shared/formKit'
import { GROUP_ORDER, GROUP_LABEL, GROUP_EMOJI, RELEASE_LIMITS } from '@/lib/help-releases'
import { FEEDBACK_STATUS_PLAIN } from '@/lib/feedback-queues'

const btnPrimary = {
  minHeight: '46px', padding: '10px 18px', background: T.ink.primary, color: T.ink.inverse,
  border: 'none', borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const btnDanger = {
  minHeight: '44px', padding: '8px 14px', background: 'transparent', color: T.state.danger.strong,
  border: 'none', fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}

const TYPE_WORD = { bug: 'bug report', feature: 'idea', question: 'question' }
const NO_NAMES = 'No names in a broadcast — “a few of you asked” is as specific as it gets.'

export default function ReleaseItemForm({
  isMobile = false,
  mode = 'edit',          // 'edit' | 'add' | 'summary'
  item = null,            // the line being edited
  release = null,         // mode 'summary': the draft
  onClose,
  onSaved,                // (row, { removed?: boolean }) => void
}) {
  const [group, setGroup] = useState(item?.group || 'fixed')
  const [title, setTitle] = useState(item?.title || '')
  const [body, setBody]   = useState(item?.body || '')
  const [summary, setSummary] = useState(release?.summary || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const isSummary = mode === 'summary'
  const canSave = !saving && (isSummary || title.trim().length > 0)
  const source = item?.source || null

  async function save() {
    if (!canSave) return
    setSaving(true); setError(null)
    try {
      let res
      if (isSummary) {
        res = await fetch(`/api/help/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: summary.trim() }) })
      } else {
        const payload = { group, title: title.trim(), body: body.trim() }
        res = await fetch(mode === 'edit' ? `/api/help/releases/items/${item.id}` : '/api/help/releases/items', {
          method: mode === 'edit' ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      onSaved?.(data, {})
    } catch (err) {
      setError(err?.message || 'Couldn’t save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!item?.id || saving) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/help/releases/items/${item.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      onSaved?.(item, { removed: true })
    } catch (err) {
      setError(err?.message || 'Couldn’t remove it. Please try again.')
      setSaving(false)
    }
  }

  const heading = isSummary ? 'This week in one line' : mode === 'edit' ? 'Edit this line' : 'Add something that shipped'

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={560}>
      <div data-whatsnew-sheet={mode} style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '14px', fontFamily: '"DM Sans",system-ui,sans-serif' }}>
        <h2 style={{ fontFamily: 'Georgia,serif', fontSize: '20px', fontWeight: 600, color: T.ink.primary, margin: 0 }}>{heading}</h2>

        {isSummary ? (
          <div>
            <label style={lbl} htmlFor="wn-summary">Summary (optional)</label>
            <input id="wn-summary" value={summary} maxLength={RELEASE_LIMITS.summary} onChange={e => setSummary(e.target.value)} style={inp}
              placeholder="A quieter week — two fixes and a faster Inbox." autoFocus={!isMobile} />
          </div>
        ) : (
          <>
            <div>
              <span style={lbl}>What kind of change</span>
              <div role="radiogroup" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {GROUP_ORDER.map(g => {
                  const on = group === g
                  return (
                    <button key={g} type="button" role="radio" aria-checked={on} onClick={() => setGroup(g)} data-whatsnew-group-pick={g}
                      style={{ flex: '1 1 40%', minHeight: '46px', border: on ? `1px solid ${T.ink.primary}` : T.border.control, background: on ? T.ink.primary : T.surface.raised, color: on ? T.ink.inverse : T.ink.primary, borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>
                      {GROUP_EMOJI[g]} {GROUP_LABEL[g]}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <label style={lbl} htmlFor="wn-title">{group === 'question' ? 'The question, the way owners would ask it' : 'Headline — what changed, in plain words'}</label>
              <input id="wn-title" value={title} maxLength={RELEASE_LIMITS.title} onChange={e => setTitle(e.target.value)} style={inp}
                placeholder={group === 'question' ? 'Do archived Jobber quotes close the deal?' : 'Archiving a quote in Jobber closes the deal as Closed Lost.'} autoFocus={!isMobile} />
            </div>

            <div>
              <label style={lbl} htmlFor="wn-body">{group === 'question' ? 'The answer, short (needed for the Slack post)' : 'One sentence more (needed for the Slack post)'}</label>
              <textarea id="wn-body" value={body} maxLength={RELEASE_LIMITS.body} onChange={e => setBody(e.target.value)} rows={3} style={{ ...inp, resize: 'vertical', lineHeight: 1.5 }}
                placeholder={group === 'question' ? 'Yes — archive it in Jobber and the deal goes to Closed Lost on its own.' : 'No more moving it by hand — and the ones that were already stuck have been closed too.'} />
              {group === 'question' && <p style={{ fontSize: '12px', color: T.ink.quiet, margin: '6px 0 0', lineHeight: 1.45 }}>{NO_NAMES}</p>}
            </div>

            {source && (
              <div data-whatsnew-source style={{ background: T.surface.sunken, border: T.border.thin, borderRadius: T.radius.inset, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <p style={{ margin: 0, fontSize: '12px', fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', color: T.ink.muted }}>
                  The {TYPE_WORD[source.type] || 'report'} this came from · {group === 'question' ? FEEDBACK_STATUS_PLAIN.answered : FEEDBACK_STATUS_PLAIN.shipped}
                </p>
                <p style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: T.ink.primary, lineHeight: 1.4 }}>{source.title}</p>
                {source.description && <p style={{ margin: 0, fontSize: '13.5px', color: T.ink.secondary, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{source.description}</p>}
                {source.admin_response && (
                  <div style={{ borderLeft: `3px solid ${T.accent.fg}`, paddingLeft: '10px' }}>
                    <p style={{ margin: '0 0 2px', fontSize: '12px', color: T.ink.muted }}>What we told them</p>
                    <p style={{ margin: 0, fontSize: '13.5px', color: T.ink.secondary, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{source.admin_response}</p>
                  </div>
                )}
                <p style={{ margin: 0, fontSize: '12px', color: T.ink.quiet, lineHeight: 1.45 }}>Reference only. Nothing you write here changes their report, the reply, or the email they got.{group === 'question' ? ` ${NO_NAMES}` : ''}</p>
              </div>
            )}
          </>
        )}

        {error && <p style={{ fontSize: '13.5px', color: T.state.danger.strong, margin: 0 }}>{error}</p>}

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" onClick={save} disabled={!canSave} data-whatsnew-save style={{ ...btnPrimary, opacity: canSave ? 1 : 0.55, flex: isMobile ? 1 : 'none' }}>
            {saving ? 'Saving…' : isSummary ? 'Save' : mode === 'edit' ? 'Save line' : 'Add line'}
          </button>
          {mode === 'edit' && (
            confirmRemove ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', color: T.ink.muted, flexWrap: 'wrap' }}>
                Remove from the note? The report stays Fixed.
                <button type="button" onClick={remove} data-whatsnew-remove-confirm style={btnDanger} disabled={saving}>Yes, remove</button>
                <button type="button" onClick={() => setConfirmRemove(false)} style={{ ...btnDanger, color: T.ink.muted }}>No</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmRemove(true)} data-whatsnew-remove style={{ ...btnDanger, marginLeft: 'auto' }}>Remove</button>
            )
          )}
        </div>
      </div>
    </OverlayShell>
  )
}
