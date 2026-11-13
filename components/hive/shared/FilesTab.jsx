// components/hive/shared/FilesTab.jsx
// ─────────────────────────────────────────────────────────────
// The Files tab — on the client card (every file the client has) and on a job
// (the files pinned to that job). Until 13 Nov 2026 both were four lines of
// dashed box reading "No files yet — quotes, photos, and attachments will
// land here", which promised files would arrive by themselves. Nothing ever
// did: there was no upload.
//
// TWO PIECES, so the tab's COUNT can be the real number:
//   useClientFiles(…)  — the list, and add / remove. Called by the card
//                        itself, so the number on the tab is the length of
//                        the very list the tab shows. It cannot disagree.
//   <FilesTab …/>      — draws it.
//
// The rules (what may be added, how big, who may remove) are
// lib/client-files.ts, shared with the server. The server is the real guard:
// everything here that hides a button is a courtesy.
//
// A file opens at /api/client-files/<id>. That address only answers a
// signed-in person who can see this client; it is not a link that works for
// anyone else.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { T } from './tokens'
import { quietBtn } from './cardKit'
import { IconPaperclip, IconFileText, IconPlus, IconAlertTriangle } from '@/components/ui/icons'
import { FILE_PICKER_ACCEPT, MAX_FILE_BYTES, WORDS, fileSizeWords, isPhotoType } from '@/lib/client-files'
import { prepareForUpload } from './photoPrep'

const fileUrl = (id, extra = '') => `/api/client-files/${id}${extra}`

const dayWords = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

let localSeq = 0

/**
 * @param leadId        the client. Nothing loads until there is one.
 * @param engagementId  when set: only this job's files, and anything added is
 *                      pinned to this job.
 */
