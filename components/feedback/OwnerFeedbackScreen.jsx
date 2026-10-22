// components/feedback/OwnerFeedbackScreen.jsx
// ─────────────────────────────────────────────────────────────
// Help › My requests — the franchise owner/manager view of their own
// location's feedback. Issue 235. Only ever mounted inside the Help tab, which
// already carries the heading, so `title` defaults to the tab's name and null
// hides the h1 altogether.
//
// WHY THIS IS A SEPARATE COMPONENT AND NOT ANOTHER PROP ON THE TRIAGE SCREEN.
// Owners once mounted components/admin/AdminFeedbackScreen with one prop
// flipped — Bee Organized's internal triage console, status buttons and all.
// None of that was designed for this reader.
//
// WHAT THIS SCREEN IS FOR, in one line: telling someone what happened to the
// thing they reported. That is why THE REPLY IS THE BODY OF THE CARD — the
// team's actual words, in full, dated — and not a badge saying "Replied".
//
// THE HELP-DESK REDESIGN. 13 of the 19 owners who have ever filed anything
// have five items or fewer, and this screen gave them four tabs whose counts
// overlapped (Open was the sum of Answered and Waiting, and "Not planned" sat
// under a tab called Done), a reply hidden behind a header that did not look
// clickable, and every reply marked read the moment the page loaded. Now:
//
//   · ONE LIST, newest first, no tabs. Under the heading: how many they have
//     sent and how many are still with the team.
//   · CLOSED ITEMS (Fixed, Answered, Not planned) collapse below the open ones
//     behind one link that says how many. When nothing is open they start
//     expanded — an owner whose one report was fixed should land on it, not
//     on a link.
//   · THE THREE DOORS at the top, above the list (components/help/AskStrip).
//   · ONE CARD (components/feedback/FeedbackCard), the same one lite users,
//     the corp tier and the composer's My Items tab get.
//   · UNREAD IS ONLY CLEARED BY ACTING ON THE ITEM. Never on load: the old
//     fire-and-forget POST on load is why "seen" meant nothing — 10 of Angie
//     Ahlstedt's 10 replies are unread, so she has never opened this page at
//     all, and every owner who HAD opened it was marked as having read
//     everything whether or not they scrolled to it. The banner stays until
//     each item is stamped, and its titles are links that scroll to the item.
//
//   · SORT AND FILTER (ClickUp 868mm1h81), put back after the redesign took
//     the tabs away and left nothing in their place. Two plain selects above
//     the list, shown once there are two or more items: Show (everything / not
//     answered yet / replied, still open / closed) and Order (newest / oldest).
//     The four Show choices split the list without overlapping — the old tabs'
//     overlapping counts are the reason they went — and none is called
//     "Answered", which is a closed status here. A banner link to an item the
//     current choice hides switches back to everything first.
//
// WHAT IT DELIBERATELY DOES NOT HAVE:
//   · no status control, no "From: <your own name>"
//   · no queue cards, no oldest-waiting, no going-stale — metrics about OUR
//     backlog belong on the triage screen
//
// THE WRITES IT HAS, all on the person's OWN report only (FeedbackCard):
// write back, change what they wrote until the team replies, remove it (a real
// delete, with a confirmation that says so), and the seen stamp.
'use client'

import React, { useState, useEffect, useMemo, useCallback, useContext } from 'react'
import { T } from '@/components/hive/shared/tokens'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import useIsMobile from '@/components/hive/shared/useIsMobile'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { IconPlus } from '@/components/ui/icons'
import { AskStrip } from '@/components/help/AskStrip'
import { FEEDBACK_STATUS_PLAIN, CLOSED_FEEDBACK_STATUSES } from '@/lib/feedback-queues'
import FeedbackCard, {
  isDoneItem, hasReply, isUnreadReply, seenSupported, feedbackCardId, useFeedbackCardHandlers,
} from '@/components/feedback/FeedbackCard'

// The helpers the tests and other screens import from here.
export { isDoneItem, hasReply, isUnreadReply, agoPhrase, deleteConfirmSentence } from '@/components/feedback/FeedbackCard'

