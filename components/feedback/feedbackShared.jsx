// components/feedback/feedbackShared.jsx
// Shared feedback presentation + helpers, extracted verbatim from BeeHub.jsx so
// FeedbackModal can live in its own (mount-testable) module. The triage screen
// (components/admin/AdminFeedbackScreen) re-imports the status maps +
// FeedbackStatusBadge/AttachmentList/timeAgo; BeeHub.jsx keeps only timeAgo.
'use client'
import React from 'react'
// The plain-word status vocabulary moved to a server-safe module (issue 233) so
// the reply email can speak the same words as the UI — an API route cannot
// import this 'use client' file. Re-exported below, so every existing importer
// of FEEDBACK_STATUS_PLAIN from here keeps working and there is still one home.
import { FEEDBACK_STATUS_PLAIN, feedbackStatusWord } from '@/lib/feedback-queues'

// Chip COLOURS per status. No words here — the label comes from
// FEEDBACK_STATUS_PLAIN (lib/feedback-queues), the one status vocabulary.
const FEEDBACK_STATUS_CONF = {
  submitted:    { color:'#085041', bg:'#E1F5EE' },
  under_review: { color:'#0C447C', bg:'#E6F1FB' },
  planned:      { color:'#3C3489', bg:'#EEEDFE' },
  in_progress:  { color:'#633806', bg:'#FAEEDA' },
  // The teal pair (T.family.teal) — a happy ending like Fixed, but the
  // conversational one: resolved with words, nothing shipped.
  answered:     { color:'#03403C', bg:'#E3EEEC' },
  shipped:      { color:'#27500A', bg:'#EAF3DE' },
  declined:     { color:'#444441', bg:'#F1EFE8' },
}
const FEEDBACK_STATUS_ORDER = ['submitted','under_review','planned','in_progress','answered','shipped','declined']

function feedbackTimeAgo(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`
  return new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
}

// Locked chip anatomy (StatusChip spec): 11px/500, padding 2px 8px,
// radius 10px, no border.
function FeedbackStatusBadge({ status }) {
  const conf = FEEDBACK_STATUS_CONF[status] || FEEDBACK_STATUS_CONF.submitted
  // Chip color stays the stored-status family; the label reads in plain words.
  const label = feedbackStatusWord(status || 'submitted')
  return (
    <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:500, lineHeight:1.5, color:conf.color, background:conf.bg, whiteSpace:'nowrap' }}>
      {label}
    </span>
  )
}

// Human-readable byte size: "1.2 MB", "840 KB", "12 B".
function feedbackFmtBytes(n) {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  const kb = b / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

function feedbackIsImage(type) {
  return typeof type === 'string' && type.startsWith('image/')
}

// Build the signed-URL endpoint href for a stored attachment. Each path
// segment is encoded so spaces/specials survive the catch-all route, and the
// route 302-redirects to the real signed URL — so this works as both an <a
// href> (click to open) and an <img src> (thumbnail follows the redirect).
function feedbackAttUrl(path) {
  return '/api/feedback/attachment/' + String(path || '').split('/').map(encodeURIComponent).join('/')
}

// A single attachment, used in My Items + Admin detail. Images render as a
// thumbnail; everything else as a 📎 filename·size chip. Clicking opens the
// file in a new tab via the signed-URL endpoint.
function FeedbackAttachmentChip({ att, thumb = 80 }) {
  const url = feedbackAttUrl(att.path)
  if (feedbackIsImage(att.type)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" title={`${att.name} · ${feedbackFmtBytes(att.size)}`} style={{ display:'inline-block', textDecoration:'none' }}>
        <img src={url} alt={att.name} style={{ width:`${thumb}px`, height:`${thumb}px`, objectFit:'cover', borderRadius:'8px', border:'1px solid rgba(0,0,0,0.1)', display:'block', background:'#f0efe9' }} />
      </a>
    )
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ display:'inline-flex', alignItems:'center', gap:'6px', maxWidth:'220px', padding:'6px 10px', borderRadius:'8px', border:'1px solid rgba(0,0,0,0.12)', background:'white', textDecoration:'none', color:'#1a2e2b', fontSize:'12px', fontFamily:'inherit' }}>
      <span style={{ flexShrink:0 }}>📎</span>
      <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{att.name}</span>
      <span style={{ color:'#8a9e9a', flexShrink:0 }}>· {feedbackFmtBytes(att.size)}</span>
    </a>
  )
}

// Wrapped row of attachment chips. Returns null when there's nothing to show.
function FeedbackAttachmentList({ attachments, thumb = 80 }) {
  const atts = Array.isArray(attachments) ? attachments : []
  if (atts.length === 0) return null
  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:'8px', alignItems:'center' }}>
      {atts.map((a, i) => <FeedbackAttachmentChip key={a.path || i} att={a} thumb={thumb} />)}
    </div>
  )
}

// THE CARD ITSELF IS NOT HERE ANY MORE. FeedbackItemCard (hardcoded hex, a
// 150-character "Show more", no unread marker) was one of three designs for
// the same record; every surface now renders components/feedback/FeedbackCard.

export {
  FEEDBACK_STATUS_CONF, FEEDBACK_STATUS_ORDER, FEEDBACK_STATUS_PLAIN,
  FeedbackStatusBadge, feedbackTimeAgo, feedbackFmtBytes, feedbackIsImage,
  feedbackAttUrl, FeedbackAttachmentChip, FeedbackAttachmentList,
}
