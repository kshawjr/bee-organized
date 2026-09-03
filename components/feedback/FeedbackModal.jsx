// components/feedback/FeedbackModal.jsx
// User-facing feedback modal (My Items + Submit tabs). Extracted from BeeHub.jsx so
// it is imported in ONE place and mount-testable. `seed` pre-fills the form and
// carries an id-only record `context` into the POST (see lib/feedback-context.ts).
//
// The Submit tab is the GUIDED intake (components/feedback/GuidedIntake.jsx,
// design A): three doors, three questions one screen at a time, a review. The
// My Items tab is untouched. What the modal POSTs is the same body the old
// two-box form posted.
//
// THE PHONE. On mobile this is no longer a centred box: it is a top-anchored
// sheet sized to the VISUAL viewport (window.visualViewport.height), so when
// the iPhone keyboard rises the sheet shrinks above it and the field being
// typed in stays on screen — the fault Ankur reported on the new-lead form
// (feedback ddc3afab). Desktop keeps the centred modal.
'use client'
import React, { useState, useRef, useEffect } from 'react'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import useIsMobile from '@/components/hive/shared/useIsMobile'
import { FeedbackItemCard } from '@/components/feedback/feedbackShared'
import GuidedIntake from '@/components/feedback/GuidedIntake'

// The visible height of the viewport — the part the keyboard has not taken.
// null until measured (SSR, or a browser without visualViewport).
function useVisualViewportHeight(enabled) {
  const [h, setH] = useState(null)
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return
    const read = () => setH(Math.round(vv.height))
    read()
    vv.addEventListener('resize', read)
    vv.addEventListener('scroll', read)
    return () => { vv.removeEventListener('resize', read); vv.removeEventListener('scroll', read) }
  }, [enabled])
  return h
}

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
// seed (optional): pre-fills the form when the modal is opened FROM a record
// or the Help ask strip — { type?, title?, description?, about?, context? }.
// `type` skips the door. `title` is answer 1. `about` is the Help breadcrumb,
// appended to the stored description as an "About:" line. `context` is an
// id-only record pointer (lib/feedback-context) that rides the POST and is
// re-sanitized server-side. Seeded once at open (the modal is remounted per
// open), and cleared after a successful submit so the record rides exactly
// ONE submission.
// ambientContext (optional): where the user was standing when the modal opened
// — { origin:'feedback_modal', screen, path, lead_id?, engagement_id? }, built
// by the mount from activeNav + the address bar (components/hive/shared/hubUrl
// → buildAmbientContext). Issue 249. It rides UNDER the seed and is NOT cleared
// after a submit — a second report filed without closing the modal was still
// filed from the same screen.
export default function FeedbackModal({ onClose, initialTab = 'mine', viewAsUserId = null, seed = null, ambientContext = null }) {
  const [tab, setTab]           = useState(initialTab) // 'mine' | 'submit'
  const [items, setItems]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [toast, setToast]       = useState(null)
  // The seed rides exactly one submission; a second report from the same
  // open modal starts clean (same rule as before).
  const [liveSeed, setLiveSeed] = useState(seed)
  // Remount the intake after a send so a second report starts at the door.
  const [intakeKey, setIntakeKey] = useState(0)
  const bodyRef = useRef(null)
  const isMobile = useIsMobile()
  const vvHeight = useVisualViewportHeight(isMobile)

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

  async function afterSubmit() {
    setLiveSeed(null)
    setIntakeKey(k => k + 1)
    setTab('mine')
    setToast("Sent! We'll read it and write back.")
    await loadItems()
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }

  const tabBtn = (key, label) => (
    <button
      onClick={() => setTab(key)}
      style={{ flex:1, minHeight:'48px', padding:'11px', background:'none', border:'none', borderBottom: tab === key ? '2px solid #1a2e2b' : '2px solid transparent', cursor:'pointer', fontFamily:'inherit', fontWeight: tab === key ? 700 : 500, color: tab === key ? '#1a2e2b' : '#8a9e9a' }}>
      {label}
    </button>
  )

  // Mobile: a top-anchored sheet that is exactly as tall as the visible
  // viewport, so the keyboard shrinks it instead of covering it. Desktop:
  // the centred modal as before.
  const shell = isMobile
    ? { position:'fixed', inset:0, zIndex:10120, display:'flex', alignItems:'flex-start', justifyContent:'center', padding:0, background:'rgba(26,46,43,0.55)', fontFamily:'"DM Sans",system-ui,sans-serif' }
    : { position:'fixed', inset:0, zIndex:10120, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px', background:'rgba(26,46,43,0.55)', fontFamily:'"DM Sans",system-ui,sans-serif' }
  const panel = isMobile
    ? { background:'white', width:'100%', height: vvHeight ? `${vvHeight}px` : '100dvh', maxHeight: vvHeight ? `${vvHeight}px` : '100dvh', display:'flex', flexDirection:'column', overflow:'hidden', borderRadius:0 }
    : { background:'white', borderRadius:'16px', width:'100%', maxWidth:'600px', maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.25)', overflow:'hidden' }

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose() }} style={shell} data-feedback-modal={isMobile ? 'sheet' : 'modal'}>
      <div style={panel}>
        {/* Sticky header */}
        <div style={{ padding:'12px 16px', borderBottom:'1px solid rgba(0,0,0,0.07)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'12px', flexShrink:0 }}>
          <h2 style={{ fontSize:'17px', fontFamily:'Georgia,serif', color:'#1a2e2b', margin:0 }}>🐛 Feedback</h2>
          <button onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:'#8a9e9a', cursor:'pointer', fontSize:'24px', lineHeight:1, padding:0, width:'44px', height:'44px' }}>×</button>
        </div>
        {/* Tab strip */}
        <div style={{ display:'flex', borderBottom:'1px solid rgba(0,0,0,0.07)', flexShrink:0 }}>
          {tabBtn('mine', 'My Items')}
          {tabBtn('submit', 'Submit')}
        </div>
        {/* Scrollable body */}
        <div ref={bodyRef} style={{ padding:'18px 20px 28px', overflowY:'auto', flex:1, WebkitOverflowScrolling:'touch', overscrollBehavior:'contain' }}>
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
                <p style={{ fontSize:'12px', color:'#8a9e9a', lineHeight:1.5 }}>Switch to the Submit tab to report a problem, share an idea, or ask a question.</p>
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:'10px' }}>
                {/* allowReply: only for the real session's own items — under
                    view-as these are the IMPERSONATED user's reports, and the
                    server would refuse the write anyway (submitter only). */}
                {items.map(it => (
                  <FeedbackItemCard
                    key={it.id}
                    item={it}
                    allowReply={!viewAsUserId}
                    onReplied={(id, row) => setItems(prev => prev.map(i => i.id === id
                      ? { ...i, replies: [...(Array.isArray(i.replies) ? i.replies : []), row] }
                      : i))}
                  />
                ))}
              </div>
            )
          ) : (
            <GuidedIntake key={intakeKey} seed={liveSeed} ambientContext={ambientContext} onSubmitted={afterSubmit} />
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
