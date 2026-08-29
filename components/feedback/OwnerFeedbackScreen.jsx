// components/feedback/OwnerFeedbackScreen.jsx
// ─────────────────────────────────────────────────────────────
// "What you've told us" — the franchise owner/manager view of their own
// location's feedback. Issue 235.
//
// WHY THIS IS A SEPARATE COMPONENT AND NOT ANOTHER PROP ON THE TRIAGE SCREEN.
// Until now owners mounted components/admin/AdminFeedbackScreen with one prop
// flipped, which meant a paying franchise owner was looking at Bee Organized's
// internal triage console: queue cards naming our own neglect ("Going stale —
// quiet 14+ days, worst 19 days"), their nineteen fixed things collapsed behind
// a "Show 19 closed" toggle, an "Everyone / Just mine" pair that could never
// differ because no location has a second submitter, a search box offering to
// search by submitter name, and — worst — status buttons and a reply box, so an
// owner could mark their own bug Fixed and write themselves a reply. None of
// that was designed for this reader. It was the admin screen with one prop.
//
// WHAT THIS SCREEN IS FOR, in one line: telling someone what happened to the
// thing they reported. That is why THE REPLY IS THE BODY OF THE CARD — the
// team's actual words, quoted, dated — and not a badge saying "Replied".
//
// WHAT IT DELIBERATELY DOES NOT HAVE:
//   · no status control, no reply box, no "From: <your own name>"
//   · no queue cards, no oldest-waiting, no going-stale, no
//     replied-but-still-marked-New — those are metrics about OUR backlog and
//     they belong on the triage screen, which keeps every one of them
//   · nothing hidden behind a toggle: Done is a TAB, because nineteen fixed
//     things are the evidence that reporting works, and evidence that reporting
//     works is what makes someone report again
//
// WHAT IT OPENS ON (issue 236). Not everything — the open items. The first
// build's default tab was "Everything", so the Palm Beach owner's default view
// was thirty-one cards, nineteen of them already fixed, and the four things
// still owed an answer were scattered among them. That is the same fault issue
// 233 fixed on the triage side by hiding closed items, arrived at from the
// other direction. Done stays a tab — the evidence still matters, it just
// should not be the first thing in the way.
//
// READS ONLY. The one write in the whole file is POST /api/feedback/seen, which
// stamps "I have seen this reply" and exists solely to turn the banner off.
'use client'

import React, { useState, useEffect, useMemo, useCallback, useContext } from 'react'
import { T } from '@/components/hive/shared/tokens'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { IconPlus, IconPaperclip } from '@/components/ui/icons'
import { FeedbackAttachmentList } from '@/components/feedback/feedbackShared'
// The "has it been seen since it was written?" kernel (issue 306). It moved to
// lib/feedback-queues so triage could ask the same question from the other end
// — "are they still waiting?" — without a second copy of the comparison. This
// screen's isUnreadReply keeps its own two clauses (a reply exists, and it is
// MINE) and delegates only the timestamp test.
import { isReplyUnseen, hasFeedbackReply } from '@/lib/feedback-queues'
// The conversation thread (feedback_replies) plus the legacy single-reply
// merge, and the "may THIS viewer write back?" rule. One home for both — the
// triage modal renders the same thread from the same builder.
import { buildFeedbackThread, ownerCanReply } from '@/lib/feedback-replies'

// ── THE FOUR PLAIN WORDS ──────────────────────────────────────
// Six database statuses, four words an owner would actually use. The mapping
// is not one-to-one and that is deliberate:
//
//   in_progress → "Planned", not "Being looked at". Both of the middle words
//   are claims about what happens next: "Being looked at" means we have not
//   decided, "Planned" means we have. in_progress means we are already
//   building it, so "Being looked at" would walk it BACKWARDS. "Planned"
//   understates how far along it is; it does not misstate the direction.
//
//   declined → "Not planned" is a FIFTH word the mockup does not show, and it
//   has to exist. The alternative is letting a declined item wear one of the
//   other four, and the only one it could plausibly wear is "Fixed" — telling
//   someone we fixed a thing we decided not to do. One production item is
//   declined today, so this is a live case, not a hypothetical.
const OWNER_STATUS = {
  submitted:    { label: 'Sent',            family: 'quiet' },
  under_review: { label: 'Being looked at', family: 'amber' },
  planned:      { label: 'Planned',         family: 'blue'  },
  in_progress:  { label: 'Planned',         family: 'blue'  },
  // The happy ending for a question (legal on any type): resolved with words,
  // nothing shipped. Teal, not Fixed's green — both read as "done well", but
  // "Answered" must never imply something was broken and repaired.
  answered:     { label: 'Answered',        family: 'teal'  },
  shipped:      { label: 'Fixed',           family: 'green' },
  declined:     { label: 'Not planned',     family: 'gray'  },
}
const FALLBACK_STATUS = OWNER_STATUS.submitted

