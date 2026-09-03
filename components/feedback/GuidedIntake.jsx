// components/feedback/GuidedIntake.jsx
// ─────────────────────────────────────────────────────────────
// The guided intake — design A. Replaces the one-title-one-box Submit form.
//
//   door     What is this? — Report a bug · Ask a question · Suggest a
//            feature. Skipped when the opener already chose (the Help ask
//            strip, the record menus).
//   1 · 2 · 3  one question per screen, the questions change with the type
//            (lib/feedback-intake.ts). Progress bar on every screen.
//   review   every answer read back with an Edit button, the context line,
//            attachments, then Send. Nobody sends a one-line report they
//            would not have accepted from someone else.
//
// WHERE THEY WERE IS NOT A QUESTION. The screen and the path come from the
// ambient context the mount already builds; the device is read here from
// the browser; the location is stamped server-side from hub_users. The form
// shows "Sent from Clients on an iPhone" as a line of context, and Bug
// question 3 asks only for what the app cannot know — a client name, a tab.
//
// WHAT LEAVES THIS COMPONENT is byte-for-byte what the old form sent: the
// same POST /api/feedback body keys (type, title, description, attachments,
// context), the same upload route first, and nothing else. No new send.
//
// THE KEYBOARD. Ankur's report (feedback ddc3afab): on an iPhone the
// keyboard covers the field you are typing in. Here the question sits at
// the TOP of the screen, the field directly under it, and the Next button
// directly under the field — in flow, never pinned to the bottom edge where
// the keyboard lands. On focus the field is scrolled into view inside the
// sheet, and the sheet itself is sized to the VISUAL viewport by the modal.
//
// Nothing here is named `top` — it is a browser global.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useRef, useEffect, useMemo } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { feedbackFmtBytes } from '@/components/feedback/feedbackShared'
import {
  INTAKE_DOORS, INTAKE_QUESTIONS, isIntakeType, composeDescription, missingAnswers, deviceLabel, contextSentence,
} from '@/lib/feedback-intake'

const FB_MAX_FILES = 5
const FB_MAX_BYTES = 10 * 1024 * 1024

