// components/guide/HowToGuideModal.jsx
// ─────────────────────────────────────────────────────────────
// Hive Hub Guide — the Quick Start Guide slideshow + its admin editor.
// Extracted verbatim from BeeHub.jsx (issue 132) so the viewer is
// mount-testable — same move as components/feedback/FeedbackModal (#131).
// Slides come from Supabase via /api/guide-slides; no client-side defaults.
// The user-facing entry point is the Ask Bee Hub panel footer (Quick Start
// Guide link); admins also reach GuideEditor from Admin → Content.
// NOT part of the components/hive/** token sweep — legacy hexes intact.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'

// Chapter accent palette for slide headers. Shared with the manual slide
// editor still living in BeeHub.jsx.
export const CHAPTER_COLORS = [
  { label:'Dark Green', value:'#1a2e2b' },
  { label:'Forest',     value:'#2d4a3e' },
  { label:'Blue',       value:'#1a4a7a' },
  { label:'Purple',     value:'#2e1a4a' },
  { label:'Brown',      value:'#4a3a1a' },
  { label:'Rust',       value:'#7a4a1a' },
  { label:'Teal',       value:'#1a4a4a' },
]

// ═══════════════════════════════════════════════════════
//  Hive Hub Guide — restored from pre-Phase-0 BeeHub.js
//  - No client-side defaults; slides come from DB via /api/guide-slides
//  - HowToGuideModal shows an honest empty state when slides[] is empty
//  - GuideEditor preserves local edits if the network POST fails
// ═══════════════════════════════════════════════════════