const CLOSED = ['answered', 'shipped', 'declined']

export function isDoneItem(item) {
  return CLOSED.includes(String(item?.status || ''))
}
export function hasReply(item) {
  return hasFeedbackReply(item)
}

// "Is this reply news to the person who wrote the report?"
//
// Three conditions, each load-bearing:
//   1. there is a reply at all
//   2. the viewer is the one who FILED it — a manager reading the owner's
//      answered item is reading someone else's mail, not receiving their own
//   3. it has not been seen since it was last written — the timestamp compare
//      (not a boolean) is what makes a SECOND reply on an already-read item
//      count as new again
export function isUnreadReply(item, myId) {
  if (!hasReply(item)) return false
  if (!myId || item.user_id !== myId) return false
  return isReplyUnseen(item)
}

// Owner-facing age. Stays in DAYS rather than flipping to a calendar date at
// thirty the way the triage formatter does: "58 days ago" is the fact that
// matters to someone waiting, and "Jun 17, 2026" makes them do the subtraction.
// WHICH TAB THIS SCREEN OPENS ON. Issue 236.
//
// Open, except when there is nothing open and something finished — then Done.
// That exception is the whole reason this is a function rather than a constant.
// Ten of the twenty-one owners have filed once or twice; an owner whose single
// report was fixed last month has zero open items and one done one, and
// defaulting them to an empty "Nothing open" card would be a worse first screen
// than the crowded list this change is fixing. They land on their fixed thing.
//
// Note it never returns 'done' for someone with NOTHING at all — that case has
// no tab row and gets the invitation-to-report empty state instead.
export function defaultTabFor(counts) {
  if (counts.open === 0 && counts.done > 0) return 'done'
  return 'open'
}

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

