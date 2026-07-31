// components/feedback/feedbackShared.jsx
// Shared feedback presentation + helpers, extracted verbatim from BeeHub.jsx so
// FeedbackModal can live in its own (mount-testable) module. The triage screen
// (components/admin/AdminFeedbackScreen) re-imports the status maps +
// FeedbackStatusBadge/AttachmentList/timeAgo; BeeHub.jsx keeps only timeAgo.
'use client'
import React, { useState } from 'react'

const FEEDBACK_STATUS_CONF = {
  submitted:    { label:'Submitted',    color:'#085041', bg:'#E1F5EE' },
  under_review: { label:'Under Review', color:'#0C447C', bg:'#E6F1FB' },
  planned:      { label:'Planned',      color:'#3C3489', bg:'#EEEDFE' },
  in_progress:  { label:'In Progress',  color:'#633806', bg:'#FAEEDA' },
  shipped:      { label:'Shipped',      color:'#27500A', bg:'#EAF3DE' },
  declined:     { label:'Declined',     color:'#444441', bg:'#F1EFE8' },
}
const FEEDBACK_STATUS_ORDER = ['submitted','under_review','planned','in_progress','shipped','declined']

// Plain-English status labels for the owner-facing surfaces (issue 126). The
// stored values in FEEDBACK_STATUS_ORDER / the DB are UNCHANGED — this is a
// display map only. The audience is non-technical franchise owners, so the
// filter chips, the row badge, and the triage dropdown all read in plain words
// ("Looking at it") instead of the database vocabulary ("under_review").
const FEEDBACK_STATUS_PLAIN = {
  submitted:    'New',
  under_review: 'Looking at it',
  planned:      'Planned',
  in_progress:  'In progress',
  shipped:      'Fixed',
  declined:     'Not planned',
}

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
  const label = FEEDBACK_STATUS_PLAIN[status] || conf.label
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

// One card in the "My Items" tab — handles its own show-more collapse.
function FeedbackItemCard({ item }) {
  const [expanded, setExpanded] = useState(false)
  const long = (item.description || '').length > 150
  const shown = !long || expanded ? item.description : `${item.description.slice(0, 150)}…`
  return (
    <div style={{ border:'1px solid rgba(0,0,0,0.08)', borderRadius:'12px', padding:'14px', background:'white' }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'10px', marginBottom:'6px' }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:'8px', minWidth:0 }}>
          <span style={{ fontSize:'18px', lineHeight:1.2, flexShrink:0 }}>{item.type === 'bug' ? '🐛' : '✨'}</span>
          <p style={{ fontSize:'14px', fontWeight:700, color:'#1a2e2b', lineHeight:1.35, wordBreak:'break-word' }}>{item.title}</p>
        </div>
        <FeedbackStatusBadge status={item.status} />
      </div>
      <p style={{ fontSize:'11px', color:'#8a9e9a', margin:'0 0 8px 26px' }}>{feedbackTimeAgo(item.created_at)}</p>
      <p style={{ fontSize:'13px', color:'#4a5e5a', lineHeight:1.55, margin:'0 0 0 26px', whiteSpace:'pre-wrap', wordBreak:'break-word' }}>
        {shown}
        {long && (
          <button onClick={() => setExpanded(e => !e)} style={{ marginLeft:'6px', background:'none', border:'none', color:'#2563eb', fontFamily:'inherit', fontSize:'13px', fontWeight:600, cursor:'pointer', padding:0 }}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </p>
      {item.admin_response && (
        <div style={{ marginTop:'12px', marginLeft:'26px', padding:'10px 12px', background:'rgba(168,201,196,0.14)', border:'1px solid rgba(168,201,196,0.3)', borderRadius:'10px' }}>
          <p style={{ fontSize:'11px', fontWeight:700, color:'#1a2e2b', marginBottom:'4px' }}>💬 Response from team</p>
          <p style={{ fontSize:'13px', color:'#1a2e2b', lineHeight:1.55, whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{item.admin_response}</p>
          {item.admin_response_at && (
            <p style={{ fontSize:'10px', color:'#8a9e9a', marginTop:'5px' }}>{feedbackTimeAgo(item.admin_response_at)}</p>
          )}
        </div>
      )}
      {Array.isArray(item.attachments) && item.attachments.length > 0 && (
        <div style={{ marginTop:'12px', marginLeft:'26px' }}>
          <p style={{ fontSize:'11px', fontWeight:700, color:'#8a9e9a', marginBottom:'6px' }}>📎 {item.attachments.length} attachment{item.attachments.length !== 1 ? 's' : ''}</p>
          <FeedbackAttachmentList attachments={item.attachments} thumb={80} />
        </div>
      )}
    </div>
  )
}

export {
  FEEDBACK_STATUS_CONF, FEEDBACK_STATUS_ORDER, FEEDBACK_STATUS_PLAIN,
  FeedbackStatusBadge, feedbackTimeAgo, feedbackFmtBytes, feedbackIsImage,
  feedbackAttUrl, FeedbackAttachmentChip, FeedbackAttachmentList, FeedbackItemCard,
}