export function useClientFiles({ leadId, engagementId = null, prepare = prepareForUpload }) {
  const [files, setFiles] = useState(null) // null = not loaded yet
  const [notReady, setNotReady] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [uploads, setUploads] = useState([]) // { key, name, status: 'sending' | 'failed', reason, file }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    if (!leadId) return
    setLoadError(false)
    try {
      const qs = `lead_id=${encodeURIComponent(leadId)}${engagementId ? `&engagement_id=${encodeURIComponent(engagementId)}` : ''}`
      const res = await fetch(`/api/client-files?${qs}`)
      const body = await res.json().catch(() => ({}))
      if (!alive.current) return
      if (!res.ok) { setLoadError(true); return }
      setNotReady(!!body.not_ready)
      setFiles(Array.isArray(body.files) ? body.files : [])
    } catch {
      if (alive.current) setLoadError(true)
    }
  }, [leadId, engagementId])

  useEffect(() => { setFiles(null); setUploads([]); load() }, [load])

  const sendOne = useCallback(async (key, file) => {
    const fail = (reason) => {
      if (alive.current) setUploads(u => u.map(x => (x.key === key ? { ...x, status: 'failed', reason } : x)))
    }
    try {
      const ready = await prepare(file)
      if (!ready.file || ready.file.size === 0) return fail(WORDS.empty)
      if (ready.file.size > MAX_FILE_BYTES) return fail(WORDS.tooBig)
      const form = new FormData()
      form.append('lead_id', leadId)
      if (engagementId) form.append('engagement_id', engagementId)
      form.append('file', ready.file, ready.name || file.name)
      if (ready.thumb) form.append('thumb', ready.thumb, 'preview.jpg')
      const res = await fetch('/api/client-files', { method: 'POST', body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.file) {
        // 413 with no body is Vercel itself refusing an oversized request.
        return fail(body.detail || (res.status === 413 ? WORDS.tooBig : WORDS.generic))
      }
      if (!alive.current) return
      setUploads(u => u.filter(x => x.key !== key))
      setFiles(f => [body.file, ...(f || [])])
    } catch {
      fail(WORDS.generic)
    }
  }, [leadId, engagementId, prepare])

  const add = useCallback((fileList) => {
    const picked = Array.from(fileList || [])
    if (!leadId || picked.length === 0) return
    const fresh = picked.map(file => ({ key: `up-${++localSeq}`, name: file.name, status: 'sending', reason: null, file }))
    setUploads(u => [...fresh, ...u])
    // One at a time: a phone on a weak signal sending six photos at once
    // fails six photos.
    ;(async () => { for (const u of fresh) await sendOne(u.key, u.file) })()
  }, [leadId, sendOne])

  const retry = useCallback((key) => {
    let again = null
    setUploads(u => u.map(x => {
      if (x.key !== key) return x
      again = x
      return { ...x, status: 'sending', reason: null }
    }))
    // setState's updater has run by the next tick; read the row then.
    setTimeout(() => { if (again) sendOne(key, again.file) }, 0)
  }, [sendOne])

  const dismiss = useCallback((key) => setUploads(u => u.filter(x => x.key !== key)), [])

  /** @returns {Promise<string|null>} null when removed, else why not. */
  const remove = useCallback(async (id) => {
    try {
      const res = await fetch(fileUrl(id), { method: 'DELETE' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return body.detail || WORDS.generic
      if (alive.current) setFiles(f => (f || []).filter(x => x.id !== id))
      return null
    } catch {
      return WORDS.generic
    }
  }, [])

  return {
    files: files || [],
    loaded: files !== null,
    // The number for the tab: nothing until the list is in, then its length.
    count: files === null || notReady ? null : files.length,
    notReady, loadError, uploads,
    reload: load, add, retry, dismiss, remove,
  }
}

const smallBtn = { ...quietBtn(), minHeight: '32px', padding: '5px 10px' }

function Thumb({ file }) {
  const [broken, setBroken] = useState(false)
  const photo = isPhotoType(file.mime_type)
  // A photo with no preview (the browser could not make one) shows the
  // picture itself, lazily; HEIC cannot be drawn by most browsers, so it
  // goes straight to the plain tile.
  const src = photo && !broken
    ? (file.has_preview ? fileUrl(file.id, '?preview=1') : (file.mime_type === 'image/heic' ? null : fileUrl(file.id)))
    : null
  const box = {
    width: '52px', height: '52px', flexShrink: 0, borderRadius: T.radius.control,
    border: T.border.thin, background: T.surface.sunken, overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '2px',
    color: T.ink.muted,
  }
  if (src) {
    return (
      <span style={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" loading="lazy" onError={() => setBroken(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </span>
    )
  }
  return (
    <span style={box} data-testid={`file-tile-${file.id}`}>
      <IconFileText size={18} />
      <span style={{ fontSize: '9px', fontWeight: 600, letterSpacing: '0.04em' }}>{photo ? 'PHOTO' : 'PDF'}</span>
    </span>
  )
}

const nameStyle = {
  fontSize: '13px', fontWeight: 500, color: T.ink.primary, lineHeight: 1.35,
  // A long file name wraps to two lines and then stops, wherever the words
  // break — it never pushes the row wider than the card.
  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  overflowWrap: 'anywhere', wordBreak: 'break-word',
}
const metaStyle = { fontSize: '11px', color: T.ink.muted, marginTop: '2px', lineHeight: 1.4, overflowWrap: 'anywhere' }
const rowStyle = { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 0', borderBottom: T.border.divider }

function FileRow({ file, jobTitle, canRemove, onRemove }) {
  const [mode, setMode] = useState(null) // null | 'confirm'
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function doRemove() {
    setBusy(true); setErr(null)
    const why = await onRemove(file.id)
    // On success the row is gone from the list, and this never renders again.
    if (why) { setErr(why); setBusy(false) }
  }

  return (
    <li data-testid={`file-row-${file.id}`} style={{ listStyle: 'none', borderBottom: T.border.divider }}>
      <div style={{ ...rowStyle, borderBottom: 'none' }}>
        <a href={fileUrl(file.id)} target="_blank" rel="noopener noreferrer" title={file.name}
          style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit' }}>
          <Thumb file={file} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={nameStyle}>{file.name}</span>
            <span style={{ ...metaStyle, display: 'block' }}>
              {[file.uploaded_by_label, dayWords(file.created_at), fileSizeWords(file.size_bytes)].filter(Boolean).join(' · ')}
            </span>
            {jobTitle && <span style={{ ...metaStyle, display: 'block', marginTop: 0 }}>re: {jobTitle}</span>}
          </span>
        </a>
        {canRemove && mode === null && (
          <button type="button" className="bee-small-action" data-testid={`file-remove-${file.id}`}
            onClick={() => { setErr(null); setMode('confirm') }}
            style={{ ...smallBtn, flexShrink: 0, color: T.ink.muted }}>
            Remove
          </button>
        )}
      </div>
      {mode === 'confirm' && (
        <div style={{ background: T.state.danger.soft, borderRadius: T.radius.control, padding: '9px 11px', marginBottom: '10px' }}>
          <div style={{ fontSize: '12px', color: T.state.danger.strong, fontWeight: 600, lineHeight: 1.5 }}>
            Remove this file for good? It can’t be brought back.
          </div>
          {err && <div style={{ fontSize: '11px', color: T.state.danger.strong, marginTop: '4px' }}>{err}</div>}
          <div style={{ display: 'flex', gap: '8px', marginTop: '7px', flexWrap: 'wrap' }}>
            <button type="button" className="bee-small-action" data-testid={`file-remove-confirm-${file.id}`}
              disabled={busy} onClick={doRemove}
              style={{ ...smallBtn, color: T.state.danger.strong, fontWeight: 600, opacity: busy ? 0.5 : 1 }}>
              {busy ? 'Removing…' : 'Yes, remove it'}
            </button>
            <button type="button" className="bee-small-action" disabled={busy}
              onClick={() => { setMode(null); setErr(null) }} style={smallBtn}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function UploadRow({ up, onRetry, onDismiss }) {
  const failed = up.status === 'failed'
  return (
    <li data-testid={`file-upload-${up.status}`} style={{ ...rowStyle, listStyle: 'none', flexWrap: 'wrap' }}>
      <span style={{
        width: '52px', height: '52px', flexShrink: 0, borderRadius: T.radius.control,
        border: failed ? 'none' : T.border.dashed, background: failed ? T.state.danger.soft : T.surface.sunken,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: failed ? T.state.danger.strong : T.ink.muted,
      }}>
        {failed ? <IconAlertTriangle size={18} /> : <IconPaperclip size={18} />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ ...nameStyle, color: failed ? T.ink.primary : T.ink.muted }}>{up.name}</span>
        <span role={failed ? 'alert' : 'status'} style={{ ...metaStyle, display: 'block', color: failed ? T.state.danger.strong : T.ink.muted, fontWeight: failed ? 600 : 400 }}>
          {failed ? `Not added. ${up.reason || WORDS.generic}` : 'Adding…'}
        </span>
      </span>
      {failed && (
        // On their own line, under the reason: beside it, on a phone, the two
        // buttons squeezed the reason into a four-line sliver (seen in the
        // first screenshots).
        <span style={{ display: 'flex', gap: '6px', flexBasis: '100%', paddingLeft: '62px' }}>
          <button type="button" className="bee-small-action" onClick={() => onRetry(up.key)} style={smallBtn}>Try again</button>
          <button type="button" className="bee-small-action" onClick={() => onDismiss(up.key)} style={{ ...smallBtn, color: T.ink.muted }}>Dismiss</button>
        </span>
      )}
    </li>
  )
}

const dashedBox = { padding: '18px 12px', border: T.border.dashed, borderRadius: T.radius.control, textAlign: 'center' }
const boxLine = { fontSize: '12px', color: T.ink.quiet, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flexWrap: 'wrap' }

/**
 * @param state      what useClientFiles returned
 * @param readOnly   the card's own read-only (a read-only role, a paused
 *                   location, an overdue account): no adding, no removing
 * @param jobTitles  { engagementId: title } — on the CLIENT card, a file
 *                   pinned to a job says which ("re: Pantry refresh")
 * @param onJob      true on a job's tab
 */
export default function FilesTab({ state, readOnly = false, jobTitles = null, onJob = false }) {
  const input = useRef(null)
  const { files, loaded, notReady, loadError, uploads, add, retry, dismiss, remove, reload } = state

  if (loadError) {
    return (
      <div style={dashedBox} data-testid="files-load-error">
        <p style={boxLine}>
          Couldn’t load the files.
          <button type="button" className="bee-small-action" onClick={reload} style={smallBtn}>Try again</button>
        </p>
      </div>
    )
  }
  if (!loaded) {
    return <div style={dashedBox}><p style={boxLine}>Loading files…</p></div>
  }
  if (notReady) {
    return (
      <div style={dashedBox} data-testid="files-not-ready">
        <p style={boxLine}><IconPaperclip size={14} /> {WORDS.notSwitchedOn}</p>
      </div>
    )
  }

  const canAdd = !readOnly
  const pick = () => input.current && input.current.click()
  const picker = canAdd && (
    <input ref={input} type="file" multiple accept={FILE_PICKER_ACCEPT} data-testid="files-input"
      onChange={e => { add(e.target.files); e.target.value = '' }}
      style={{ display: 'none' }} />
  )
  const addBtn = canAdd && (
    <button type="button" className="bee-small-action" data-testid="files-add" onClick={pick}
      style={{ ...smallBtn, minHeight: '36px', background: T.accent.soft, color: T.accent.deep, border: 'none', fontWeight: 600 }}>
      <IconPlus size={13} /> Add files
    </button>
  )
  const hint = canAdd && (
    <p style={{ fontSize: '11px', color: T.ink.muted, lineHeight: 1.45 }}>
      Photos and PDFs, up to 4 MB each. Large photos are made smaller as they are added.
      {onJob ? ' Files added here also show on the client’s Files tab.' : ''}
    </p>
  )

  const empty = files.length === 0 && uploads.length === 0
  if (empty) {
    return (
      <div style={{ ...dashedBox, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }} data-testid="files-empty">
        {picker}
        <p style={boxLine}>
          <IconPaperclip size={14} />
          {onJob ? 'No files yet on this job.' : 'No files yet.'}
          {!canAdd && ` ${WORDS.readOnly}`}
        </p>
        {addBtn}
        {hint}
      </div>
    )
  }

  return (
    <div data-testid="files-list">
      {picker}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '6px' }}>
        <span style={{ fontSize: '12px', color: T.ink.muted }}>
          {files.length === 1 ? '1 file' : `${files.length} files`}
        </span>
        {addBtn}
      </div>
      {hint}
      {!canAdd && <p style={{ fontSize: '11px', color: T.ink.muted, lineHeight: 1.45 }}>{WORDS.readOnly}</p>}
      <ul style={{ margin: '4px 0 0', padding: 0 }}>
        {uploads.map(up => <UploadRow key={up.key} up={up} onRetry={retry} onDismiss={dismiss} />)}
        {files.map(f => (
          <FileRow key={f.id} file={f}
            jobTitle={jobTitles && f.engagement_id ? jobTitles[f.engagement_id] || null : null}
            canRemove={!readOnly && !!f.can_remove}
            onRemove={remove} />
        ))}
      </ul>
    </div>
  )
}