const SMALL_NUMBERS = ['no', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']
function countWord(n) {
  return n < SMALL_NUMBERS.length ? SMALL_NUMBERS[n] : String(n)
}

// The banner sentence. Names the reports rather than counting them — "the team
// replied about X and Y" is a thing that happened; "you have 2 unread items" is
// a database state. Past two, it names two and totals the rest.
export function unreadSentence(items) {
  const titles = items.map(i => String(i.title || '').trim()).filter(Boolean)
  if (titles.length === 0) return ''
  const quoted = titles.map(t => `“${t}”`)
  if (quoted.length === 1) return `The team got back to you about ${quoted[0]}.`
  if (quoted.length === 2) return `The team got back to you about ${quoted[0]} and ${quoted[1]}.`
  return `The team got back to you about ${quoted[0]}, ${quoted[1]} and ${quoted.length - 2} more.`
}

// The same sentence with each title a link to its card. "N more" links to the
// first of the rest — the reader works down from there.
function UnreadSentenceLinks({ items, onJump }) {
  const named = items.filter(i => String(i.title || '').trim())
  if (named.length === 0) return null
  const link = (it, text) => (
    <a
      key={it.id}
      href={`#${feedbackCardId(it.id)}`}
      data-feedback-banner-link={it.id}
      onClick={(e) => { e.preventDefault(); onJump(it.id) }}
      // Inline vertical padding widens the tap area without moving the line.
      style={{ color: 'inherit', fontWeight: 600, textDecoration: 'underline', overflowWrap: 'anywhere', padding: '12px 0' }}
    >
      {text}
    </a>
  )
  const q = (it) => link(it, `“${String(it.title).trim()}”`)
  return (
    <>
      The team got back to you about{' '}
      {named.length === 1 && <>{q(named[0])}.</>}
      {named.length === 2 && <>{q(named[0])} and {q(named[1])}.</>}
      {named.length > 2 && <>{q(named[0])}, {q(named[1])} and {link(named[2], `${named.length - 2} more`)}.</>}
    </>
  )
}

// ── empty state ───────────────────────────────────────────────
// The all-empty case is the COMMON one: most people who open this screen open
// it onto nothing. It tells them what to send, that a person reads it, and that
// the answer comes back HERE.
function EmptyCard() {
  return (
    <div style={{
      background: T.surface.raised, borderRadius: T.radius.inset, border: T.border.thin,
      padding: '34px 24px', textAlign: 'center',
    }}>
      <p style={{ fontFamily: 'Georgia,serif', fontWeight: 600, fontSize: '18px', color: T.ink.primary, marginBottom: '6px', lineHeight: 1.3 }}>
        Nothing here yet
      </p>
      <p style={{ color: T.ink.secondary, fontSize: '14.5px', margin: '0 auto', maxWidth: '380px', lineHeight: 1.55 }}>
        When something looks wrong, or you think of something that would make the work easier, tell us. We read every one and write back — and the reply turns up right here.
      </p>
    </div>
  )
}

// The closed link names the closed words — from the shared map, never typed.
const CLOSED_WORDS = ['shipped', 'answered', 'declined']
  .filter(s => CLOSED_FEEDBACK_STATUSES.includes(s))
  .map(s => FEEDBACK_STATUS_PLAIN[s])
  .join(', ')

const newestFirst = (a, b) => new Date(b.created_at) - new Date(a.created_at)
const oldestFirst = (a, b) => new Date(a.created_at) - new Date(b.created_at)

// ── sort and filter ───────────────────────────────────────────
export const LIST_FILTERS = [
  { key: 'all',      label: 'Everything' },
  { key: 'waiting',  label: 'Not answered yet' },
  { key: 'replied',  label: 'Replied, still open' },
  { key: 'closed',   label: `Closed (${CLOSED_WORDS})` },
]
export const LIST_ORDERS = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
]

export function matchesListFilter(item, filter) {
  if (filter === 'waiting') return !isDoneItem(item) && !hasReply(item)
  if (filter === 'replied') return !isDoneItem(item) && hasReply(item)
  if (filter === 'closed') return isDoneItem(item)
  return true
}

const orderFn = (order) => (order === 'oldest' ? oldestFirst : newestFirst)

export function sortForList(items, order) {
  return [...items].sort(orderFn(order))
}

const controlSelect = {
  width: '100%', minHeight: '44px', padding: '0 12px', boxSizing: 'border-box',
  // 16px: anything smaller makes iOS zoom the page when the select is tapped.
  fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary,
  background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.control,
}
const controlLabel = {
  flex: '1 1 160px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px',
  fontSize: '12.5px', fontWeight: 600, color: T.ink.muted,
}

