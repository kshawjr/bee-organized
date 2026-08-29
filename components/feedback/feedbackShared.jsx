// components/feedback/feedbackShared.jsx
// Shared feedback presentation + helpers, extracted verbatim from BeeHub.jsx so
// FeedbackModal can live in its own (mount-testable) module. The triage screen
// (components/admin/AdminFeedbackScreen) re-imports the status maps +
// FeedbackStatusBadge/AttachmentList/timeAgo; BeeHub.jsx keeps only timeAgo.
'use client'
import React, { useState } from 'react'
// The plain-word status vocabulary moved to a server-safe module (issue 233) so
// the reply email can speak the same words as the UI — an API route cannot
// import this 'use client' file. Re-exported below, so every existing importer
// of FEEDBACK_STATUS_PLAIN from here keeps working and there is still one home.
import { FEEDBACK_STATUS_PLAIN } from '@/lib/feedback-queues'
// The conversation thread + the "does this item invite a reply?" rule — the
// same builders the owner screen and the triage modal use, so all three
// surfaces render one history from one definition.
import { buildFeedbackThread, threadInvitesReply } from '@/lib/feedback-replies'

const FEEDBACK_STATUS_CONF = {
  submitted:    { label:'Submitted',    color:'#085041', bg:'#E1F5EE' },
  under_review: { label:'Under Review', color:'#0C447C', bg:'#E6F1FB' },
  planned:      { label:'Planned',      color:'#3C3489', bg:'#EEEDFE' },
  in_progress:  { label:'In Progress',  color:'#633806', bg:'#FAEEDA' },
  // The teal pair (T.family.teal) — a happy ending like Fixed, but the
  // conversational one: resolved with words, nothing shipped.
  answered:     { label:'Answered',     color:'#03403C', bg:'#E3EEEC' },
  shipped:      { label:'Shipped',      color:'#27500A', bg:'#EAF3DE' },
  declined:     { label:'Declined',     color:'#444441', bg:'#F1EFE8' },
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

// The glyph per type (issue 247 step 2). Was `type === 'bug' ? '🐛' : '✨'`,
// which gave a hazard the sparkle an idea wears.
//
// AN OWNER CANNOT REACH THE NEW GLYPHS — decision and hazard exist only on
// internal rows, which every owner-facing read excludes server-side. This card
// still needs them because the SAME card renders in the "My Items" tab for an
// ELEVATED viewer, where Kevin's own internal items do appear.
//
// An unrecognised type gets a neutral pin, never another type's glyph.
const FEEDBACK_TYPE_EMOJI = { bug: '🐛', feature: '✨', question: '❓', decision: '🔀', hazard: '⚠️' }
function feedbackTypeEmoji(type) {
  return FEEDBACK_TYPE_EMOJI[String(type || '')] || '📌'
}

// One card in the "My Items" tab — handles its own show-more collapse.
//
// THE THREAD AND THE REPLY BOX LIVE HERE TOO. The reply email's button lands
// on this tab (the one surface every role can reach), so the promise the email
// makes — "tap the button and reply right on your report" — has to be true
// HERE, not only on the owner nav screen. allowReply comes from the mount:
// false under view-as (those are someone else's items; the server would refuse
// the write anyway) and for any read-only rendering.
function FeedbackItemCard({ item, allowReply = false, onReplied = () => {} }) {
  const [expanded, setExpanded] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [replyError, setReplyError] = useState(null)
  const long = (item.description || '').length > 150
  const shown = !long || expanded ? item.description : `${item.description.slice(0, 150)}…`
  const thread = buildFeedbackThread(item)
  const canReply = allowReply && threadInvitesReply(item)

  const sendReply = async () => {
    const body = replyText.trim()
    if (!body || sending) return
    setSending(true)
    setReplyError(null)
    try {
      const res = await fetch(`/api/feedback/${item.id}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const row = await res.json()
      setReplyText('')
      setReplyOpen(false)
      onReplied(item.id, row)
    } catch {
      // The words stay in the box — the one failure that must not lose them.
      setReplyError('Couldn’t send your reply. Please try again.')
    } finally {
      setSending(false)
    }
  }
  return (
    <div style={{ border:'1px solid rgba(0,0,0,0.08)', borderRadius:'12px', padding:'14px', background:'white' }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'10px', marginBottom:'6px' }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:'8px', minWidth:0 }}>
          <span style={{ fontSize:'18px', lineHeight:1.2, flexShrink:0 }}>{feedbackTypeEmoji(item.type)}</span>
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
      {/* The whole conversation, oldest first — team words and the owner's
          answers, from the same builder every other surface uses. This used to
          show only the LATEST team reply (admin_response), which made the
          email's "reply right on your report" land on a card with no history
          and no box. */}
      {thread.map(e => {
        const team = e.authorRole === 'team'
        return (
          <div key={e.id} style={{ marginTop:'12px', marginLeft:'26px', padding:'10px 12px', background: team ? 'rgba(168,201,196,0.14)' : 'rgba(0,0,0,0.035)', border: team ? '1px solid rgba(168,201,196,0.3)' : '1px solid rgba(0,0,0,0.08)', borderRadius:'10px' }}>
            <p style={{ fontSize:'11px', fontWeight:700, color:'#1a2e2b', marginBottom:'4px' }}>
              {team ? '💬 Response from team' : 'You replied'}
            </p>
            <p style={{ fontSize:'13px', color:'#1a2e2b', lineHeight:1.55, whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{e.body}</p>
            {e.createdAt && (
              <p style={{ fontSize:'10px', color:'#8a9e9a', marginTop:'5px' }}>{feedbackTimeAgo(e.createdAt)}</p>
            )}
          </div>
        )
      })}
      {canReply && !replyOpen && (
        <button
          type="button"
          onClick={() => setReplyOpen(true)}
          style={{ marginTop:'10px', marginLeft:'26px', padding:0, background:'none', border:'none', color:'#2563eb', fontFamily:'inherit', fontSize:'13px', fontWeight:600, cursor:'pointer' }}
        >
          Reply to the team
        </button>
      )}
      {canReply && replyOpen && (
        <div style={{ marginTop:'10px', marginLeft:'26px' }}>
          <textarea
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Write back to the team — they’ll see it on your report."
            style={{ width:'100%', padding:'9px 11px', border:'1.5px solid rgba(0,0,0,0.1)', borderRadius:'10px', fontSize:'13px', fontFamily:'inherit', color:'#1a2e2b', outline:'none', boxSizing:'border-box', resize:'vertical', lineHeight:1.5 }}
          />
          {replyError && <p style={{ fontSize:'12px', color:'#b91c1c', margin:'6px 0 0' }}>{replyError}</p>}
          <div style={{ display:'flex', gap:'8px', marginTop:'7px' }}>
            <button
              type="button"
              onClick={sendReply}
              disabled={sending || !replyText.trim()}
              style={{ padding:'8px 14px', background:'#1a2e2b', color:'white', border:'none', borderRadius:'8px', fontSize:'13px', fontFamily:'inherit', fontWeight:600, cursor:(sending || !replyText.trim()) ? 'default' : 'pointer', opacity:(sending || !replyText.trim()) ? 0.6 : 1 }}
            >
              {sending ? 'Sending…' : 'Send reply'}
            </button>
            <button
              type="button"
              onClick={() => { setReplyOpen(false); setReplyError(null) }}
              style={{ padding:'8px 10px', background:'transparent', border:'none', color:'#8a9e9a', fontFamily:'inherit', fontSize:'13px', fontWeight:500, cursor:'pointer' }}
            >
              Cancel
            </button>
          </div>
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