const field = {
  width: '100%', padding: '12px 13px', border: T.border.control, borderRadius: T.radius.inset,
  fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised,
  outline: 'none', boxSizing: 'border-box', lineHeight: 1.5,
}
const primary = {
  minHeight: '48px', padding: '12px 20px', background: T.ink.primary, color: T.ink.inverse, border: 'none',
  borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 700, cursor: 'pointer',
}
const quiet = {
  minHeight: '48px', padding: '12px 16px', background: 'transparent', color: T.ink.secondary, border: 'none',
  fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const link = {
  minHeight: '44px', padding: '0 8px', background: 'transparent', border: 'none', color: T.accent.fg,
  fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}

function Progress({ step }) {
  // step: 1..3 = a question, 4 = review
  const label = step === 4 ? 'Review' : `Step ${step} of 3`
  return (
    <div data-intake-progress={step} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
      <div style={{ flex: 1, display: 'flex', gap: '4px' }}>
        {[1, 2, 3].map(i => (
          <div key={i} style={{ flex: 1, height: '4px', borderRadius: '2px', background: i <= Math.min(step, 3) ? T.accent.fg : T.hairline.line }} />
        ))}
      </div>
      <span style={{ fontSize: '12.5px', fontWeight: 600, color: T.ink.muted, whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  )
}

function ContextLine({ sentence }) {
  if (!sentence) return null
  return (
    <p data-intake-context style={{ margin: '0 0 14px', fontSize: '13px', color: T.ink.muted, display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span aria-hidden>📍</span> {sentence} <span style={{ color: T.ink.quiet }}>· we attach this for you</span>
    </p>
  )
}

export default function GuidedIntake({
  seed = null,             // { type?, title?, description?, about?, context? }
  ambientContext = null,   // where they were standing — from the mount
  onSubmitted,             // () => void, after a successful POST
}) {
  const seededType = isIntakeType(seed?.type) ? seed.type : null
  const [type, setType] = useState(seededType)
  const [answers, setAnswers] = useState({ q1: seed?.title || '', q2: seed?.description || '', q3: '' })
  // 0 = door, 1..3 = questions, 4 = review
  const [step, setStep] = useState(seededType ? 1 : 0)
  const [returnToReview, setReturnToReview] = useState(false)
  const [files, setFiles] = useState([])
  const [uploadProgress, setUploadProgress] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [touched, setTouched] = useState(false)
  const fileInputRef = useRef(null)
  const fieldRef = useRef(null)

  const device = useMemo(() => (typeof navigator === 'undefined' ? null : deviceLabel(navigator.userAgent, navigator.maxTouchPoints)), [])
  // Context = ambient UNDER seed, device in between: the seed (what they
  // pointed at) wins every collision, the same rule as before. The device is
  // new, and only written when the browser can be placed.
  const context = useMemo(() => ({ ...(ambientContext || {}), ...(device ? { device } : {}), ...(seed?.context || {}) }), [ambientContext, device, seed])
  const sentence = contextSentence({ screen: context.screen, device: context.device })

  const questions = type ? INTAKE_QUESTIONS[type] : []
  const q = step >= 1 && step <= 3 ? questions[step - 1] : null

  // Focus the field on every question screen and pull it into view — the
  // keyboard rises after focus, so the nudge waits for it.
  useEffect(() => {
    if (!q || !fieldRef.current) return
    const el = fieldRef.current
    try { el.focus({ preventScroll: true }) } catch { /* older browsers */ }
    const t = setTimeout(() => {
      try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch { /* jsdom */ }
    }, 250)
    return () => clearTimeout(t)
  }, [step, q])

  function setAnswer(key, value) { setAnswers(a => ({ ...a, [key]: value })) }

  function next() {
    if (!q) return
    const value = String(answers[q.key] || '').trim()
    if (!q.optional && !value) { setTouched(true); return }
    setTouched(false)
    setError(null)
    if (returnToReview) { setReturnToReview(false); setStep(4); return }
    setStep(step + 1)
  }
  function back() {
    setTouched(false)
    if (returnToReview) { setReturnToReview(false); setStep(4); return }
    setStep(Math.max(seededType ? 1 : 0, step - 1))
  }
  function edit(n) { setReturnToReview(true); setStep(n) }
  function chooseType(t) { setType(t); setStep(1); setTouched(false) }

  function onPickFiles(e) {
    const picked = Array.from(e.target.files || [])
    e.target.value = ''
    if (picked.length === 0) return
    setError(null)
    setFiles(prev => {
      const list = [...prev]
      for (const file of picked) {
        if (list.length >= FB_MAX_FILES) { setError(`You can attach up to ${FB_MAX_FILES} files.`); break }
        if (file.size > FB_MAX_BYTES) { setError(`"${file.name}" is larger than 10MB and was skipped.`); continue }
        const entry = { id: `${file.name}-${file.size}-${file.lastModified}-${list.length}`, file, preview: null }
        list.push(entry)
        if (file.type && file.type.startsWith('image/')) {
          const reader = new FileReader()
          reader.onload = () => setFiles(cur => cur.map(f => f.id === entry.id ? { ...f, preview: reader.result } : f))
          reader.readAsDataURL(file)
        }
      }
      return list
    })
  }
  const removeFile = (id) => setFiles(prev => prev.filter(f => f.id !== id))

  const attachControl = (
    <div>
      <input ref={fileInputRef} type="file" multiple accept="image/*,video/*,.pdf" onChange={onPickFiles} style={{ display: 'none' }} />
      <button type="button" onClick={() => fileInputRef.current && fileInputRef.current.click()} disabled={files.length >= FB_MAX_FILES || submitting}
        className="bee-small-action"
        style={{ minHeight: '40px', padding: '8px 14px', borderRadius: T.radius.inset, border: T.border.dashed, background: T.surface.raised, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, color: files.length >= FB_MAX_FILES ? T.ink.quiet : T.ink.primary }}>
        📎 {files.length === 0 ? 'Add a screenshot' : files.length >= FB_MAX_FILES ? 'Maximum 5 files' : 'Add another'}
      </button>
      {files.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
          {files.map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', border: T.border.thin, borderRadius: T.radius.inset, background: T.surface.raised }}>
              {f.preview
                ? <img src={f.preview} alt="" style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '6px', flexShrink: 0 }} />
                : <span style={{ width: '40px', height: '40px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', background: T.surface.sunken, borderRadius: '6px', flexShrink: 0 }}>📄</span>}
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file.name}</p>
                <p style={{ margin: 0, fontSize: '11px', color: T.ink.quiet }}>{feedbackFmtBytes(f.file.size)}</p>
              </div>
              <button type="button" onClick={() => removeFile(f.id)} disabled={submitting} aria-label={`Remove ${f.file.name}`} style={{ ...quiet, minHeight: '44px', width: '44px', fontSize: '20px', padding: 0 }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  async function send() {
    if (!type || submitting) return
    const missing = missingAnswers(type, answers)
    if (missing.length) { edit(Number(missing[0].slice(1))); setTouched(true); return }
    setSubmitting(true)
    setError(null)
    try {
      const uploaded = []
      for (let i = 0; i < files.length; i++) {
        setUploadProgress(`Uploading ${i + 1} of ${files.length}…`)
        const fd = new FormData()
        fd.append('file', files[i].file)
        const upRes = await fetch('/api/feedback/upload', { method: 'POST', body: fd })
        if (!upRes.ok) {
          const err = await upRes.json().catch(() => ({}))
          throw new Error(err.detail || err.error || `Upload failed (${upRes.status})`)
        }
        uploaded.push(await upRes.json())
      }
      setUploadProgress(null)
      const hasContext = Object.keys(context).length > 0
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          title: String(answers.q1 || '').trim(),
          description: composeDescription(type, answers, seed?.about),
          attachments: uploaded,
          ...(hasContext ? { context } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      onSubmitted?.()
    } catch (e) {
      setError(e?.message ? `Could not send — ${e.message}` : 'Could not send — please try again.')
    } finally {
      setUploadProgress(null)
      setSubmitting(false)
    }
  }

  // ── the door ──
  if (step === 0) {
    return (
      <div data-intake-step="door" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <p style={{ margin: '0 0 4px', fontFamily: 'Georgia,serif', fontSize: '20px', fontWeight: 600, color: T.ink.primary }}>What is this?</p>
        <ContextLine sentence={sentence} />
        {INTAKE_DOORS.map(d => (
          <button key={d.type} type="button" onClick={() => chooseType(d.type)} data-intake-door={d.type}
            style={{ display: 'flex', alignItems: 'center', gap: '14px', textAlign: 'left', minHeight: '64px', padding: '12px 16px', background: T.surface.raised, border: T.border.card, borderRadius: T.radius.inset, cursor: 'pointer', fontFamily: 'inherit' }}>
            <span style={{ fontSize: '24px', flexShrink: 0 }}>{d.icon}</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontWeight: 700, color: T.ink.primary }}>{d.label}</span>
              <span style={{ display: 'block', fontSize: '13px', color: T.ink.muted }}>{d.blurb}</span>
            </span>
          </button>
        ))}
      </div>
    )
  }

  // ── a question ──
  if (q) {
    const value = answers[q.key] || ''
    const missing = touched && !q.optional && !value.trim()
    const isLast = step === 3
    return (
      <div data-intake-step={step} data-intake-type={type}>
        <Progress step={step} />
        {step === 1 && <ContextLine sentence={sentence} />}
        <label htmlFor={`intake-${q.key}`} style={{ display: 'block', fontFamily: 'Georgia,serif', fontSize: '20px', fontWeight: 600, color: T.ink.primary, lineHeight: 1.3, marginBottom: '4px' }}>
          {q.prompt}
        </label>
        {q.hint && <p style={{ margin: '0 0 12px', fontSize: '13.5px', color: T.ink.muted, lineHeight: 1.45 }}>{q.hint}</p>}
        {q.kind === 'line' ? (
          <input ref={fieldRef} id={`intake-${q.key}`} data-intake-field={q.key} value={value} maxLength={q.maxLength}
            onChange={e => setAnswer(q.key, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); next() } }}
            placeholder={q.placeholder} style={{ ...field, borderColor: missing ? T.state.danger.strong : undefined }} enterKeyHint="next" />
        ) : (
          <textarea ref={fieldRef} id={`intake-${q.key}`} data-intake-field={q.key} value={value} maxLength={q.maxLength} rows={5}
            onChange={e => setAnswer(q.key, e.target.value)} placeholder={q.placeholder}
            style={{ ...field, resize: 'vertical', borderColor: missing ? T.state.danger.strong : undefined }} />
        )}
        <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: value.length > q.maxLength - 50 ? T.state.danger.strong : T.ink.quiet, textAlign: 'right' }}>{value.length}/{q.maxLength}</p>
        {missing && <p data-intake-missing style={{ margin: '4px 0 0', fontSize: '13px', color: T.state.danger.strong }}>This one we need — a line is enough.</p>}
        {q.screenshot && <div style={{ marginTop: '12px' }}>{attachControl}</div>}
        {error && <p style={{ fontSize: '13px', color: T.state.danger.strong }}>{error}</p>}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
          <button type="button" onClick={next} data-intake-next style={{ ...primary, flex: '1 1 160px' }}>
            {q.optional && !value.trim() ? 'Skip' : (isLast || returnToReview) ? 'Review' : 'Next'}
          </button>
          {(step > 1 || !seededType || returnToReview) && (
            <button type="button" onClick={back} data-intake-back style={quiet}>{returnToReview ? 'Back to review' : 'Back'}</button>
          )}
        </div>
      </div>
    )
  }

  // ── review ──
  const door = INTAKE_DOORS.find(d => d.type === type)
  return (
    <div data-intake-step="review" data-intake-type={type}>
      <Progress step={4} />
      <p style={{ margin: '0 0 4px', fontFamily: 'Georgia,serif', fontSize: '20px', fontWeight: 600, color: T.ink.primary }}>Read it back</p>
      <p style={{ margin: '0 0 14px', fontSize: '13.5px', color: T.ink.muted, lineHeight: 1.45 }}>
        Would this be enough if someone sent it to you? Tap Edit on anything that isn’t.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '13.5px', color: T.ink.secondary }}>
        <span>{door?.icon} <b>{door?.label}</b></span>
        {!seededType && <button type="button" onClick={() => setStep(0)} style={link} className="bee-small-action">Change</button>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {questions.map((qq, i) => {
          const a = String(answers[qq.key] || '').trim()
          return (
            <div key={qq.key} data-intake-review={qq.key} style={{ background: T.surface.sunken, border: T.border.thin, borderRadius: T.radius.inset, padding: '10px 12px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: '0 0 2px', fontSize: '12px', fontWeight: 600, color: T.ink.muted }}>{qq.prompt}</p>
                <p style={{ margin: 0, fontSize: '15px', color: a ? T.ink.primary : T.ink.quiet, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontStyle: a ? 'normal' : 'italic' }}>
                  {a || (qq.optional ? 'Skipped' : 'Not answered yet')}
                </p>
              </div>
              <button type="button" onClick={() => edit(i + 1)} aria-label={`Edit: ${qq.prompt}`} style={link} className="bee-small-action">Edit</button>
            </div>
          )
        })}
      </div>
      <div style={{ marginTop: '14px' }}>
        <ContextLine sentence={sentence} />
        {seed?.about && <p style={{ margin: '-6px 0 12px', fontSize: '13px', color: T.ink.muted }}>About: {seed.about}</p>}
        {attachControl}
      </div>
      {error && <p style={{ fontSize: '13px', color: T.state.danger.strong }}>{error}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px' }}>
        <button type="button" onClick={send} disabled={submitting} data-intake-send style={{ ...primary, flex: '1 1 160px', opacity: submitting ? 0.6 : 1 }}>
          {uploadProgress ? uploadProgress : submitting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