// ── the screen ────────────────────────────────────────────────
export default function OwnerFeedbackScreen({
  // The three doors at the top. ({ type, about, context }) → opens the guided
  // intake on that door. When absent, the old single button stands in.
  onAsk = null,
  // Opens the existing FeedbackModal on its Submit tab.
  onReportSomething = null,
  // View-as parity: the route hard-scopes a real owner/manager to their own
  // location and honors ?location_id= only for elevated (impersonating) callers.
  locationId = null,
  // The h1. null when the mount already has a heading (the Help tab).
  title = 'My requests',
}) {
  const isMobile = useIsMobile()
  const [items, setItems]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  // null = the reader has not touched the closed link; the default is derived
  // (open when nothing else is), so nothing races the fetch.
  const [showClosed, setShowClosed] = useState(null)
  const [listFilter, setListFilter] = useState('all')
  const [listOrder, setListOrder] = useState('newest')

  const currentUser = useContext(CurrentUserContext)
  const myId = currentUser?.id || null

  // LOAD READS. IT NEVER WRITES. No seen stamp here — see the header.
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = locationId
        ? `/api/admin/feedback?location_id=${encodeURIComponent(locationId)}`
        : '/api/admin/feedback'
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(Array.isArray(data.items) ? data.items : [])
    } catch (e) {
      setError('Couldn’t load your reports. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [locationId])

  useEffect(() => { load() }, [load])

  const { markSeen, appendReply, applyEdit, applyDelete } = useFeedbackCardHandlers(setItems)

  // Unread is derived LIVE from the items, so stamping an item clears its
  // marker and its line in the banner in the same render — and a reload brings
  // back exactly what the server has not been told about.
  const supported = useMemo(() => seenSupported(items), [items])
  const unreadItems = useMemo(
    () => (supported ? [...items].sort(newestFirst).filter(i => isUnreadReply(i, myId)) : []),
    [items, supported, myId],
  )
  const unreadIds = useMemo(() => new Set(unreadItems.map(i => i.id)), [unreadItems])

  const openItems = useMemo(() => items.filter(i => !isDoneItem(i)).sort(orderFn(listOrder)), [items, listOrder])
  const closedItems = useMemo(() => items.filter(isDoneItem).sort(orderFn(listOrder)), [items, listOrder])
  const filteredItems = useMemo(
    () => sortForList(items.filter(i => matchesListFilter(i, listFilter)), listOrder),
    [items, listFilter, listOrder],
  )
  const closedOpen = showClosed ?? (openItems.length === 0)

  // The banner's links. A closed item may be folded away, so unfold first and
  // scroll on the next frame, once the card exists.
  const jumpTo = useCallback((id) => {
    const target = items.find(i => i.id === id)
    if (target && !matchesListFilter(target, listFilter)) setListFilter('all')
    if (closedItems.some(i => i.id === id)) setShowClosed(true)
    const go = () => {
      try { document.getElementById(feedbackCardId(id))?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go)
    else setTimeout(go, 0)
  }, [closedItems, items, listFilter])

  const card = (it) => (
    <FeedbackCard
      key={it.id}
      item={it}
      myId={myId}
      isNew={unreadIds.has(it.id)}
      onSeen={markSeen}
      onReplied={appendReply}
      onEdited={applyEdit}
      onDeleted={applyDelete}
    />
  )

  const subtitle = items.length === 0
    ? 'Nothing sent in yet'
    : `${items.length} sent · ${openItems.length} still with the team`

  return (
    // No fixed width below 760px: on a phone the column is the screen, with a
    // 16px gutter, and every card, door and banner wraps inside it.
    <div data-owner-feedback style={{ maxWidth: '760px', margin: '0 auto', padding: isMobile ? '18px 16px 70px' : '26px 20px 70px', fontFamily: 'DM Sans,system-ui,sans-serif', boxSizing: 'border-box', minWidth: 0 }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          {title && (
            <h1 style={{ fontFamily: 'Georgia,"Iowan Old Style",serif', fontWeight: 600, fontSize: '26px', lineHeight: 1.2, color: T.ink.primary, margin: '0 0 3px' }}>
              {title}
            </h1>
          )}
          <p data-feedback-subtitle style={{ color: T.ink.secondary, fontSize: '14px', margin: 0 }}>
            {loading || error ? '—' : subtitle}
          </p>
        </div>
        {!onAsk && onReportSomething && (
          <button
            type="button"
            onClick={onReportSomething}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '7px', minHeight: '44px',
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

      {onAsk && <AskStrip variant="requests" onAsk={onAsk} />}

      {/* THE BANNER. Only about replies to the VIEWER'S OWN reports, and it
          stays until each one is acted on. */}
      {!loading && !error && unreadItems.length > 0 && (
        <div data-feedback-banner style={{
          background: T.state.success.soft, borderRadius: '11px',
          padding: '14px 17px', marginBottom: '18px',
          display: 'flex', gap: '12px', alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: '19px', lineHeight: 1.2 }}>💬</span>
          <div style={{ minWidth: 0 }}>
            <b style={{ display: 'block', color: T.state.success.fg, fontSize: '15px', marginBottom: '2px' }}>
              {countWord(unreadItems.length)} new {unreadItems.length === 1 ? 'reply' : 'replies'}
            </b>
            <span style={{ color: T.state.success.fg, fontSize: '14px', lineHeight: 1.5 }}>
              <UnreadSentenceLinks items={unreadItems} onJump={jumpTo} />
            </span>
          </div>
        </div>
      )}

      {loading ? (
        <BeeLoader size="screen" label="Gathering your reports…" />
      ) : error ? (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ fontSize: '13px', color: T.state.danger.strong, marginBottom: '10px' }}>{error}</p>
          <button onClick={load} style={{ minHeight: '44px', padding: '8px 16px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit', fontWeight: 600, color: T.accent.onFill, cursor: 'pointer' }}>Retry</button>
        </div>
      ) : items.length === 0 ? (
        <EmptyCard />
      ) : (
        <>
          {items.length >= 2 && (
            <div data-feedback-list-controls style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px', minWidth: 0 }}>
              <label style={controlLabel}>
                Show
                <select data-feedback-filter value={listFilter} onChange={e => setListFilter(e.target.value)} style={controlSelect}>
                  {LIST_FILTERS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </label>
              <label style={controlLabel}>
                Order
                <select data-feedback-order value={listOrder} onChange={e => setListOrder(e.target.value)} style={controlSelect}>
                  {LIST_ORDERS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </label>
            </div>
          )}
          {listFilter !== 'all' ? (
            <div data-feedback-filtered-list style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
              {filteredItems.length === 0 ? (
                <p style={{ margin: 0, fontSize: '14.5px', color: T.ink.secondary }}>
                  Nothing here.{' '}
                  <button type="button" onClick={() => setListFilter('all')} style={{ minHeight: '44px', padding: '0 2px', background: 'none', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontSize: '14px', fontWeight: 600, textDecoration: 'underline', cursor: 'pointer' }}>
                    Show everything
                  </button>
                </p>
              ) : filteredItems.map(card)}
            </div>
          ) : (<>
          <div data-feedback-open-list style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
            {openItems.length === 0 && (
              <p style={{ margin: 0, fontSize: '14.5px', color: T.ink.secondary }}>
                Nothing open — everything you&rsquo;ve sent has been dealt with.
              </p>
            )}
            {openItems.map(card)}
          </div>

          {closedItems.length > 0 && (
            <div style={{ marginTop: '18px' }}>
              <button
                type="button"
                data-feedback-closed-toggle
                aria-expanded={closedOpen}
                onClick={() => setShowClosed(!closedOpen)}
                style={{
                  minHeight: '44px', padding: '0 2px', background: 'none', border: 'none',
                  color: T.accent.fg, fontFamily: 'inherit', fontSize: '14px', fontWeight: 600,
                  textDecoration: 'underline', cursor: 'pointer',
                }}
              >
                {closedOpen
                  ? `Hide the ${closedItems.length} closed`
                  : `Show ${closedItems.length} closed (${CLOSED_WORDS})`}
              </button>
              {closedOpen && (
                <div data-feedback-closed-list style={{ display: 'flex', flexDirection: 'column', gap: '11px', marginTop: '8px' }}>
                  {closedItems.map(card)}
                </div>
              )}
            </div>
          )}
          </>)}
        </>
      )}
    </div>
  )
}
