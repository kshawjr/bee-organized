// components/feedback/FeedbackCard.jsx
// ─────────────────────────────────────────────────────────────
// THE ONE FEEDBACK CARD. Every surface that shows someone their own reports —
// Help › My requests for owners and managers (OwnerFeedbackScreen), the same
// tab for lite users and the corp tier (HelpScreen's MyRequestsList) and the
// composer's My Items tab (FeedbackModal) — renders this, and nothing else.
//
// There used to be three: this screen's ItemCard, feedbackShared's
// FeedbackItemCard (hardcoded hex, a 150-character "Show more", "Response from
// team") and the help tab's list of the latter. Same record, three designs,
// and only one of them had an unread marker. A role that genuinely needs less
// gets the actions hidden (readOnly), never a different card.
//
// WHAT THE CARD SHOWS WITHOUT BEING TOUCHED:
//   · the whole description — no clamp, no expand. The old header was a button
//     with aria-expanded that only unclamped two lines, so clicking it looked
//     like nothing happened.
//   · the whole conversation, each team entry in a tinted block saying who and
//     when. These are short; hiding them saved nothing.
//   · on an open item nobody has answered, a plain line saying so — before
//     this, waiting looked exactly like in progress.
//
// WHAT STAMPS IT SEEN. Nothing on load. An item is stamped when the owner acts
// on THAT item: clicks anywhere on it, writes back, or presses "Got it" on the
// New marker. Reading a reply and closing the tab leaves it unread — the
// better error, since the old load-time stamp claimed they had read things
// they never scrolled to.
//
// THE ACTIONS. One prominent action — "Write back" once the team has said
// something, "Change what I wrote" before that (the same lib/feedback-edit
// test decides both, so they swap). "Remove this" is small, grey, underlined
// and on the far side: it really deletes the thread and the attachments, and
// it is offered on answered items where editing is already locked.
'use client'

import React, { useState, useCallback } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { IconPaperclip } from '@/components/ui/icons'
import { FeedbackAttachmentList } from '@/components/feedback/feedbackShared'
import { isReplyUnseen, hasFeedbackReply, FEEDBACK_STATUS_PLAIN } from '@/lib/feedback-queues'
import { buildFeedbackThread, ownerCanReply, isClosedFeedback } from '@/lib/feedback-replies'
import { ownerCanEdit, ownerCanDelete } from '@/lib/feedback-edit'
import { announceFeedbackSeen } from '@/components/feedback/UnreadRepliesBadge'

// ── STATUS COLOURS ────────────────────────────────────────────
// The WORDS are not here: every status label comes from FEEDBACK_STATUS_PLAIN
// (lib/feedback-queues), the one vocabulary the triage screen, the reply email
// and every card share. This map holds only the chip family per status.
//
//   declined → "Not planned" has to exist as its own word: the alternative is
//   a declined item wearing another status's word, and the only one it could
//   plausibly wear is "Fixed".
const OWNER_STATUS = {
  submitted:    { family: 'quiet' },
  under_review: { family: 'amber' },
  planned:      { family: 'blue'  },
  in_progress:  { family: 'blue'  },
  // Teal, not Fixed's green — "Answered" must never imply something was
  // broken and repaired.
  answered:     { family: 'teal'  },
  shipped:      { family: 'green' },
  declined:     { family: 'gray'  },
}
const FALLBACK_STATUS = OWNER_STATUS.submitted

export function isDoneItem(item) {
  return isClosedFeedback(String(item?.status || ''))
}
export function hasReply(item) {
  return hasFeedbackReply(item)
}

// "Is this reply news to the person who wrote the report?"
//   1. there is a reply at all
//   2. the viewer is the one who FILED it — a manager reading the owner's
//      answered item is reading someone else's mail, not receiving their own
//   3. it has not been seen since it was last written — the timestamp compare
//      (not a boolean) is what makes a SECOND reply count as new again
export function isUnreadReply(item, myId) {
  if (!hasReply(item)) return false
  if (!myId || item.user_id !== myId) return false
  return isReplyUnseen(item)
}

// Does this database know about reply_seen_at yet? An un-migrated column comes
// back absent, not null — so if no row carries the key there is no unread
// marker at all rather than every old reply declared "new".
export function seenSupported(rows) {
  return (rows || []).some(r => Object.prototype.hasOwnProperty.call(r, 'reply_seen_at'))
}