export default function HowToGuideModal({ onClose, onDismiss, slides, canEdit=false, onPersist=null }) {
  const activeSlides = Array.isArray(slides) ? slides : []
  const [idx, setIdx] = useState(0)
  const [dontShow, setDontShow] = useState(false)
  const [editing, setEditing] = useState(false)
  // Editor mode (super_admin / corporate only). Rendered before the empty-slide
  // guards so the editor survives even if every slide is deleted mid-edit.
  if (editing && canEdit) {
    return (
      <div style={{ position:'fixed', inset:0, zIndex:10100, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px', background:'rgba(26,46,43,0.55)' }}>
        <div style={{ background:'#f7f5f0', borderRadius:'18px', width:'100%', maxWidth:'560px', maxHeight:'90vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.25)', overflow:'hidden', fontFamily:'"DM Sans",system-ui,sans-serif' }}>
          <div style={{ background:'#1a2e2b', padding:'14px 18px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'12px' }}>
            <button onClick={() => setEditing(false)} style={{ background:'rgba(255,255,255,0.12)', border:'1px solid rgba(255,255,255,0.22)', color:'white', cursor:'pointer', fontSize:'12px', fontWeight:600, fontFamily:'inherit', borderRadius:'8px', padding:'6px 12px' }}>← Done editing</button>
            <span style={{ fontSize:'12px', color:'rgba(255,255,255,0.85)', fontWeight:600 }}>Editing Hive Hub Guide</span>
            <button onClick={onClose} style={{ background:'none', border:'none', color:'rgba(255,255,255,0.85)', cursor:'pointer', fontSize:'22px', padding:0, lineHeight:1, fontFamily:'inherit' }}>×</button>
          </div>
          <div style={{ flex:1, overflowY:'auto' }}>
            <GuideEditor slides={activeSlides} onPersist={onPersist} />
          </div>
        </div>
      </div>
    )
  }
  // Honest empty state (issue 132) — the modal now opens from an explicit
  // click, so no slides must say so rather than silently render nothing.
  if (activeSlides.length === 0) {
    return (
      <div style={{ position:'fixed', inset:0, zIndex:10100, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px', background:'rgba(26,46,43,0.55)' }}>
        <div style={{ background:'white', borderRadius:'18px', width:'100%', maxWidth:'480px', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.25)', overflow:'hidden', fontFamily:'"DM Sans",system-ui,sans-serif' }}>
          <div style={{ background:'#1a2e2b', padding:'18px 20px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'12px' }}>
            <span style={{ fontSize:'12px', color:'rgba(255,255,255,0.85)', fontWeight:600 }}>Quick Start Guide</span>
            <button onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:'rgba(255,255,255,0.85)', cursor:'pointer', fontSize:'22px', padding:0, lineHeight:1, fontFamily:'inherit' }}>×</button>
          </div>
          <div style={{ padding:'28px 24px', textAlign:'center' }}>
            <div style={{ fontSize:'40px', marginBottom:'10px' }}>📖</div>
            <p style={{ fontSize:'13px', color:'#4a5e5a', lineHeight:1.6 }}>The guide doesn&rsquo;t have any pages yet. Check back soon.</p>
            {canEdit && (
              <button onClick={() => setEditing(true)} style={{ marginTop:'14px', padding:'8px 16px', background:'#1a2e2b', border:'none', borderRadius:'8px', fontSize:'12px', fontFamily:'inherit', fontWeight:600, color:'white', cursor:'pointer' }}>✏️ Add slides</button>
            )}
          </div>
        </div>
      </div>
    )
  }
  const slide = activeSlides[Math.min(idx, activeSlides.length - 1)]
  if (!slide) return null
  const chapterIdxMap = {}
  activeSlides.forEach((s, i) => {
    if (chapterIdxMap[s.chapter] === undefined) chapterIdxMap[s.chapter] = i
  })
  const chapters = [...new Set(activeSlides.map(s => s.chapter))]
  function handleClose() {
    if (dontShow && onDismiss) onDismiss()
    onClose()
  }
  function next() {
    if (idx < activeSlides.length - 1) setIdx(idx + 1)
    else handleClose()
  }
  function prev() { if (idx > 0) setIdx(idx - 1) }
  return (
    <div style={{ position:'fixed', inset:0, zIndex:10100, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px', background:'rgba(26,46,43,0.55)' }}>
      <div style={{ background:'white', borderRadius:'18px', width:'100%', maxWidth:'480px', maxHeight:'90vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.25)', overflow:'hidden', fontFamily:'"DM Sans",system-ui,sans-serif' }}>
        <div style={{ background:slide.color, padding:'18px 20px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'12px' }}>
          <select value={slide.chapter} onChange={e => setIdx(chapterIdxMap[e.target.value])} style={{ fontSize:'11px', color:'white', background:'rgba(0,0,0,0.2)', border:'1px solid rgba(255,255,255,0.15)', borderRadius:'6px', padding:'4px 8px', fontFamily:'inherit', fontWeight:600, cursor:'pointer', outline:'none' }}>
            {chapters.map((c, i) => (
              <option key={c} value={c} style={{ background:'white', color:'#1a2e2b' }}>{`${i+1} of ${chapters.length} — ${c}`}</option>
            ))}
          </select>
          <div style={{ display:'flex', alignItems:'center', gap:'8px', flexShrink:0 }}>
            {canEdit && (
              <button onClick={() => setEditing(true)} style={{ background:'rgba(0,0,0,0.2)', border:'1px solid rgba(255,255,255,0.18)', color:'white', cursor:'pointer', fontSize:'11px', fontWeight:600, fontFamily:'inherit', borderRadius:'6px', padding:'4px 9px', whiteSpace:'nowrap' }}>✏️ Manage slides</button>
            )}
            <button onClick={handleClose} style={{ background:'none', border:'none', color:'rgba(255,255,255,0.85)', cursor:'pointer', fontSize:'22px', padding:0, lineHeight:1, fontFamily:'inherit' }}>×</button>
          </div>
        </div>
        <div style={{ padding:'24px 24px 16px', flex:1, overflowY:'auto', display:'flex', flexDirection:'column', alignItems:'center', textAlign:'center' }}>
          <div style={{ fontSize:'48px', marginBottom:'10px' }}>{slide.icon}</div>
          <h2 style={{ fontSize:'20px', fontFamily:'Georgia,serif', color:'#1a2e2b', marginBottom:'10px' }}>{slide.title}</h2>
          <p style={{ fontSize:'13px', color:'#4a5e5a', lineHeight:1.6, marginBottom:'16px' }}>{slide.body}</p>
          {((slide.screenshots && slide.screenshots.length > 0) ? slide.screenshots : (slide.screenshot ? [slide.screenshot] : [])).map((src, si) => (
            <img key={si} src={src} alt="" style={{ maxWidth:'100%', borderRadius:'10px', marginBottom:'10px', border:'1px solid rgba(0,0,0,0.06)', display:'block' }} />
          ))}
          {slide.bullets && slide.bullets.length > 0 && (
            <ul style={{ listStyle:'none', padding:0, margin:0, textAlign:'left', display:'flex', flexDirection:'column', gap:'6px', width:'100%' }}>
              {slide.bullets.map((b, i) => (
                <li key={i} style={{ fontSize:'12px', color:'#4a5e5a', lineHeight:1.5, paddingLeft:'18px', position:'relative' }}>
                  <span style={{ position:'absolute', left:0, color:slide.color, fontWeight:700 }}>·</span>
                  {b}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ padding:'10px 20px', display:'flex', justifyContent:'center', gap:'5px', flexWrap:'wrap' }}>
          {activeSlides.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)} style={{ width:i===idx?'18px':'6px', height:'6px', borderRadius:'3px', background:i===idx?slide.color:'rgba(0,0,0,0.12)', cursor:'pointer', border:'none', padding:0, transition:'all 0.2s' }} />
          ))}
        </div>
        <div style={{ padding:'14px 20px 18px', borderTop:'1px solid rgba(0,0,0,0.06)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px', flexWrap:'wrap' }}>
          <label style={{ display:'flex', alignItems:'center', gap:'7px', fontSize:'11px', color:'#8a9e9a', cursor:'pointer' }}>
            <input type="checkbox" checked={dontShow} onChange={e => setDontShow(e.target.checked)} style={{ cursor:'pointer' }} />
            Don&rsquo;t show on login
          </label>
          <div style={{ display:'flex', gap:'8px' }}>
            {idx > 0 && (
              <button onClick={prev} style={{ padding:'8px 14px', background:'transparent', border:'1.5px solid rgba(0,0,0,0.1)', borderRadius:'8px', fontSize:'12px', fontFamily:'inherit', fontWeight:600, color:'#4a5e5a', cursor:'pointer' }}>← Back</button>
            )}
            <button onClick={next} style={{ padding:'8px 16px', background:slide.color, border:'none', borderRadius:'8px', fontSize:'12px', fontFamily:'inherit', fontWeight:600, color:'white', cursor:'pointer' }}>{idx === activeSlides.length - 1 ? 'Done' : 'Next →'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function GuideEditor({ slides: propSlides, onPersist }) {
  // Local state is the source of truth while editing. We mirror propSlides on
  // mount, then mutate locally; persist() pushes to the server but keeps the
  // local copy intact so a failed POST never loses the editor's work.
  const [slides, setSlides] = useState(() => Array.isArray(propSlides) ? propSlides : [])
  const [editing, setEditing] = useState(null)
  const [justSaved, setJustSaved] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  async function persist(newSlides) {
    setSlides(newSlides)
    setSaveError(null)
    if (!onPersist) {
      setJustSaved(true); setTimeout(() => setJustSaved(false), 1800)
      return
    }
    setSaving(true)
    try {
      await onPersist(newSlides)
      setJustSaved(true); setTimeout(() => setJustSaved(false), 1800)
    } catch (e) {
      console.error('[GuideEditor] save failed:', e)
      setSaveError(e?.message || 'Save failed — check console')
    } finally {
      setSaving(false)
    }
  }
  function moveSlide(i, dir) {
    const j = i + dir
    if (j < 0 || j >= slides.length) return
    const s = [...slides]
    ;[s[i], s[j]] = [s[j], s[i]]
    persist(s)
  }
  function deleteSlide(i) {
    if (!confirm('Delete this slide?')) return
    persist(slides.filter((_, idx) => idx !== i))
    if (editing === i) setEditing(null)
  }
  function saveEdit(slide) {
    if (editing === 'new') {
      persist([...slides, slide])
    } else if (editing && typeof editing === 'object' && editing.mode === 'newInChapter') {
      const s = [...slides]
      s.splice(editing.insertAfter + 1, 0, slide)
      persist(s)
    } else if (editing && typeof editing === 'object' && editing.mode === 'newChapter') {
      persist([...slides, slide])
    } else {
      const s = [...slides]
      s[editing] = slide
      persist(s)
    }
    setEditing(null)
  }
  function retrySave() { persist(slides) }

  const editingSlide =
    editing === 'new'
      ? { chapter:'', icon:'📌', title:'', color:'#1a2e2b', body:'', bullets:[''], screenshots:[] }
      : (editing && typeof editing === 'object' && editing.mode === 'newInChapter')
        ? { chapter:editing.chapter||'', icon:'📌', title:'', color: slides.find(s => s.chapter === editing.chapter)?.color || '#1a2e2b', body:'', bullets:[''], screenshots:[] }
        : (editing && typeof editing === 'object' && editing.mode === 'newChapter')
          ? { chapter:'', icon:'📌', title:'', color:'#d4a046', body:'', bullets:[''], screenshots:[] }
          : (editing !== null && typeof editing === 'number')
            ? slides[editing]
            : null

  const isEmpty = slides.length === 0

  return (
    <div style={{ padding:'1.25rem', display:'grid', gap:'12px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:'8px' }}>
        <div>
          <h2 style={{ fontSize:'18px', fontFamily:'Georgia,serif', color:'#1a2e2b' }}>📖 Guide Editor</h2>
          <p style={{ fontSize:'11px', color:'#8a9e9a', marginTop:'2px' }}>{`${slides.length} slide${slides.length===1?'':'s'}`}</p>
        </div>
        <div style={{ display:'flex', gap:'8px', alignItems:'center', flexWrap:'wrap' }}>
          {saving && <span style={{ fontSize:'11px', color:'#6366f1', fontWeight:600 }}>Saving…</span>}
          {!saving && justSaved && <span style={{ fontSize:'11px', color:'#10b981', fontWeight:600 }}>✓ Saved · just now</span>}
          {!isEmpty && (
            <button onClick={() => setPreviewOpen(true)} style={{ padding:'6px 10px', background:'transparent', border:'1px solid rgba(0,0,0,0.1)', borderRadius:'8px', fontSize:'11px', fontFamily:'inherit', color:'#4a5e5a', cursor:'pointer' }}>👁 Preview</button>
          )}
          <button onClick={() => setEditing('new')} style={{ padding:'6px 12px', background:'#1a2e2b', border:'none', borderRadius:'8px', fontSize:'11px', fontFamily:'inherit', fontWeight:600, color:'white', cursor:'pointer' }}>+ Add slide</button>
        </div>
      </div>

      {saveError && (
        <div style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:'10px', padding:'10px 12px', display:'flex', justifyContent:'space-between', alignItems:'center', gap:'10px' }}>
          <p style={{ fontSize:'12px', color:'#b91c1c', flex:1, margin:0 }}>
            <strong>Save failed:</strong> {saveError}
            <br />
            <span style={{ fontSize:'11px', opacity:0.85 }}>Your edits are preserved locally. Retry or reload to discard.</span>
          </p>
          <button onClick={retrySave} disabled={saving} style={{ padding:'6px 12px', background:'#b91c1c', border:'none', borderRadius:'8px', fontSize:'11px', fontFamily:'inherit', fontWeight:600, color:'white', cursor:saving?'not-allowed':'pointer', opacity:saving?0.5:1 }}>Retry</button>
        </div>
      )}

      {isEmpty ? (
        <div style={{ background:'white', border:'1px dashed rgba(0,0,0,0.15)', borderRadius:'12px', padding:'32px 16px', textAlign:'center' }}>
          <div style={{ fontSize:'36px', marginBottom:'8px' }}>📖</div>
          <p style={{ fontSize:'13px', color:'#4a5e5a', marginBottom:'14px' }}>No slides yet &mdash; add the first one to get started.</p>
          <button onClick={() => setEditing('new')} style={{ padding:'8px 16px', background:'#1a2e2b', border:'none', borderRadius:'8px', fontSize:'12px', fontFamily:'inherit', fontWeight:600, color:'white', cursor:'pointer' }}>+ Add slide</button>
        </div>
      ) : (
        <div style={{ background:'white', border:'1px solid rgba(0,0,0,0.07)', borderRadius:'12px', overflow:'hidden' }}>
          {(() => {
            const groups = []
            let cur = null
            slides.forEach((s, idx) => {
              if (s.chapter !== cur) { groups.push({ chapter: s.chapter, items: [] }); cur = s.chapter }
              groups[groups.length - 1].items.push({ slide: s, idx })
            })
            const elements = groups.map((g, gi) => (
              <div key={'g'+gi} style={{ borderTop: gi > 0 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}>
                <div style={{ padding:'8px 12px', background:'rgba(168,201,196,0.10)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:'10px', fontWeight:700, color:'#1a2e2b', textTransform:'uppercase', letterSpacing:'0.6px' }}>{g.chapter || '(no chapter)'}</span>
                  <button
                    onClick={() => {
                      const lastIdx = g.items[g.items.length - 1].idx
                      setEditing({ mode:'newInChapter', chapter:g.chapter, insertAfter:lastIdx })
                    }}
                    style={{ background:'none', border:'none', fontSize:'10px', color:'#1a2e2b', fontWeight:600, cursor:'pointer', fontFamily:'inherit', padding:0 }}
                  >+ Add slide</button>
                </div>
                {g.items.map(({ slide: s, idx: i }) => (
                  <div key={i} style={{ padding:'10px 12px', display:'flex', alignItems:'center', gap:'10px', borderTop:'1px solid rgba(0,0,0,0.04)' }}>
                    <span style={{ fontSize:'10px', color:'#b0c0bc', fontWeight:700, width:'18px', textAlign:'center', flexShrink:0 }}>{i + 1}</span>
                    <div style={{ width:'4px', height:'28px', background:s.color, borderRadius:'2px', flexShrink:0 }} />
                    <span style={{ fontSize:'18px', flexShrink:0 }}>{s.icon}</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ fontSize:'12px', fontWeight:600, color:'#1a2e2b', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.title}</p>
                      {((s.screenshots && s.screenshots.length > 0) || s.screenshot) && (
                        <p style={{ fontSize:'9px', color:'#a8c9c4', marginTop:'1px' }}>
                          {`🖼 ${(s.screenshots && s.screenshots.length) || 1} image${(((s.screenshots && s.screenshots.length) || 1) > 1 ? 's' : '')}`}
                        </p>
                      )}
                    </div>
                    <div style={{ display:'flex', gap:'2px', flexShrink:0 }}>
                      <button onClick={() => moveSlide(i, -1)} disabled={i === 0} style={{ background:'none', border:'none', padding:'4px 6px', cursor:i===0?'not-allowed':'pointer', opacity:i===0?0.25:0.65, fontSize:'13px', fontFamily:'inherit' }}>↑</button>
                      <button onClick={() => moveSlide(i, 1)} disabled={i === slides.length - 1} style={{ background:'none', border:'none', padding:'4px 6px', cursor:i===slides.length-1?'not-allowed':'pointer', opacity:i===slides.length-1?0.25:0.65, fontSize:'13px', fontFamily:'inherit' }}>↓</button>
                      <button onClick={() => setEditing(i)} style={{ background:'none', border:'none', padding:'4px 6px', cursor:'pointer', opacity:0.65, fontSize:'12px', fontFamily:'inherit' }}>✏️</button>
                      <button onClick={() => deleteSlide(i)} style={{ background:'none', border:'none', padding:'4px 6px', cursor:'pointer', opacity:0.65, fontSize:'13px', fontFamily:'inherit', color:'#ef4444' }}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            ))
            elements.push(
              <div key="addCh" style={{ padding:'10px 12px', borderTop:'1px dashed rgba(0,0,0,0.10)', textAlign:'center' }}>
                <button onClick={() => setEditing({ mode:'newChapter' })} style={{ background:'none', border:'none', fontSize:'11px', color:'#1a2e2b', fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}>+ New chapter</button>
              </div>
            )
            return elements
          })()}
        </div>
      )}

      {editingSlide && (
        <SlideEditForm
          slide={editingSlide}
          isNew={editing === 'new' || (editing && typeof editing === 'object')}
          onSave={saveEdit}
          onCancel={() => setEditing(null)}
          allChapters={[...new Set(slides.map(s => s.chapter).filter(Boolean))]}
        />
      )}

      {previewOpen && (
        <HowToGuideModal
          onClose={() => setPreviewOpen(false)}
          onDismiss={() => setPreviewOpen(false)}
          slides={slides}
        />
      )}
    </div>
  )
}

function SlideEditForm({ slide, isNew, onSave, onCancel, allChapters = [] }) {
  const [chapter, setChapter] = useState(slide.chapter || '')
  const hasExisting = allChapters.length > 0
  const initialMode =
    slide.chapter && allChapters.includes(slide.chapter)
      ? 'existing'
      : (hasExisting && !slide.chapter)
        ? 'existing'
        : 'new'
  const [chapterMode, setChapterMode] = useState(initialMode)
  const [icon, setIcon] = useState(slide.icon || '📌')
  const [title, setTitle] = useState(slide.title || '')
  const [color, setColor] = useState(slide.color || '#1a2e2b')
  const [body, setBody] = useState(slide.body || '')
  const [bullets, setBullets] = useState(slide.bullets && slide.bullets.length ? slide.bullets : [''])
  const [screenshots, setScreenshots] = useState(() => {
    if (slide.screenshots && slide.screenshots.length) return slide.screenshots
    if (slide.screenshot) return [slide.screenshot]
    return []
  })

  useEffect(() => {
    const scrollY = window.scrollY
    const b = document.body
    const h = document.documentElement
    const prev = { pos:b.style.position, top:b.style.top, width:b.style.width, bo:b.style.overflow, ho:h.style.overflow }
    b.style.position = 'fixed'
    b.style.top = `-${scrollY}px`
    b.style.width = '100%'
    b.style.overflow = 'hidden'
    h.style.overflow = 'hidden'
    return () => {
      b.style.position = prev.pos
      b.style.top = prev.top
      b.style.width = prev.width
      b.style.overflow = prev.bo
      h.style.overflow = prev.ho
      window.scrollTo(0, scrollY)
    }
  }, [])

  function save() {
    const finalChapter = (chapter || '').trim() || 'Untitled'
    onSave({
      chapter: finalChapter,
      icon, title, color, body,
      bullets: bullets.filter(b => b.trim()),
      screenshots,
      screenshot: screenshots[0] || null,
    })
  }
  function updateBullet(i, v) { const next = [...bullets]; next[i] = v; setBullets(next) }
  function addBullet() { setBullets([...bullets, '']) }
  function removeBullet(i) { setBullets(bullets.filter((_, idx) => idx !== i)) }
  function onScreenshotsChange(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    Promise.all(files.map(f => new Promise(res => {
      const r = new FileReader()
      r.onload = ev => res(ev.target.result)
      r.readAsDataURL(f)
    }))).then(urls => { setScreenshots(prev => [...prev, ...urls]) })
    e.target.value = ''
  }
  function removeScreenshot(i) { setScreenshots(screenshots.filter((_, idx) => idx !== i)) }
  function moveScreenshot(i, dir) {
    const j = i + dir
    if (j < 0 || j >= screenshots.length) return
    const s = [...screenshots]
    ;[s[i], s[j]] = [s[j], s[i]]
    setScreenshots(s)
  }

  const inp = { width:'100%', padding:'8px 10px', border:'1.5px solid rgba(0,0,0,0.1)', borderRadius:'8px', fontSize:'13px', fontFamily:'inherit', color:'#1a2e2b', outline:'none', boxSizing:'border-box', background:'white' }
  const lbl = { fontSize:'10px', fontWeight:700, color:'#8a9e9a', textTransform:'uppercase', letterSpacing:'0.4px', marginBottom:'5px', display:'block' }
  const isCustomColor = !CHAPTER_COLORS.find(cc => cc.value === color)
  const canSave = !!title.trim() && !!(chapter || '').trim()

  return (
    <div onClick={onCancel} style={{ position:'fixed', inset:0, zIndex:10110, display:'flex', alignItems:'flex-end', justifyContent:'center', padding:0, background:'rgba(26,46,43,0.45)' }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'white', borderRadius:'20px 20px 0 0', width:'100%', maxWidth:'520px', maxHeight:'90vh', boxShadow:'0 -8px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ padding:'16px 18px 12px', borderBottom:'1px solid rgba(0,0,0,0.06)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h2 style={{ fontSize:'15px', fontWeight:700, color:'#1a2e2b', fontFamily:'Georgia,serif' }}>{isNew ? 'Add Slide' : 'Edit Slide'}</h2>
          <button onClick={onCancel} style={{ background:'none', border:'none', fontSize:'22px', color:'#8a9e9a', cursor:'pointer', padding:0, lineHeight:1, fontFamily:'inherit' }}>×</button>
        </div>

        <div style={{ padding:'14px 18px', maxHeight:'calc(70vh - 80px)', overflowY:'auto', overscrollBehavior:'contain', paddingRight:'12px', display:'grid', gap:'12px' }}>
          <div>
            <label style={lbl}>Chapter</label>
            <div style={{ display:'flex', gap:'6px', marginBottom:'6px' }}>
              <button type="button" disabled={!hasExisting} onClick={() => { setChapterMode('existing'); if (allChapters.length && !allChapters.includes(chapter)) setChapter(allChapters[0]) }} style={{ flex:1, padding:'6px 8px', fontSize:'11px', fontWeight:600, fontFamily:'inherit', border:'1.5px solid ' + (chapterMode === 'existing' ? '#1a2e2b' : 'rgba(0,0,0,0.1)'), background:chapterMode === 'existing' ? '#1a2e2b' : 'white', color:chapterMode === 'existing' ? 'white' : (hasExisting ? '#4a5e5a' : '#b0c0bc'), borderRadius:'8px', cursor:hasExisting ? 'pointer' : 'not-allowed' }}>Existing chapter</button>
              <button type="button" onClick={() => { setChapterMode('new'); setChapter('') }} style={{ flex:1, padding:'6px 8px', fontSize:'11px', fontWeight:600, fontFamily:'inherit', border:'1.5px solid ' + (chapterMode === 'new' ? '#1a2e2b' : 'rgba(0,0,0,0.1)'), background:chapterMode === 'new' ? '#1a2e2b' : 'white', color:chapterMode === 'new' ? 'white' : '#4a5e5a', borderRadius:'8px', cursor:'pointer' }}>+ New chapter</button>
            </div>
            {chapterMode === 'existing' && hasExisting ? (
              <select value={allChapters.includes(chapter) ? chapter : allChapters[0]} onChange={e => setChapter(e.target.value)} style={inp}>
                {allChapters.map(ch => <option key={ch} value={ch}>{ch}</option>)}
              </select>
            ) : (
              <input type="text" value={chapter} onChange={e => setChapter(e.target.value)} placeholder="New chapter name" autoFocus style={inp} />
            )}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'80px 1fr', gap:'10px' }}>
            <div>
              <label style={lbl}>Icon</label>
              <input type="text" value={icon} onChange={e => setIcon(e.target.value)} maxLength={4} style={{ ...inp, textAlign:'center', fontSize:'20px', padding:'4px' }} />
            </div>
            <div>
              <label style={lbl}>Title</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)} style={inp} />
            </div>
          </div>

          <div>
            <label style={lbl}>Accent color</label>
            <div style={{ display:'flex', gap:'6px', flexWrap:'wrap' }}>
              {CHAPTER_COLORS.map(col => (
                <button key={col.value} type="button" onClick={() => setColor(col.value)} title={col.label} style={{ width:'30px', height:'30px', borderRadius:'8px', background:col.value, border: color === col.value ? '3px solid #d4a046' : '1.5px solid rgba(0,0,0,0.1)', cursor:'pointer', padding:0, boxShadow: color === col.value ? '0 0 0 2px white inset' : 'none' }} />
              ))}
              <label title="Custom color" style={{ width:'30px', height:'30px', borderRadius:'8px', border: isCustomColor ? '3px solid #d4a046' : '1.5px dashed rgba(0,0,0,0.3)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', position:'relative', overflow:'hidden', background: isCustomColor ? color : 'conic-gradient(from 0deg,#ef4444,#f59e0b,#eab308,#22c55e,#06b6d4,#3b82f6,#a855f7,#ec4899,#ef4444)' }}>
                <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ position:'absolute', inset:0, opacity:0, cursor:'pointer', border:'none' }} />
                {isCustomColor ? null : <span style={{ fontSize:'10px', fontWeight:700, color:'white', mixBlendMode:'difference' }}>+</span>}
              </label>
              <input type="text" value={color} maxLength={7} onChange={e => {
                let v = e.target.value.trim()
                if (v && !v.startsWith('#')) v = '#' + v
                if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setColor(v)
              }} placeholder="#hex" style={{ width:'90px', padding:'7px 8px', fontSize:'12px', fontFamily:'JetBrains Mono,Menlo,monospace', color:'#1a2e2b', border:'1.5px solid rgba(0,0,0,0.1)', borderRadius:'8px', outline:'none', background:'white', textTransform:'uppercase', letterSpacing:'0.05em' }} />
            </div>
          </div>

          <div>
            <label style={lbl}>Body</label>
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={3} style={{ ...inp, resize:'vertical', fontFamily:'inherit', lineHeight:1.5 }} />
          </div>

          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'5px' }}>
              <label style={lbl}>Bullets</label>
              <button type="button" onClick={addBullet} style={{ background:'none', border:'none', fontSize:'11px', color:'#1a2e2b', fontWeight:600, cursor:'pointer', padding:0, fontFamily:'inherit' }}>+ Add</button>
            </div>
            {bullets.map((b, i) => (
              <div key={i} style={{ display:'flex', gap:'6px', marginBottom:'4px' }}>
                <input type="text" value={b} onChange={e => updateBullet(i, e.target.value)} placeholder="Bullet point" style={inp} />
                <button type="button" onClick={() => removeBullet(i)} disabled={bullets.length === 1} style={{ background:'none', border:'none', color:'#8a9e9a', fontSize:'14px', cursor:bullets.length===1?'not-allowed':'pointer', padding:'4px 6px', opacity:bullets.length===1?0.3:1, fontFamily:'inherit' }}>×</button>
              </div>
            ))}
          </div>

          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'5px' }}>
              <label style={lbl}>{`Screenshots (${screenshots.length})`}</label>
              <label htmlFor="guide-screens" style={{ background:'none', border:'none', fontSize:'11px', color:'#1a2e2b', fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}>+ Add image(s)</label>
              <input id="guide-screens" type="file" accept="image/*" multiple onChange={onScreenshotsChange} style={{ display:'none' }} />
            </div>
            {screenshots.length === 0 && (
              <p style={{ fontSize:'11px', color:'#b0c0bc', textAlign:'center', padding:'12px', border:'1.5px dashed rgba(0,0,0,0.08)', borderRadius:'8px' }}>No screenshots yet</p>
            )}
            {screenshots.map((url, i) => (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'6px', background:'rgba(168,201,196,0.08)', borderRadius:'8px', marginBottom:'4px' }}>
                <img src={url} alt="" style={{ width:'48px', height:'36px', objectFit:'cover', borderRadius:'4px', flexShrink:0 }} />
                <span style={{ flex:1, fontSize:'11px', color:'#4a5e5a' }}>{`Image ${i+1}`}</span>
                <button type="button" onClick={() => moveScreenshot(i, -1)} disabled={i === 0} style={{ background:'none', border:'none', padding:'2px 6px', cursor:i===0?'not-allowed':'pointer', opacity:i===0?0.25:0.65, fontSize:'12px', fontFamily:'inherit' }}>↑</button>
                <button type="button" onClick={() => moveScreenshot(i, 1)} disabled={i === screenshots.length - 1} style={{ background:'none', border:'none', padding:'2px 6px', cursor:i===screenshots.length-1?'not-allowed':'pointer', opacity:i===screenshots.length-1?0.25:0.65, fontSize:'12px', fontFamily:'inherit' }}>↓</button>
                <button type="button" onClick={() => removeScreenshot(i)} style={{ background:'none', border:'none', color:'#ef4444', fontSize:'14px', cursor:'pointer', padding:'2px 6px', fontFamily:'inherit' }}>×</button>
              </div>
            ))}
          </div>

          <div style={{ position:'sticky', bottom:0, background:'white', borderTop:'1px solid #e5e7eb', padding:'12px 0', marginTop:'12px', display:'flex', gap:'8px', justifyContent:'flex-end' }}>
            <button onClick={onCancel} style={{ padding:'7px 14px', background:'transparent', border:'1.5px solid rgba(0,0,0,0.1)', borderRadius:'8px', fontSize:'12px', fontFamily:'inherit', color:'#4a5e5a', cursor:'pointer', fontWeight:600 }}>Cancel</button>
            <button onClick={save} disabled={!canSave} style={{ padding:'7px 16px', background: !canSave ? '#a8c9c4' : '#1a2e2b', color:'white', border:'none', borderRadius:'8px', fontSize:'12px', fontWeight:600, fontFamily:'inherit', cursor: !canSave ? 'not-allowed' : 'pointer' }}>{isNew ? 'Add slide' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
