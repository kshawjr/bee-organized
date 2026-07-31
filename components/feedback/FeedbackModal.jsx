// components/feedback/FeedbackModal.jsx
// User-facing feedback modal (My Items + Submit tabs). Extracted from BeeHub.jsx so
// it is imported in ONE place and mount-testable. `seed` pre-fills the form and
// carries an id-only record `context` into the POST (see lib/feedback-context.ts).
'use client'
import React, { useState, useRef, useEffect } from 'react'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import { feedbackFmtBytes, FeedbackItemCard } from '@/components/feedback/feedbackShared'

// initialTab: 'mine' (default — the Help "?" menu path) | 'submit' (the
// Feedback screen's composer button lands straight on the form).
//
// viewAsUserId: under view-as the "mine" tab should preview the IMPERSONATED
// user's items, but API calls ride the real session (view-as is display-only),
// so the mount passes the impersonated hub_users id and loadItems appends
// ?user_id= — which /api/feedback honors for elevated callers and ignores for
// everyone else. Null for real sessions → no param, own items as always.
// Known wrinkle: the Submit tab still files as the REAL session user, so a
// submission made while impersonating won't appear in the list it lands on.
// seed (optional): pre-fills the Submit form when the modal is opened FROM a
// record — { type?, title?, description?, context? }. `context` is an id-only
// record pointer (lib/feedback-context) that rides the POST and is re-sanitized
// server-side; it never carries the client's name/email/phone. Seeded once at
// open (the modal is remounted per open), and cleared after a successful submit
// so the record rides exactly ONE submission.
export default function FeedbackModal({ onClose, initialTab = 'mine', viewAsUserId = null, seed = null }) {
  const [tab, setTab]           = useState(initialTab) // 'mine' | 'submit'
  const [items, setItems]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [loadError, setLoadError] = useState(null)

  // Submit form
  const [type, setType]         = useState(seed?.type || 'bug')
  const [title, setTitle]       = useState(seed?.title || '')
  const [desc, setDesc]         = useState(seed?.description || '')
  const [context, setContext]   = useState(seed?.context || null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [toast, setToast]       = useState(null)
  const bodyRef = useRef(null)

  // Attachments — selected client-side, uploaded only at submit time. Each
  // entry: { id, file, preview }. preview is an image data URL (or null).
  const FB_MAX_FILES = 5
  const FB_MAX_BYTES = 10 * 1024 * 1024
  const [files, setFiles]       = useState([])
  const [uploadProgress, setUploadProgress] = useState(null) // e.g. "Uploading 1 of 3…"
  const fileInputRef = useRef(null)

  function onPickFiles(e) {
    const picked = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same file after a remove
    if (picked.length === 0) return
    setSubmitError(null)
    setFiles(prev => {
      const next = [...prev]
      for (const file of picked) {
        if (next.length >= FB_MAX_FILES) {
          setSubmitError(`You can attach up to ${FB_MAX_FILES} files.`)
          break
        }
        if (file.size > FB_MAX_BYTES) {
          setSubmitError(`"${file.name}" is larger than 10MB and was skipped.`)
          continue
        }
        const entry = { id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`, file, preview: null }
        next.push(entry)
        if (file.type && file.type.startsWith('image/')) {
          const reader = new FileReader()
          reader.onload = () => setFiles(cur => cur.map(f => f.id === entry.id ? { ...f, preview: reader.result } : f))
          reader.readAsDataURL(file)
        }
      }
      return next
    })
  }

  function removeFile(id) {
    setFiles(prev => prev.filter(f => f.id !== id))
  }

  async function loadItems() {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(viewAsUserId ? `/api/feedback?user_id=${encodeURIComponent(viewAsUserId)}` : '/api/feedback')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(Array.isArray(data.items) ? data.items : [])
    } catch (e) {
      setLoadError("Couldn't load your items. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadItems() }, [viewAsUserId])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3200)
    return () => clearTimeout(t)
  }, [toast])

  const canSubmit = title.trim().length > 0 && desc.trim().length > 0 && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      // 1) Upload any selected files first, collecting their stored metadata.
      //    A failure here leaves the form (and file selection) intact so the
      //    user can retry without re-entering anything.
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

      // 2) Create the feedback item with the uploaded attachment metadata.
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, title: title.trim(), description: desc.trim(), attachments: uploaded, ...(context ? { context } : {}) }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      // Reset form, switch to My Items, refresh, toast.
      setTitle(''); setDesc(''); setType('bug'); setFiles([]); setContext(null)
      setTab('mine')
      setToast("Submitted! We'll review and respond.")
      await loadItems()
      if (bodyRef.current) bodyRef.current.scrollTop = 0
    } catch (e) {
      setSubmitError(e?.message ? `Could not submit — ${e.message}` : 'Could not submit — please try again.')
    } finally {
      setUploadProgress(null)
      setSubmitting(false)
    }
  }

  const tabBtn = (key, label) => (
    <button
      onClick={() => setTab(key)}
      style={{ flex:1, padding:'11px', background:'none', border:'none', borderBottom: tab === key ? '2px solid #1a2e2b' : '2px solid transparent', cursor:'pointer', fontFamily:'inherit', fontSize:'13px', fontWeight: tab === key ? 700 : 500, color: tab === key ? '#1a2e2b' : '#8a9e9a' }}>
      {label}
    </button>
  )

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose() }} style={{ position:'fixed', inset:0, zIndex:10120, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px', background:'rgba(26,46,43,0.55)', fontFamily:'"DM Sans",system-ui,sans-serif' }}>
      <div style={{ background:'white', borderRadius:'16px', width:'100%', maxWidth:'600px', maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.25)', overflow:'hidden' }}>
        {/* Sticky header */}
        <div style={{ padding:'16px 20px', borderBottom:'1px solid rgba(0,0,0,0.07)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'12px', flexShrink:0 }}>
          <h2 style={{ fontSize:'17px', fontFamily:'Georgia,serif', color:'#1a2e2b', margin:0 }}>🐛 Feedback</h2>
          <button onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:'#8a9e9a', cursor:'pointer', fontSize:'24px', lineHeight:1, padding:0 }}>×</button>
        </div>
        {/* Tab strip */}
        <div style={{ display:'flex', borderBottom:'1px solid rgba(0,0,0,0.07)', flexShrink:0 }}>
          {tabBtn('mine', 'My Items')}
          {tabBtn('submit', 'Submit')}
        </div>
        {/* Scrollable body */}
        <div ref={bodyRef} style={{ padding:'18px 20px', overflowY:'auto', flex:1 }}>
          {tab === 'mine' ? (
            loading ? (
              <BeeLoader label="Gathering your reports…" />
            ) : loadError ? (
              <div style={{ textAlign:'center', padding:'24px 0' }}>
                <p style={{ fontSize:'13px', color:'#b91c1c', marginBottom:'10px' }}>{loadError}</p>
                <button onClick={loadItems} style={{ padding:'8px 16px', background:'#1a2e2b', border:'none', borderRadius:'8px', fontSize:'12px', fontFamily:'inherit', fontWeight:600, color:'white', cursor:'pointer' }}>Retry</button>
              </div>
            ) : items.length === 0 ? (
              <div style={{ textAlign:'center', padding:'34px 16px' }}>
                <div style={{ fontSize:'34px', marginBottom:'10px' }}>📭</div>
                <p style={{ fontSize:'14px', fontWeight:700, color:'#1a2e2b', marginBottom:'6px' }}>You haven't submitted anything yet</p>
                <p style={{ fontSize:'12px', color:'#8a9e9a', lineHeight:1.5 }}>Switch to the Submit tab to file your first bug report or feature request.</p>
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:'10px' }}>
                {items.map(it => <FeedbackItemCard key={it.id} item={it} />)}
              </div>
            )
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:'14px' }}>
              {/* Type toggle */}
              <div>
                <label style={{ display:'block', fontSize:'12px', fontWeight:700, color:'#1a2e2b', marginBottom:'7px' }}>Type</label>
                <div style={{ display:'flex', gap:'8px' }}>
                  {[{ k:'bug', icon:'🐛', label:'Bug' }, { k:'feature', icon:'✨', label:'Feature' }].map(o => (
                    <button key={o.k} onClick={() => setType(o.k)} style={{ flex:1, padding:'10px', borderRadius:'10px', cursor:'pointer', fontFamily:'inherit', fontSize:'13px', fontWeight:600, border:'1.5px solid', borderColor: type === o.k ? '#1a2e2b' : 'rgba(0,0,0,0.1)', background: type === o.k ? '#1a2e2b' : 'white', color: type === o.k ? 'white' : '#4a5e5a' }}>
                      {o.icon} {o.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Title */}
              <div>
                <label style={{ display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:'12px', fontWeight:700, color:'#1a2e2b', marginBottom:'6px' }}>
                  <span>Title</span>
                  <span style={{ fontSize:'11px', fontWeight:500, color: title.length > 100 ? '#b91c1c' : '#8a9e9a' }}>{title.length}/100</span>
                </label>
                <input value={title} maxLength={100} onChange={e => setTitle(e.target.value)} placeholder="Short summary" style={{ width:'100%', padding:'10px 12px', border:'1.5px solid rgba(0,0,0,0.1)', borderRadius:'10px', fontSize:'13px', fontFamily:'inherit', color:'#1a2e2b', outline:'none', boxSizing:'border-box' }} />
              </div>
              {/* Description */}
              <div>
                <label style={{ display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:'12px', fontWeight:700, color:'#1a2e2b', marginBottom:'6px' }}>
                  <span>Description</span>
                  <span style={{ fontSize:'11px', fontWeight:500, color: desc.length > 2000 ? '#b91c1c' : '#8a9e9a' }}>{desc.length}/2000</span>
                </label>
                <textarea value={desc} maxLength={2000} onChange={e => setDesc(e.target.value)} rows={6} placeholder="What happened (or what would you like)?" style={{ width:'100%', padding:'10px 12px', border:'1.5px solid rgba(0,0,0,0.1)', borderRadius:'10px', fontSize:'13px', fontFamily:'inherit', color:'#1a2e2b', outline:'none', boxSizing:'border-box', resize:'vertical', lineHeight:1.5 }} />
              </div>
              <p style={{ fontSize:'11px', color:'#8a9e9a', lineHeight:1.5 }}>Be specific. Include steps to reproduce for bugs.</p>
              {/* Attachments */}
              <div>
                <label style={{ display:'block', fontSize:'12px', fontWeight:700, color:'#1a2e2b', marginBottom:'2px' }}>Attachments (optional)</label>
                <p style={{ fontSize:'11px', color:'#8a9e9a', lineHeight:1.5, marginBottom:'8px' }}>Up to 5 files, 10MB each. Screenshots/videos especially helpful.</p>
                <input ref={fileInputRef} type="file" multiple onChange={onPickFiles} style={{ display:'none' }} />
                <button
                  type="button"
                  onClick={() => fileInputRef.current && fileInputRef.current.click()}
                  disabled={files.length >= FB_MAX_FILES || submitting}
                  style={{ padding:'9px 14px', borderRadius:'10px', border:'1.5px dashed rgba(0,0,0,0.2)', background:'white', cursor: (files.length >= FB_MAX_FILES || submitting) ? 'default' : 'pointer', fontFamily:'inherit', fontSize:'13px', fontWeight:600, color: (files.length >= FB_MAX_FILES) ? '#8a9e9a' : '#1a2e2b', opacity: (files.length >= FB_MAX_FILES || submitting) ? 0.55 : 1 }}>
                  📎 {files.length === 0 ? 'Add file' : files.length >= FB_MAX_FILES ? 'Maximum 5 files' : 'Add another file'}
                </button>
                {files.length > 0 && (
                  <div style={{ display:'flex', flexDirection:'column', gap:'8px', marginTop:'10px' }}>
                    {files.map(f => (
                      <div key={f.id} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'8px 10px', border:'1px solid rgba(0,0,0,0.1)', borderRadius:'10px', background:'white' }}>
                        {f.preview ? (
                          <img src={f.preview} alt="" style={{ width:'40px', height:'40px', objectFit:'cover', borderRadius:'6px', flexShrink:0, border:'1px solid rgba(0,0,0,0.08)' }} />
                        ) : (
                          <span style={{ width:'40px', height:'40px', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:'18px', background:'#f0efe9', borderRadius:'6px', flexShrink:0 }}>📄</span>
                        )}
                        <div style={{ minWidth:0, flex:1 }}>
                          <p style={{ fontSize:'13px', fontWeight:600, color:'#1a2e2b', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.file.name}</p>
                          <p style={{ fontSize:'11px', color:'#8a9e9a' }}>{feedbackFmtBytes(f.file.size)}</p>
                        </div>
                        <button type="button" onClick={() => removeFile(f.id)} disabled={submitting} aria-label={`Remove ${f.file.name}`} style={{ background:'none', border:'none', color:'#8a9e9a', cursor: submitting ? 'default' : 'pointer', fontSize:'20px', lineHeight:1, padding:'0 4px', flexShrink:0 }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {submitError && <p style={{ fontSize:'12px', color:'#b91c1c' }}>{submitError}</p>}
              <button onClick={handleSubmit} disabled={!canSubmit} style={{ padding:'12px', borderRadius:'10px', border:'none', cursor: canSubmit ? 'pointer' : 'default', fontFamily:'inherit', fontSize:'14px', fontWeight:700, color:'white', background: canSubmit ? '#1a2e2b' : 'rgba(26,46,43,0.35)' }}>
                {uploadProgress ? uploadProgress : submitting ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          )}
        </div>
        {toast && (
          <div style={{ position:'absolute', top:'14px', left:'50%', transform:'translateX(-50%)', background:'rgba(34,197,94,0.97)', color:'white', padding:'9px 16px', borderRadius:'10px', fontSize:'13px', fontWeight:600, boxShadow:'0 8px 24px rgba(0,0,0,0.2)', zIndex:10 }}>
            {toast}
          </div>
        )}
      </div>
    </div>
  )
}
