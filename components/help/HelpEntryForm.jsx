// components/help/HelpEntryForm.jsx
// ─────────────────────────────────────────────────────────────
// The ONE add/edit form for a section, a topic or an item. Bottom sheet on
// a phone, centred dialog on a desktop — OverlayShell, the same chrome every
// other overlay wears. Kevin writes these at night on a phone, so:
//   · inputs are 16px (formKit.inp) — iOS never zooms
//   · steps are ONE textarea, a step per line — not N fields to tap into
//   · a video or screenshot is one tap: the file picker offers the camera
//     roll or a fresh recording, and the upload runs while he keeps typing
//   · Save as draft and Publish are both one tap, side by side
//
// Only ever mounted for editors (super_admin / corporate); the server
// refuses everyone else regardless (tests pin both).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useRef } from 'react'
import OverlayShell from '@/components/hive/OverlayShell'
import { T } from '@/components/hive/shared/tokens'
import { inp, lbl } from '@/components/hive/shared/formKit'
import { uploadHelpMedia } from '@/components/help/helpMedia'
import { HELP_LIMITS } from '@/lib/help-content'

const KIND_WORD = { section: 'section', topic: 'topic', item: 'item' }

const btnPrimary = {
  minHeight: '46px', padding: '10px 18px', background: T.ink.primary, color: T.ink.inverse,
  border: 'none', borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const btnQuiet = {
  minHeight: '46px', padding: '10px 16px', background: T.surface.raised, color: T.ink.primary,
  border: T.border.control, borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const btnDanger = {
  minHeight: '44px', padding: '8px 14px', background: 'transparent', color: T.state.danger.strong,
  border: 'none', fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}

export default function HelpEntryForm({
  isMobile = false,
  mode = 'add',          // 'add' | 'edit'
  kind = 'item',         // 'section' | 'topic' | 'item'
  parentId = null,
  entry = null,          // the row being edited
  breadcrumb = '',       // "Getting started › Connect Jobber"
  onClose,
  onSaved,               // (row, { deleted?: boolean }) => void
}) {
  const [title, setTitle]     = useState(entry?.title || '')
  const [icon, setIcon]       = useState(entry?.icon || '')
  const [lead, setLead]       = useState(entry?.lead || '')
  const [steps, setSteps]     = useState(Array.isArray(entry?.steps) ? entry.steps.join('\n') : '')
  const [callout, setCallout] = useState(entry?.callout || '')
  const [media, setMedia]     = useState(entry?.media_path ? { path: entry.media_path, kind: entry.media_kind, publicUrl: entry.media_url || null } : null)
  const [uploadStatus, setUploadStatus] = useState(null)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const videoInput = useRef(null)
  const imageInput = useRef(null)

  const isItem = kind === 'item'
  const canSave = title.trim().length > 0 && !saving && !uploadStatus

  async function pick(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      const result = await uploadHelpMedia(file, { onStatus: setUploadStatus })
      setMedia(result)
    } catch (err) {
      setError(err?.message || 'The upload didn’t finish. Please try again.')
    } finally {
      setUploadStatus(null)
    }
  }

  async function save(status) {
    if (!canSave) return
    setSaving(true)
    setError(null)
    const body = {
      kind, parent_id: parentId ?? entry?.parent_id ?? null,
      title: title.trim(),
      icon: kind === 'section' ? icon.trim() : null,
      lead: isItem ? lead.trim() : null,
      media_kind: isItem && media ? media.kind : null,
      media_path: isItem && media ? media.path : null,
      steps: isItem ? steps : [],
      callout: isItem ? callout.trim() : null,
      status: isItem ? status : 'published',
    }
    try {
      const res = await fetch(mode === 'edit' ? `/api/help/entries/${entry.id}` : '/api/help/entries', {
        method: mode === 'edit' ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
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
    if (!entry?.id || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/help/entries/${entry.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      onSaved?.(entry, { deleted: true })
    } catch (err) {
      setError(err?.message || 'Couldn’t delete. Please try again.')
      setSaving(false)
    }
  }

  const heading = `${mode === 'edit' ? 'Edit' : 'Add'} ${KIND_WORD[kind]}`

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={560}>
      <div style={{ padding: isMobile ? '0 16px 28px' : '0 24px 24px', display: 'flex', flexDirection: 'column', gap: '14px', fontFamily: '"DM Sans",system-ui,sans-serif' }}>
        <div>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: '20px', fontWeight: 600, color: T.ink.primary, margin: 0 }}>{heading}</h2>
          {breadcrumb && <p style={{ fontSize: '13px', color: T.ink.muted, margin: '3px 0 0' }}>{breadcrumb}</p>}
        </div>

        <div>
          <label style={lbl} htmlFor="help-title">Title</label>
          <input id="help-title" value={title} maxLength={HELP_LIMITS.title} onChange={e => setTitle(e.target.value)} style={inp}
            placeholder={isItem ? 'Turn on lead alerts' : kind === 'topic' ? 'Connecting Jobber' : 'Getting started'} autoFocus={!isMobile} />
        </div>

        {kind === 'section' && (
          <div>
            <label style={lbl} htmlFor="help-icon">Icon (one emoji, optional)</label>
            <input id="help-icon" value={icon} maxLength={HELP_LIMITS.icon} onChange={e => setIcon(e.target.value)} style={{ ...inp, width: '90px' }} placeholder="🚀" />
          </div>
        )}

        {isItem && (
          <>
            <div>
              <label style={lbl} htmlFor="help-lead">One line on what this does</label>
              <input id="help-lead" value={lead} maxLength={HELP_LIMITS.lead} onChange={e => setLead(e.target.value)} style={inp} placeholder="Get a text the moment a new lead lands." />
            </div>

            <div>
              <span style={lbl}>Video or screenshot</span>
              <input ref={videoInput} type="file" accept="video/*" onChange={pick} style={{ display: 'none' }} data-testid="help-video-input" />
              <input ref={imageInput} type="file" accept="image/*" onChange={pick} style={{ display: 'none' }} data-testid="help-image-input" />
              {media ? (
                <div style={{ border: T.border.thin, borderRadius: T.radius.inset, padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {media.kind === 'video'
                    ? (media.publicUrl ? <video src={media.publicUrl} controls playsInline preload="metadata" style={{ width: '100%', borderRadius: '8px', background: '#000' }} /> : <p style={{ margin: 0, fontSize: '13px', color: T.ink.muted }}>Video attached.</p>)
                    : (media.publicUrl ? <img src={media.publicUrl} alt="" style={{ width: '100%', borderRadius: '8px', border: T.border.thin }} /> : <p style={{ margin: 0, fontSize: '13px', color: T.ink.muted }}>Screenshot attached.</p>)}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => (media.kind === 'video' ? videoInput : imageInput).current?.click()} style={btnQuiet} disabled={!!uploadStatus}>Replace</button>
                    <button type="button" onClick={() => setMedia(null)} style={btnDanger} disabled={!!uploadStatus}>Remove</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => videoInput.current?.click()} style={btnQuiet} disabled={!!uploadStatus}>🎥 Add video</button>
                  <button type="button" onClick={() => imageInput.current?.click()} style={btnQuiet} disabled={!!uploadStatus}>🖼️ Add screenshot</button>
                </div>
              )}
              {uploadStatus && <p style={{ fontSize: '13px', color: T.ink.muted, margin: '6px 0 0' }}>{uploadStatus}</p>}
              <p style={{ fontSize: '12px', color: T.ink.quiet, margin: '6px 0 0', lineHeight: 1.45 }}>Video up to two minutes and 100 MB. Screenshot up to 10 MB. One or the other — a short clip beats a long one.</p>
            </div>

            <div>
              <label style={lbl} htmlFor="help-steps">Steps — one per line</label>
              <textarea id="help-steps" value={steps} onChange={e => setSteps(e.target.value)} rows={6} style={{ ...inp, resize: 'vertical', lineHeight: 1.5 }}
                placeholder={'Open Settings\nTap Notifications\nTurn on Text me for new leads'} />
            </div>

            <div>
              <label style={lbl} htmlFor="help-callout">The thing people get wrong (optional)</label>
              <textarea id="help-callout" value={callout} maxLength={HELP_LIMITS.callout} onChange={e => setCallout(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical', lineHeight: 1.5 }}
                placeholder="Alerts only go to the person the lead is assigned to." />
            </div>
          </>
        )}

        {error && <p style={{ fontSize: '13.5px', color: T.state.danger.strong, margin: 0 }}>{error}</p>}

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {isItem ? (
            <>
              <button type="button" onClick={() => save('published')} disabled={!canSave} style={{ ...btnPrimary, opacity: canSave ? 1 : 0.55, flex: isMobile ? 1 : 'none' }}>
                {saving ? 'Saving…' : 'Publish'}
              </button>
              <button type="button" onClick={() => save('draft')} disabled={!canSave} style={{ ...btnQuiet, opacity: canSave ? 1 : 0.55, flex: isMobile ? 1 : 'none' }}>
                Save as draft
              </button>
            </>
          ) : (
            <button type="button" onClick={() => save('published')} disabled={!canSave} style={{ ...btnPrimary, opacity: canSave ? 1 : 0.55, flex: isMobile ? 1 : 'none' }}>
              {saving ? 'Saving…' : mode === 'edit' ? 'Save' : `Add ${KIND_WORD[kind]}`}
            </button>
          )}
          {mode === 'edit' && (
            confirmDelete ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', color: T.ink.muted }}>
                Delete? You can restore it later.
                <button type="button" onClick={remove} style={btnDanger} disabled={saving}>Yes, delete</button>
                <button type="button" onClick={() => setConfirmDelete(false)} style={{ ...btnDanger, color: T.ink.muted }}>No</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} style={{ ...btnDanger, marginLeft: 'auto' }}>Delete</button>
            )
          )}
        </div>
      </div>
    </OverlayShell>
  )
}
