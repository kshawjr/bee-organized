// components/settings/EmailSignatureSettings.jsx
// ─────────────────────────────────────────────────────────────
// Settings for the {{signature}} merge tag (lib/email-signature.ts).
//
// Every Bee Organized signature is the SAME fixed layout, so there is nothing
// to design — only values to fill in:
//
//   YourSignatureCard           Profile → your headshot and job title. Name,
//                               email and mobile are the Your Profile rows
//                               above it; nothing is typed twice.
//   LocationSignatureLinksCard  My Location → the location's website and
//                               Facebook / Instagram / LinkedIn links, shown
//                               in every signature from this location.
//   SignaturePreview            The real thing: GET /api/signature builds the
//                               preview with the same resolver and layout a
//                               send uses, and it renders in a sandboxed
//                               iframe (no scripts) exactly as mailed.
//
// Nothing here is HTML the owner writes. Every value is a plain field; the
// server escapes it into the fixed layout at send time.
// ─────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { uploadSignaturePhoto } from '@/lib/signature-photo'

const INK = '#1a2e2b'
const MUTED = '#8a9e9a'
const FAINT = '#b0c0bc'
const SAGE = '#a8c9c4'
const ERR = '#b91c1c'

const cardStyle = { borderRadius:'12px', overflow:'hidden', margin:'0 12px', boxShadow:'0 1px 4px rgba(0,0,0,0.06)', background:'white' }
const rowStyle = { padding:'12px 16px', borderBottom:'1px solid rgba(0,0,0,0.05)', background:'white' }
const labelStyle = { fontSize:'11px', color:MUTED, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.4px', marginBottom:'2px' }
const hintStyle = { fontSize:'11px', color:FAINT, marginTop:'2px' }
const inputStyle = { width:'100%', maxWidth:'420px', padding:'6px 8px', border:`1.5px solid ${SAGE}`, borderRadius:'6px', fontSize:'16px', fontFamily:'inherit', color:INK, outline:'none', boxSizing:'border-box' }
const smallBtn = (primary, disabled) => ({
  fontSize:'12px', fontFamily:'inherit', fontWeight:600, borderRadius:'6px', padding:'6px 12px', cursor:disabled?'not-allowed':'pointer',
  color: primary ? (disabled ? '#9ca3af' : 'white') : INK,
  background: primary ? (disabled ? '#e5e7eb' : INK) : 'transparent',
  border: primary ? 'none' : '1px solid rgba(0,0,0,0.12)',
})

// One shared loader so the cards and every preview read the same answer.
function useSignatureData(locationId, refreshKey) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : ''
    fetch(`/api/signature${qs}`, { credentials:'include' })
      .then(async r => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
        return j
      })
      .then(j => { if (alive) { setData(j); setError(null) } })
      .catch(e => { if (alive) setError(e.message || String(e)) })
    return () => { alive = false }
  }, [locationId, refreshKey])
  return { data, error }
}