const SMALL_NUMBERS = ['no', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']
function countWord(n) {
  return n < SMALL_NUMBERS.length ? SMALL_NUMBERS[n] : String(n)
}

// The banner sentence. Names the reports rather than counting them — "the team
// replied about X and Y" is a thing that happened; "you have 2 unread items" is
// a database state. Past two, it names two and totals the rest, because a
// sentence listing twenty-six titles is not a sentence.
export function unreadSentence(items) {
  const titles = items.map(i => String(i.title || '').trim()).filter(Boolean)
  if (titles.length === 0) return ''
  const quoted = titles.map(t => `“${t}”`)
  if (quoted.length === 1) return `The team got back to you about ${quoted[0]}.`
  if (quoted.length === 2) return `The team got back to you about ${quoted[0]} and ${quoted[1]}.`
  return `The team got back to you about ${quoted[0]}, ${quoted[1]} and ${quoted.length - 2} more.`
}

// ── status pill ───────────────────────────────────────────────
function StatePill({ status }) {
  const conf = OWNER_STATUS[status] || FALLBACK_STATUS
  const fam = T.family[conf.family] || T.family.quiet
  return (
    <span style={{
      fontSize: '11.5px', fontWeight: 600, padding: '3px 9px',
      borderRadius: T.radius.pill, whiteSpace: 'nowrap',
      background: fam.bg, color: fam.text,
    }}>
      {conf.label}
    </span>
  )
}

// ── the conversation ──────────────────────────────────────────
// The green rule and the "The team replied, N days ago" line are the two things
// this screen exists to show — now once per entry, because a reply can be
// answered and answered again. Team words render as quoted prose, never a form
// field (the issue 233 lesson); the viewer's own replies render quieter, on the
// same rail, so the exchange reads top-to-bottom like the conversation it is.
//
// The New pill rides the LAST team entry only — it is the unread marker, and
// what is unread is the latest thing the team said.
function ThreadEntry({ entry, item, mine, isNew }) {
  const team = entry.authorRole === 'team'
  const who = team
    ? 'The team replied'
    : (mine ? 'You replied' : `${item.submitter_name || 'They'} replied`)
  const accent = team ? T.state.success.fg : T.ink.muted
  return (
    <div style={{
      background: team ? T.accent.faint : T.surface.sunken,
      borderLeft: `3px solid ${accent}`,
      borderRadius: '0 8px 8px 0',
      padding: '11px 14px', marginTop: '11px',
    }}>
      <p style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        fontSize: '12.5px', fontWeight: 600, color: team ? T.state.success.fg : T.ink.secondary, marginBottom: '3px',
      }}>
        <span>{team ? '💬 ' : ''}{who}{entry.createdAt ? `, ${agoPhrase(entry.createdAt)}` : ''}</span>
        {isNew && (
          <span style={{
            fontSize: '10.5px', fontWeight: 700, padding: '1px 7px',
            borderRadius: T.radius.pill, background: T.state.success.fg, color: T.ink.inverse,
          }}>
            New
          </span>
        )}
      </p>
      <p style={{ margin: 0, fontSize: '14.5px', color: T.ink.secondary, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {entry.body}
      </p>
    </div>
  )
}

// ── writing back ──────────────────────────────────────────────
// The submitter's side of the conversation. Only ever rendered for the person
// who filed the report (ownerCanReply), and only once the team has said
// something — answering is what this box is for. POST /api/feedback/:id/replies
// stores it; no email leaves the app for it, the team sees it on the triage
// list as "They replied — needs an answer".
function ReplyComposer({ item, onReplied }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          marginTop: '10px', padding: 0, background: 'none', border: 'none',
          color: T.accent.fg, fontFamily: 'inherit', fontSize: '13.5px',
          fontWeight: 600, cursor: 'pointer',
        }}
      >
        Reply to the team
      </button>
    )
  }

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
      setOpen(false)
      onReplied(item.id, row)
    } catch {
      // The words are still in the box — the one failure that must not lose them.
      setError('Couldn’t send your reply. Please try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ marginTop: '10px' }}>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Write back to the team — they’ll see it on your report."
        style={{
          width: '100%', padding: '10px 12px', border: T.border.thin,
          borderRadius: '8px', fontSize: '14px', fontFamily: 'inherit',
          color: T.ink.primary, background: T.surface.raised, boxSizing: 'border-box',
          outline: 'none', resize: 'vertical', lineHeight: 1.5,
        }}
      />
      {error && <p style={{ fontSize: '12.5px', color: T.state.danger.strong, margin: '6px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '8px', marginTop: '7px' }}>
        <button
          type="button"
          onClick={send}
          disabled={sending || !text.trim()}
          style={{
            padding: '8px 16px', background: T.ink.primary, color: T.ink.inverse,
            border: 'none', borderRadius: T.radius.control, fontSize: '13.5px',
            fontFamily: 'inherit', fontWeight: 600,
            cursor: (sending || !text.trim()) ? 'default' : 'pointer',
            opacity: (sending || !text.trim()) ? 0.6 : 1,
          }}
        >
          {sending ? 'Sending…' : 'Send reply'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null) }}
          style={{
            padding: '8px 12px', background: 'transparent', border: 'none',
            color: T.ink.muted, fontFamily: 'inherit', fontSize: '13.5px',
            fontWeight: 500, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── one card ──────────────────────────────────────────────────
function ItemCard({ item, myId, expanded, onToggle, onReplied }) {
  const mine = !!myId && item.user_id === myId
  const atts = Array.isArray(item.attachments) ? item.attachments : []
  const thread = buildFeedbackThread(item)
  const replied = thread.length > 0 || hasReply(item)
  const isNew = isUnreadReply(item, myId)
  // The unread marker rides the LAST team entry — what is unread is the latest
  // thing the team said, and a second reply makes an already-read item new
  // again (the timestamp compare in lib/feedback-queues).
  const lastTeamId = [...thread].reverse().find(e => e.authorRole === 'team')?.id || null

  return (
    <div style={{
      background: T.surface.raised, borderRadius: T.radius.inset,
      border: T.border.thin, overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          width: '100%', display: 'block', textAlign: 'left', cursor: 'pointer',
          background: 'transparent', border: 'none', fontFamily: 'inherit',
          padding: '16px 18px 0',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: '9px', marginBottom: '4px', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: '16px', color: T.ink.primary }}>{item.title}</span>
          <StatePill status={item.status} />
          <span style={{ fontSize: '13px', color: T.ink.quiet }}>· {agoPhrase(item.created_at)}</span>
        </span>
        {/* Someone ELSE at this location filed it. No location has a second
            submitter today, but the screen must not assume one — and when it
            happens, "who" is the first thing the reader needs. Never shown for
            your own report: reading your own name back at you is what the
            triage screen did. */}
        {!mine && item.submitter_name && (
          <span style={{ display: 'block', fontSize: '13px', color: T.ink.quiet, marginBottom: '4px' }}>
            Reported by {item.submitter_name}
          </span>
        )}
        {item.description && (
          <span style={{
            display: '-webkit-box', WebkitBoxOrient: 'vertical',
            WebkitLineClamp: expanded ? 'unset' : 2,
            overflow: expanded ? 'visible' : 'hidden',
            fontSize: '14.5px', color: T.ink.secondary, lineHeight: 1.5,
            marginBottom: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {item.description}
          </span>
        )}
      </button>

      <div style={{ padding: '0 18px 16px' }}>
        {replied
          ? (
            <>
              {thread.map(e => (
                <ThreadEntry
                  key={e.id}
                  entry={e}
                  item={item}
                  mine={mine}
                  isNew={isNew && e.id === lastTeamId}
                />
              ))}
              {ownerCanReply(item, myId) && <ReplyComposer item={item} onReplied={onReplied} />}
            </>
          )
          : <p style={{ fontSize: '13.5px', color: T.ink.quiet, fontStyle: 'italic', margin: 0 }}>
              Nobody&rsquo;s replied yet.
            </p>}

        {atts.length > 0 && (
          <div style={{ marginTop: '11px' }}>
            {mine ? (
              // Own attachments: the signed-URL endpoint allows the path's
              // owner, so thumbnails resolve.
              <FeedbackAttachmentList attachments={atts} thumb={64} />
            ) : (
              // A colleague's attachment 403s for an owner (the endpoint allows
              // the path owner or corp admins, and an owner is neither). A
              // count reads as a fact; a broken thumbnail reads as a bug.
              <p style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13px', color: T.ink.quiet, margin: 0 }}>
                <IconPaperclip size={12} />
                {atts.length} attachment{atts.length === 1 ? '' : 's'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── empty states ──────────────────────────────────────────────
// The all-empty case is the COMMON one and it is the reason this copy is not
// "No items found". Ten of twenty-one owners have never filed anything and
// seven of the eleven who have filed once or twice, so most people who open
// this screen will open it onto nothing. An empty screen that reads like a
// failed search teaches them the screen is broken; this one tells them what to
// send, that a person reads it, and — the part nobody could have known before
// this screen existed — that the answer comes back HERE.
const EMPTY = {
  none: {
    title: 'Nothing here yet',
    body: 'When something looks wrong, or you think of something that would make the work easier, tell us. We read every one and write back — and the reply turns up right here.',
  },
  // Only reachable by CLICKING Open when it is empty — an owner whose items are
  // all finished is landed on Done instead (see defaultTabFor), because opening
  // onto an empty tab is worse than the crowding issue 236 set out to fix.
  open: {
    title: 'Nothing open',
    body: 'Everything you’ve sent us has been dealt with. It’s all under Done.',
  },
  answered: {
    title: 'No replies yet',
    body: 'When the team writes back about something you’ve sent, their answer appears here.',
  },
  waiting: {
    title: 'Nothing waiting',
    body: 'The team has replied to everything you’ve sent.',
  },
  done: {
    title: 'Nothing finished yet',
    body: 'When something you reported gets fixed, it moves here so you can see it landed.',
  },
}

function EmptyCard({ kind }) {
  const copy = EMPTY[kind] || EMPTY.none
  return (
    <div style={{
      background: T.surface.raised, borderRadius: T.radius.inset, border: T.border.thin,
      padding: '34px 24px', textAlign: 'center',
    }}>
      <p style={{ fontFamily: 'Georgia,serif', fontWeight: 600, fontSize: '18px', color: T.ink.primary, marginBottom: '6px', lineHeight: 1.3 }}>
        {copy.title}
      </p>
      <p style={{ color: T.ink.secondary, fontSize: '14.5px', margin: '0 auto', maxWidth: '380px', lineHeight: 1.55 }}>
        {copy.body}
      </p>
    </div>
  )
}

// ── the screen ────────────────────────────────────────────────
export default function OwnerFeedbackScreen({
  // Opens the existing FeedbackModal on its Submit tab. The compose path and
  // the record-menu "Report a problem" entry points are unchanged by issue 235.
  onReportSomething = null,
  // View-as parity, same contract the old franchise mount had: the route
  // hard-scopes a real owner/manager to their own location and honors
  // ?location_id= only for elevated (impersonating) callers.
  locationId = null,
}) {
  const [items, setItems]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  // null means "the reader has not chosen a tab yet", NOT a tab. The default is
  // derived from counts the moment they arrive (issue 236) — as a derivation
  // rather than an effect that writes state, so nothing can race the fetch and
  // nothing can overwrite a tab the reader has since clicked.
  const [tab, setTab]         = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  // The unread set is SNAPSHOTTED at load, before we mark anything seen —
  // otherwise stamping would erase the banner in the same render that earned
  // it. This is what the banner counts; the per-card "New" pills read from it
  // too, so the two always agree.
  const [unreadIds, setUnreadIds] = useState([])

  const currentUser = useContext(CurrentUserContext)
  const myId = currentUser?.id || null

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // The location-scoped list. For a real owner/manager the server ignores
      // any location override and returns their own location only.
      const url = locationId
        ? `/api/admin/feedback?location_id=${encodeURIComponent(locationId)}`
        : '/api/admin/feedback'
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const rows = Array.isArray(data.items) ? data.items : []
      setItems(rows)

      // Does this database know about reply_seen_at yet? An un-migrated column
      // comes back absent, not null — so if no row carries the key we show no
      // banner at all rather than declaring every old reply "new".
      const supported = rows.some(r => Object.prototype.hasOwnProperty.call(r, 'reply_seen_at'))
      const unread = supported ? rows.filter(r => isUnreadReply(r, myId)) : []
      setUnreadIds(unread.map(r => r.id))

      if (unread.length > 0) {
        // Fire and forget: the banner is already rendered from the snapshot,
        // and a failure here just means it shows again next time — which is a
        // far better failure than hiding a reply.
        fetch('/api/feedback/seen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: unread.map(r => r.id) }),
        }).catch(() => {})
      }
    } catch (e) {
      setError('Couldn’t load your reports. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [locationId, myId])

  useEffect(() => { load() }, [load])

  const counts = useMemo(() => {
    let answered = 0, waiting = 0, done = 0
    for (const i of items) {
      if (isDoneItem(i)) done++
      else if (hasReply(i)) answered++
      else waiting++
    }
    return { answered, waiting, done, open: answered + waiting, total: items.length }
  }, [items])

  const activeTab = tab || defaultTabFor(counts)

  // Open first, and it carries a count now that it is the landing tab — the
  // reader should see how much is actually outstanding without doing the
  // subtraction. Answered and Waiting split Open; Done is everything decided.
  const TABS = [
    { key: 'open',     label: 'Open',     count: counts.open },
    { key: 'answered', label: 'Answered', count: counts.answered },
    { key: 'waiting',  label: 'Waiting',  count: counts.waiting },
    { key: 'done',     label: 'Done',     count: counts.done },
  ]

  const shown = useMemo(() => {
    const rows = items.filter(i => {
      if (activeTab === 'done') return isDoneItem(i)
      if (activeTab === 'answered') return !isDoneItem(i) && hasReply(i)
      if (activeTab === 'waiting') return !isDoneItem(i) && !hasReply(i)
      return !isDoneItem(i)
    })
    // Newest first. There is no "longest waiting" sort here on purpose — that
    // ordering exists on the triage screen because it is a work queue. This is
    // someone's own history and it reads as one.
    return [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [items, activeTab])

  const unreadItems = useMemo(
    () => items.filter(i => unreadIds.includes(i.id)),
    [items, unreadIds],
  )

  const toggle = (id) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  // A sent reply lands in the item's thread in place — no refetch, so the
  // screen doesn't scroll away from the conversation the person is having.
  const appendReply = useCallback((itemId, row) => {
    setItems(prev => prev.map(i => i.id === itemId
      ? { ...i, replies: [...(Array.isArray(i.replies) ? i.replies : []), row] }
      : i))
  }, [])

  const subtitle = counts.total === 0
    ? 'Nothing sent in yet'
    : `${counts.open} thing${counts.open === 1 ? '' : 's'} · ${counts.answered} answered · ${counts.waiting} still with the team`

  return (
    // CONTROLS DO NOT STRETCH. The column caps at 760px and every control in it
    // (tabs, the report button) takes its natural width and sits where it lands
    // — no full-bleed buttons, which is what made the last two screens look
    // wrong.
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '26px 20px 70px', fontFamily: 'DM Sans,system-ui,sans-serif' }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '22px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: 'Georgia,"Iowan Old Style",serif', fontWeight: 600, fontSize: '26px', lineHeight: 1.2, color: T.ink.primary, margin: '0 0 3px' }}>
            What you&rsquo;ve told us
          </h1>
          <p style={{ color: T.ink.secondary, fontSize: '14px', margin: 0 }}>
            {loading || error ? '—' : subtitle}
          </p>
        </div>
        {onReportSomething && (
          <button
            type="button"
            onClick={onReportSomething}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '7px',
              background: T.ink.primary, color: T.ink.inverse, border: 'none',
              borderRadius: T.radius.control, padding: '11px 18px',
              fontFamily: 'inherit', fontSize: '15px', fontWeight: 600,
              cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            <IconPlus size={13} /> Report something
          </button>
        )}
      </div>

      {/* THE BANNER. Only ever about replies to the VIEWER'S OWN reports. */}
      {!loading && !error && unreadItems.length > 0 && (
        <div style={{
          background: T.state.success.soft, borderRadius: '11px',
          padding: '14px 17px', marginBottom: '20px',
          display: 'flex', gap: '12px', alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: '19px', lineHeight: 1.2 }}>💬</span>
          <div>
            <b style={{ display: 'block', color: T.state.success.fg, fontSize: '15px', marginBottom: '2px' }}>
              {countWord(unreadItems.length)} new {unreadItems.length === 1 ? 'reply' : 'replies'}
            </b>
            <span style={{ color: T.state.success.fg, fontSize: '14px', lineHeight: 1.5 }}>
              {unreadSentence(unreadItems)}
            </span>
          </div>
        </div>
      )}

      {!loading && !error && counts.total > 0 && (
        <div style={{ display: 'flex', gap: '7px', marginBottom: '16px', flexWrap: 'wrap' }}>
          {TABS.map(t => {
            const on = activeTab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-pressed={on}
                style={{
                  border: on ? `1px solid ${T.ink.primary}` : T.border.thin,
                  background: on ? T.ink.primary : T.surface.raised,
                  color: on ? T.ink.inverse : T.ink.secondary,
                  borderRadius: T.radius.pill, padding: '7px 15px',
                  fontSize: '14px', fontFamily: 'inherit', cursor: 'pointer',
                }}
              >
                {t.label}{t.count != null ? ` · ${t.count}` : ''}
              </button>
            )
          })}
        </div>
      )}

      {loading ? (
        <BeeLoader size="screen" label="Gathering your reports…" />
      ) : error ? (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ fontSize: '13px', color: T.state.danger.strong, marginBottom: '10px' }}>{error}</p>
          <button onClick={load} style={{ padding: '8px 16px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', fontWeight: 600, color: T.accent.onFill, cursor: 'pointer' }}>Retry</button>
        </div>
      ) : shown.length === 0 ? (
        <EmptyCard kind={counts.total === 0 ? 'none' : activeTab} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
          {shown.map(it => (
            <ItemCard
              key={it.id}
              item={it}
              myId={myId}
              expanded={expanded.has(it.id)}
              onToggle={() => toggle(it.id)}
              onReplied={appendReply}
            />
          ))}
        </div>
      )}
    </div>
  )
}