// Owner-facing age. Stays in DAYS rather than flipping to a calendar date at
// thirty: "58 days ago" is the fact that matters to someone waiting.
export function agoPhrase(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.floor(hrs / 24)
  if (days < 365) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// The DOM id a card answers to — the banner's links scroll here.
export function feedbackCardId(id) {
  return `feedback-${id}`
}

// ── stamping seen ─────────────────────────────────────────────
// ONE item per call, on purpose: the only callers are an action on that item.
// Fire and forget — the local copy is marked straight away so the marker and
// the banner clear, and a failed POST only means it shows again on the next
// load, which is far better than hiding a reply. Once the POST has come back
// the Help nav badge is told to recount (announceFeedbackSeen), so it drops in
// the same visit — after the stamp, never before, or it would count it again.
export function postFeedbackSeen(id) {
  try {
    return fetch('/api/feedback/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    }).then(() => announceFeedbackSeen(), () => {})
  } catch { return Promise.resolve() }
}

// The four in-place updates every list of cards needs, so the three mounts
// cannot drift: a reply lands in the thread, an edit lands on the card, a
// delete drops it, a stamp clears the marker. No refetch for any of them — the
// screen must not scroll away from the conversation the person is having.
export function useFeedbackCardHandlers(setItems) {
  const markSeen = useCallback((id) => {
    postFeedbackSeen(id)
    const now = new Date().toISOString()
    setItems(prev => prev.map(i => (i.id === id ? { ...i, reply_seen_at: now } : i)))
  }, [setItems])

  // The replies route stamps reply_seen_at itself ("replying implies having
  // read what was there"), so the local copy follows without a second POST —
  // and the badge recounts, the reply having already been saved.
  const appendReply = useCallback((itemId, row) => {
    announceFeedbackSeen()
    const now = new Date().toISOString()
    setItems(prev => prev.map(i => (i.id === itemId
      ? {
          ...i,
          replies: [...(Array.isArray(i.replies) ? i.replies : []), row],
          ...(Object.prototype.hasOwnProperty.call(i, 'reply_seen_at') ? { reply_seen_at: now } : {}),
        }
      : i)))
  }, [setItems])

  // The saved row is the route's own copy, so the card renders what was
  // actually stored rather than what was typed.
  const applyEdit = useCallback((row) => {
    if (!row?.id) return
    setItems(prev => prev.map(i => (i.id === row.id ? { ...i, ...row } : i)))
  }, [setItems])

  const applyDelete = useCallback((itemId) => {
    setItems(prev => prev.filter(i => i.id !== itemId))
  }, [setItems])

  return { markSeen, appendReply, applyEdit, applyDelete }
}

// ── status pill ───────────────────────────────────────────────
function StatePill({ status }) {
  const conf = OWNER_STATUS[status] || FALLBACK_STATUS
  const label = FEEDBACK_STATUS_PLAIN[status] || FEEDBACK_STATUS_PLAIN.submitted
  const fam = T.family[conf.family] || T.family.quiet
  return (
    <span data-feedback-status={status || 'submitted'} style={{
      fontSize: '11.5px', fontWeight: 600, padding: '3px 9px',
      borderRadius: T.radius.pill, whiteSpace: 'nowrap',
      background: fam.bg, color: fam.text,
    }}>
      {label}
    </span>
  )
}

// ── one entry in the conversation ─────────────────────────────
// Team words: a tinted block with a green rule, "The team replied, N days ago"
// — who and when. The viewer's own replies render quieter on the same rail so
// the exchange reads top-to-bottom. The New marker, and its "Got it", ride the
// LAST team entry only — what is unread is the latest thing the team said.
function ThreadEntry({ entry, item, mine, isNew, onGotIt }) {
  const team = entry.authorRole === 'team'
  const who = team
    ? 'The team replied'
    : (mine ? 'You replied' : `${item.submitter_name || 'They'} replied`)
  const accent = team ? T.state.success.fg : T.ink.muted
  return (
    <div data-feedback-entry={team ? 'team' : 'owner'} style={{
      background: team ? T.accent.faint : T.surface.sunken,
      borderLeft: `3px solid ${accent}`,
      borderRadius: '0 8px 8px 0',
      padding: '11px 14px', marginTop: '11px', minWidth: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        fontSize: '12.5px', fontWeight: 600, color: team ? T.state.success.fg : T.ink.secondary, marginBottom: '3px',
      }}>
        <span>{team ? '💬 ' : ''}{who}{entry.createdAt ? `, ${agoPhrase(entry.createdAt)}` : ''}</span>
        {isNew && (
          <span data-feedback-new style={{
            fontSize: '10.5px', fontWeight: 700, padding: '1px 7px',
            borderRadius: T.radius.pill, background: T.state.success.fg, color: T.ink.inverse,
          }}>
            New
          </span>
        )}
        {isNew && onGotIt && (
          <button
            type="button"
            data-feedback-got-it
            onClick={(e) => { e.stopPropagation(); onGotIt() }}
            style={{
              minHeight: '44px', padding: '0 6px', marginLeft: '-2px',
              background: 'none', border: 'none', color: T.state.success.fg,
              fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600,
              textDecoration: 'underline', cursor: 'pointer',
            }}
          >
            Got it
          </button>
        )}
      </div>
      <p style={{ margin: 0, fontSize: '14.5px', color: T.ink.secondary, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {entry.body}
      </p>
    </div>
  )
}

// ── writing back ──────────────────────────────────────────────
// POST /api/feedback/:id/replies stores it; no email leaves the app for it,
// the team sees it on the triage list as "They replied". The route accepts the
// submitter on any of their own items, which is what lets an unanswered item's
// "tell us here" use the same box.
function ReplyComposer({ item, placeholder, onCancel, onReplied }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/feedback/${item.id}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const row = await res.json()
      setText('')
      onReplied(item.id, row)
    } catch {
      // The words are still in the box — the one failure that must not lose them.
      setError('Couldn’t send your reply. Please try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ marginTop: '12px' }}>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder={placeholder}
        aria-label="Write back to the team"
        style={{
          width: '100%', padding: '10px 12px', border: T.border.thin,
          borderRadius: '8px', fontSize: '15px', fontFamily: 'inherit',
          color: T.ink.primary, background: T.surface.raised, boxSizing: 'border-box',
          outline: 'none', resize: 'vertical', lineHeight: 1.5,
        }}
      />
      {error && <p style={{ fontSize: '12.5px', color: T.state.danger.strong, margin: '6px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '8px', marginTop: '7px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={send}
          disabled={sending || !text.trim()}
          style={{ ...primaryButton, opacity: (sending || !text.trim()) ? 0.6 : 1, cursor: (sending || !text.trim()) ? 'default' : 'pointer' }}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button type="button" onClick={onCancel} style={cancelButton}>Cancel</button>
      </div>
    </div>
  )
}

// ── changing your own words ───────────────────────────────────
// Title and description only — not the type, because reclassifying is triage's
// job. The form replaces the card body rather than opening a modal.
function EditForm({ item, onCancel, onSaved }) {
  const [title, setTitle] = useState(String(item.title || ''))
  const [description, setDescription] = useState(String(item.description || ''))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const changed =
    title.trim() !== String(item.title || '').trim() ||
    description.trim() !== String(item.description || '').trim()
  const valid = title.trim().length > 0 && description.trim().length > 0

  const save = async () => {
    if (!valid || !changed || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/feedback/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        // THE STALE-TAB CASE, and the one place the lock is spelled out. A reply
        // landed while this form was open; retrying will never work.
        if (res.status === 409 || err.error === 'edit_locked_after_reply') {
          throw new Error('The team replied while you were editing, so this report is locked now. Your original is safe — write back to them instead and tell them what changed.')
        }
        throw new Error('Couldn’t save your changes. Please try again.')
      }
      const row = await res.json()
      onSaved(row)
    } catch (e) {
      // The typing is still in the boxes — the one failure that must not lose it.
      setError(e?.message || 'Couldn’t save your changes. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const field = {
    width: '100%', padding: '10px 12px', border: T.border.thin,
    borderRadius: '8px', fontSize: '15px', fontFamily: 'inherit',
    color: T.ink.primary, background: T.surface.raised, boxSizing: 'border-box',
    outline: 'none', lineHeight: 1.5,
  }
  const label = { display: 'block', fontSize: '12px', fontWeight: 700, color: T.ink.primary, marginBottom: '5px' }

  return (
    <div style={{ marginTop: '4px', marginBottom: '11px' }}>
      <label style={label} htmlFor={`fb-title-${item.id}`}>What’s it about</label>
      <input id={`fb-title-${item.id}`} value={title} onChange={e => setTitle(e.target.value)} maxLength={100} style={field} />
      <label style={{ ...label, marginTop: '11px' }} htmlFor={`fb-desc-${item.id}`}>What happened</label>
      <textarea id={`fb-desc-${item.id}`} value={description} onChange={e => setDescription(e.target.value)} rows={5} maxLength={2000} style={{ ...field, resize: 'vertical' }} />
      {error && <p style={{ fontSize: '13px', color: T.state.danger.strong, margin: '8px 0 0', lineHeight: 1.5 }}>{error}</p>}
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={save}
          disabled={saving || !valid || !changed}
          style={{ ...primaryButton, opacity: (saving || !valid || !changed) ? 0.6 : 1, cursor: (saving || !valid || !changed) ? 'default' : 'pointer' }}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} style={cancelButton}>Cancel</button>
      </div>
    </div>
  )
}

// ── taking it back ────────────────────────────────────────────
// DELETING IS IRREVERSIBLE AND THE CONFIRMATION SAYS THE IRREVERSIBLE PART, not
// "are you sure?": it is gone for good, the screenshots go with it when there
// are any, and so does the team's answer when there is one. Inline, not a
// browser confirm() — a native dialog could not name the screenshots.
export function deleteConfirmSentence(item) {
  const atts = Array.isArray(item?.attachments) ? item.attachments.length : 0
  const bits = ['This deletes your report for good — we can’t get it back']
  if (atts > 0) bits.push(atts === 1 ? 'and the file you sent goes with it' : `and the ${atts} files you sent go with it`)
  if (hasFeedbackReply(item) || (Array.isArray(item?.replies) && item.replies.some(r => r?.author_role === 'team'))) {
    bits.push('along with what the team wrote back')
  }
  return `${bits.join(', ')}.`
}

function DeleteConfirm({ item, onCancel, onDeleted }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)

  const go = async () => {
    if (deleting) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/feedback/${item.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onDeleted(item.id)
    } catch {
      setError('Couldn’t delete it. Please try again.')
      setDeleting(false)
    }
  }

  return (
    <div data-feedback-delete-confirm style={{ marginTop: '11px', background: T.state.danger.soft, borderRadius: '9px', padding: '13px 15px' }}>
      <p style={{ margin: 0, fontSize: '14px', color: T.state.danger.strong, lineHeight: 1.55, fontWeight: 600 }}>
        {deleteConfirmSentence(item)}
      </p>
      {error && <p style={{ fontSize: '13px', color: T.state.danger.strong, margin: '7px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={go}
          disabled={deleting}
          style={{ ...primaryButton, background: T.state.danger.strong, cursor: deleting ? 'default' : 'pointer', opacity: deleting ? 0.6 : 1 }}
        >
          {deleting ? 'Deleting…' : 'Yes, delete it'}
        </button>
        <button type="button" onClick={onCancel} style={{ ...cancelButton, color: T.ink.secondary, fontWeight: 600 }}>Keep it</button>
      </div>
    </div>
  )
}

// ── button styles ─────────────────────────────────────────────
// Every tap target here is at least 44px tall — owners read this on phones.
const primaryButton = {
  minHeight: '44px', padding: '10px 18px', background: T.ink.primary, color: T.ink.inverse,
  border: 'none', borderRadius: T.radius.control, fontSize: '14px',
  fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const cancelButton = {
  minHeight: '44px', padding: '10px 12px', background: 'transparent', border: 'none',
  color: T.ink.muted, fontFamily: 'inherit', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
}
// Delete's look: small, grey, underlined — a footnote, not a button.
const removeLink = {
  minHeight: '44px', padding: '0 2px', background: 'none', border: 'none',
  color: T.ink.muted, fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 400,
  textDecoration: 'underline', cursor: 'pointer', marginLeft: 'auto',
}

// ── the card ──────────────────────────────────────────────────
export default function FeedbackCard({
  item,
  myId = null,
  // Has the mount decided this item carries an unread reply? The mount decides
  // (it knows whether reply_seen_at exists in this database); the card shows.
  isNew = false,
  // No actions at all, and no stamping — view-as, where these are someone
  // else's reports and the server would refuse every write anyway.
  readOnly = false,
  onSeen = null,
  onReplied = () => {},
  onEdited = () => {},
  onDeleted = () => {},
}) {
  // 'reply' | 'edit' | 'delete' — one gesture at a time on a card.
  const [mode, setMode] = useState(null)
  const mine = !!myId && item.user_id === myId
  const canAct = mine && !readOnly
  const canWriteBack = canAct && ownerCanReply(item, myId)
  const canEdit = canAct && ownerCanEdit(item, myId)
  const canDelete = canAct && ownerCanDelete(item, myId)
  const atts = Array.isArray(item.attachments) ? item.attachments : []
  const thread = buildFeedbackThread(item)
  const teamSpoke = thread.some(e => e.authorRole === 'team') || hasReply(item)
  const waiting = !teamSpoke && !isDoneItem(item)
  const lastTeamId = [...thread].reverse().find(e => e.authorRole === 'team')?.id || null
  const stamp = (!readOnly && isNew && onSeen) ? () => onSeen(item.id) : null

  return (
    // CLICKING THE CARD IS ACTING ON IT. Anywhere on it — the text, a link, a
    // button — stamps this item, and only this item. Keyboard users get the
    // same through "Got it" and the actions.
    <div
      id={feedbackCardId(item.id)}
      data-feedback-card={item.id}
      onClick={stamp || undefined}
      style={{
        background: T.surface.raised, borderRadius: T.radius.inset,
        border: isNew ? `1px solid ${T.state.success.fg}` : T.border.thin,
        padding: '16px 18px', minWidth: 0, boxSizing: 'border-box', scrollMarginTop: '16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '9px', marginBottom: '4px', flexWrap: 'wrap', minWidth: 0 }}>
        <h3 style={{ margin: 0, fontWeight: 600, fontSize: '16px', lineHeight: 1.35, color: T.ink.primary, overflowWrap: 'anywhere' }}>{item.title}</h3>
        <StatePill status={item.status} />
        <span style={{ fontSize: '13px', color: T.ink.quiet }}>· {agoPhrase(item.created_at)}</span>
      </div>
      {/* Someone ELSE at this location filed it — "who" is the first thing the
          reader needs. Never shown for your own report. */}
      {!mine && item.submitter_name && (
        <p style={{ fontSize: '13px', color: T.ink.quiet, margin: '0 0 4px' }}>Reported by {item.submitter_name}</p>
      )}

      {mode === 'edit' ? (
        <EditForm item={item} onCancel={() => setMode(null)} onSaved={(row) => { setMode(null); onEdited(row) }} />
      ) : item.description ? (
        <p style={{ margin: 0, fontSize: '14.5px', color: T.ink.secondary, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {item.description}
        </p>
      ) : null}

      {thread.map(e => (
        <ThreadEntry
          key={e.id}
          entry={e}
          item={item}
          mine={mine}
          isNew={isNew && e.id === lastTeamId}
          onGotIt={stamp}
        />
      ))}

      {/* A WAITING ITEM SAYS SO. Before, it looked exactly like one in
          progress. The invitation is only for the person who filed it; it
          opens the same write-back box, which the team sees as "They
          replied" on their list. */}
      {waiting && (
        <div data-feedback-waiting style={{ marginTop: '11px' }}>
          <p style={{ margin: 0, fontSize: '13.5px', color: T.ink.muted, lineHeight: 1.5 }}>
            Nobody has written back yet.
            {canAct && <> If it&rsquo;s holding you up, tell us here.</>}
          </p>
          {canAct && mode !== 'reply' && (
            <button
              type="button"
              data-feedback-holding
              onClick={() => setMode('reply')}
              style={{ minHeight: '44px', padding: '0 2px', background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontSize: '13.5px', fontWeight: 600, textDecoration: 'underline', cursor: 'pointer' }}
            >
              It&rsquo;s holding me up
            </button>
          )}
        </div>
      )}

      {atts.length > 0 && (
        <div style={{ marginTop: '11px' }}>
          {mine ? (
            <FeedbackAttachmentList attachments={atts} thumb={64} />
          ) : (
            // A colleague's attachment 403s for an owner. A count reads as a
            // fact; a broken thumbnail reads as a bug.
            <p style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13px', color: T.ink.quiet, margin: 0 }}>
              <IconPaperclip size={12} />
              {atts.length} attachment{atts.length === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}

      {mode === 'reply' && (
        <ReplyComposer
          item={item}
          placeholder={teamSpoke
            ? 'Write back to the team — they’ll see it on your report.'
            : 'Tell the team what it’s holding up — they’ll see it on your report.'}
          onCancel={() => setMode(null)}
          onReplied={(id, row) => { setMode(null); onReplied(id, row) }}
        />
      )}

      {/* ONE PROMINENT ACTION, and Remove this well away from it. */}
      {mode === null && (canWriteBack || canEdit || canDelete) && (
        <div data-feedback-actions style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '14px', flexWrap: 'wrap' }}>
          {canWriteBack ? (
            <button type="button" data-feedback-primary="write-back" onClick={() => setMode('reply')} style={primaryButton}>
              Write back
            </button>
          ) : canEdit ? (
            <button type="button" data-feedback-primary="edit" onClick={() => setMode('edit')} style={primaryButton}>
              Change what I wrote
            </button>
          ) : null}
          {canDelete && (
            <button type="button" data-feedback-remove onClick={() => setMode('delete')} style={removeLink}>
              Remove this
            </button>
          )}
        </div>
      )}

      {mode === 'delete' && (
        <DeleteConfirm item={item} onCancel={() => setMode(null)} onDeleted={onDeleted} />
      )}
    </div>
  )
}