// ─── Preview ──────────────────────────────────────────────────────────────
// Server-built HTML in an iframe with sandbox="" — nothing in it can run, and
// it renders the way a mail client would, not the way this page's CSS would.
export function SignaturePreview({ locationId = null, refreshKey = 0, mode = 'html', compact = false }) {
  const { data, error } = useSignatureData(locationId, refreshKey)
  const frameRef = useRef(null)
  const [height, setHeight] = useState(compact ? 120 : 150)

  const html = data?.preview?.html || ''
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}</style></head><body>${html}</body></html>`

  if (error) return <p style={{ fontSize:'12px', color:ERR, padding:'8px 0' }}>Couldn’t load the signature preview: {error}</p>
  if (!data) return <p style={{ fontSize:'12px', color:MUTED, padding:'8px 0' }}>Loading signature…</p>
  if (!data.preview) return <p style={{ fontSize:'12px', color:MUTED, padding:'8px 0' }}>Open a location to preview its signature.</p>

  if (mode === 'text') {
    return <pre style={{ margin:0, fontSize:'13px', lineHeight:1.6, color:'#374151', whiteSpace:'pre-wrap', fontFamily:'monospace' }}>{data.preview.text}</pre>
  }
  return (
    <iframe
      ref={frameRef}
      title="Email signature preview"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      onLoad={() => {
        // allow-same-origin (no allow-scripts) lets us MEASURE the content to
        // size the frame; scripts inside still cannot run.
        try {
          const h = frameRef.current?.contentDocument?.body?.scrollHeight
          if (h) setHeight(Math.min(Math.max(h + 4, 60), 400))
        } catch {}
      }}
      style={{ width:'100%', height:`${height}px`, border:'none', display:'block', background:'white' }}
    />
  )
}

// ─── Your signature (Profile) ────────────────────────────────────────────
export function YourSignatureCard({ locationId = null, signedIn = true }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data, error } = useSignatureData(locationId, refreshKey)
  const [title, setTitle] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [busy, setBusy] = useState(null)       // status text while uploading
  const [problem, setProblem] = useState(null) // last error, shown in words
  const fileRef = useRef(null)

  useEffect(() => { if (data && !editingTitle) setTitle(data.person?.title || '') }, [data, editingTitle])

  const bump = useCallback(() => setRefreshKey(k => k + 1), [])
  const storageOff = data && data.storageReady && data.storageReady.person === false

  async function patchMe(body) {
    const res = await fetch('/api/hub_users/me', {
      method:'PATCH', credentials:'include', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  }

  async function saveTitle() {
    setProblem(null)
    try { await patchMe({ signature_title: title.trim() }); setEditingTitle(false); bump() }
    catch (e) { setProblem(`Couldn’t save your title: ${e.message}`) }
  }

  async function onPick(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setProblem(null)
    try {
      await uploadSignaturePhoto(file, { onStatus: setBusy })
      bump()
    } catch (err) {
      setProblem(err.message || String(err))
    } finally {
      setBusy(null)
    }
  }

  async function removePhoto() {
    setProblem(null)
    try { await patchMe({ signature_photo_path: '' }); bump() }
    catch (e) { setProblem(`Couldn’t remove the photo: ${e.message}`) }
  }

  if (!signedIn) {
    return <div style={cardStyle}><div style={rowStyle}><p style={hintStyle}>Sign in as yourself to set your email signature.</p></div></div>
  }

  const photoUrl = data?.person?.photoUrl || null

  return (
    <div style={cardStyle}>
      {storageOff && (
        <div style={{ ...rowStyle, background:'#fffbeb' }}>
          <p style={{ fontSize:'12px', color:'#92400e' }}>Photo and title storage isn’t switched on yet. Your signature shows your name, email and mobile until it is.</p>
        </div>
      )}

      {/* Headshot */}
      <div style={rowStyle}>
        <p style={labelStyle}>Headshot</p>
        <div style={{ display:'flex', alignItems:'center', gap:'12px', marginTop:'6px' }}>
          <div style={{ width:'64px', height:'64px', flexShrink:0, background:'#f3f4f6', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden' }}>
            {photoUrl
              ? <img src={photoUrl} alt="Your headshot" width={64} height={64} style={{ width:'64px', height:'64px', objectFit:'cover', display:'block' }} />
              : <span style={{ fontSize:'11px', color:FAINT }}>No photo</span>}
          </div>
          <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
            <input ref={fileRef} type="file" accept="image/*" onChange={onPick} style={{ display:'none' }} />
            <button type="button" disabled={!!busy || storageOff} onClick={() => fileRef.current && fileRef.current.click()} style={smallBtn(true, !!busy || storageOff)}>
              {busy || (photoUrl ? 'Change photo' : 'Upload photo')}
            </button>
            {photoUrl && !busy && (
              <button type="button" onClick={removePhoto} style={smallBtn(false, false)}>Remove</button>
            )}
          </div>
        </div>
        <p style={hintStyle}>A square photo works best. We trim it square and shrink it to a small, fast-loading image for you.</p>
      </div>

      {/* Title */}
      <div style={rowStyle}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px' }}>
          <div style={{ flex:1, minWidth:0 }}>
            <p style={labelStyle}>Title</p>
            {editingTitle ? (
              <input autoFocus value={title} maxLength={80} onChange={e => setTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') { setEditingTitle(false); setTitle(data?.person?.title || '') } }}
                placeholder="e.g. Owner & Lead Organizer" style={inputStyle} />
            ) : (
              <p style={{ fontSize:'14px', color:INK, fontWeight:500 }}>{data?.person?.title || <span style={{ color:'#c8d8d4' }}>Not set</span>}</p>
            )}
            {!editingTitle && <p style={hintStyle}>Shown under your name, in grey italics.</p>}
          </div>
          {editingTitle ? (
            <div style={{ display:'flex', gap:'6px', flexShrink:0 }}>
              <button onClick={saveTitle} style={smallBtn(true, false)}>Save</button>
              <button onClick={() => { setEditingTitle(false); setTitle(data?.person?.title || '') }} style={{ fontSize:'18px', color:MUTED, background:'none', border:'none', cursor:'pointer', lineHeight:1 }}>×</button>
            </div>
          ) : (
            <button disabled={storageOff} onClick={() => setEditingTitle(true)} style={{ fontSize:'12px', color:storageOff?'#c8d8d4':SAGE, background:'none', border:'none', cursor:storageOff?'not-allowed':'pointer', fontFamily:'inherit', flexShrink:0 }}>Edit</button>
          )}
        </div>
      </div>

      {problem && <div style={rowStyle}><p style={{ fontSize:'12px', color:ERR }}>{problem}</p></div>}
      {error && <div style={rowStyle}><p style={{ fontSize:'12px', color:ERR }}>Couldn’t load your signature: {error}</p></div>}

      {/* Preview */}
      <div style={{ ...rowStyle, borderBottom:'none' }}>
        <p style={labelStyle}>How it looks in a client email</p>
        <div style={{ border:'1px solid rgba(0,0,0,0.06)', borderRadius:'8px', overflow:'hidden', marginTop:'6px' }}>
          <SignaturePreview locationId={locationId} refreshKey={refreshKey} />
        </div>
        <p style={hintStyle}>
          Your name, email and mobile come from Your Profile above. The website and social links are your location’s.
          To use it, type {'{{signature}}'} where it should go in a client email template, e.g. “Thank you,” then {'{{signature}}'} on the next line. It’s never added on its own.
        </p>
      </div>
    </div>
  )
}

// ─── Location links (My Location) ─────────────────────────────────────────
const LINK_FIELDS = [
  { key:'website_url',   label:'Website',   placeholder:'e.g. beeorganized.com/boulder' },
  { key:'facebook_url',  label:'Facebook',  placeholder:'https://www.facebook.com/yourpage' },
  { key:'instagram_url', label:'Instagram', placeholder:'https://www.instagram.com/yourhandle' },
  { key:'linkedin_url',  label:'LinkedIn',  placeholder:'https://www.linkedin.com/company/yourpage' },
]

function LinkRow({ field, value, disabled, onSave }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(value || '')
  const [err, setErr] = useState(null)
  useEffect(() => { if (!editing) setVal(value || '') }, [value, editing])

  async function save() {
    setErr(null)
    try { await onSave(field.key, val.trim()); setEditing(false) }
    catch (e) { setErr(e.message || String(e)) }
  }
  return (
    <div style={rowStyle}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px' }}>
        <div style={{ flex:1, minWidth:0 }}>
          <p style={labelStyle}>{field.label}</p>
          {editing ? (
            <input autoFocus type="url" value={val} placeholder={field.placeholder}
              onChange={e => setVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setErr(null) } }}
              style={inputStyle} />
          ) : (
            <p style={{ fontSize:'14px', color:INK, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {value || <span style={{ color:'#c8d8d4' }}>Not set</span>}
            </p>
          )}
          {err && <p style={{ fontSize:'11px', color:ERR, marginTop:'4px' }}>{err}</p>}
        </div>
        {editing ? (
          <div style={{ display:'flex', gap:'6px', flexShrink:0 }}>
            <button onClick={save} style={smallBtn(true, false)}>Save</button>
            <button onClick={() => { setEditing(false); setErr(null) }} style={{ fontSize:'18px', color:MUTED, background:'none', border:'none', cursor:'pointer', lineHeight:1 }}>×</button>
          </div>
        ) : (
          <button disabled={disabled} onClick={() => setEditing(true)} style={{ fontSize:'12px', color:disabled?'#c8d8d4':SAGE, background:'none', border:'none', cursor:disabled?'not-allowed':'pointer', fontFamily:'inherit', flexShrink:0 }}>Edit</button>
        )}
      </div>
    </div>
  )
}

export function LocationSignatureLinksCard({ locationId }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data, error } = useSignatureData(locationId, refreshKey)

  if (!locationId) {
    return <div style={cardStyle}><div style={rowStyle}><p style={hintStyle}>Open the real location to change its signature links.</p></div></div>
  }
  const storageOff = data && data.storageReady && data.storageReady.links === false

  async function saveLink(column, value) {
    const res = await fetch(`/api/locations/${locationId}`, {
      method:'PATCH', credentials:'include', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ [column]: value }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    setRefreshKey(k => k + 1)
  }

  return (
    <div style={cardStyle}>
      {storageOff && (
        <div style={{ ...rowStyle, background:'#fffbeb' }}>
          <p style={{ fontSize:'12px', color:'#92400e' }}>Signature links storage isn’t switched on yet.</p>
        </div>
      )}
      {error && <div style={rowStyle}><p style={{ fontSize:'12px', color:ERR }}>Couldn’t load the links: {error}</p></div>}
      {LINK_FIELDS.map(f => (
        <LinkRow key={f.key} field={f} value={data?.links?.[f.key] || ''} disabled={!data || storageOff} onSave={saveLink} />
      ))}
      <div style={{ ...rowStyle, borderBottom:'none' }}>
        <p style={hintStyle}>Shown in every email signature from this location — your website as a link, and an icon for each social page that’s set. Leave one blank and its icon doesn’t appear.</p>
      </div>
    </div>
  )
}
