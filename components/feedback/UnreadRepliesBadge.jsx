// components/feedback/UnreadRepliesBadge.jsx
// ─────────────────────────────────────────────────────────────
// The Help nav badge (ClickUp 868mm1h81): replies to your own reports that you
// have not opened. The count comes from GET /api/feedback/unread, whose rule
// is lib/feedback-unread — read that first; this file only fetches and draws.
//
// WHEN IT REFRESHES
//   · on mount
//   · when a card is stamped seen (FEEDBACK_SEEN_EVENT, fired by
//     FeedbackCard after the seen POST — or after a write-back, which stamps
//     server-side — has come back), so the badge drops in the same visit
//   · when the window regains focus — the reply email lands elsewhere, and
//     someone coming back to the tab should see what arrived meanwhile
// A failed fetch keeps the last number rather than guessing.
//
// ZERO DRAWS NOTHING. Not a "0", not an empty pill — a badge that is always
// there teaches people to stop looking at it.
'use client'

import React, { useState, useEffect, useCallback } from 'react'

export const FEEDBACK_SEEN_EVENT = 'bee:feedback-seen'

export function announceFeedbackSeen() {
  try { window.dispatchEvent(new Event(FEEDBACK_SEEN_EVENT)) } catch {}
}

export function useUnreadReplyCount(enabled = true) {
  const [count, setCount] = useState(0)

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const res = await fetch('/api/feedback/unread', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setCount(Number.isFinite(data?.count) ? data.count : 0)
    } catch {}
  }, [enabled])

  useEffect(() => {
    if (!enabled) { setCount(0); return }
    refresh()
    window.addEventListener(FEEDBACK_SEEN_EVENT, refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener(FEEDBACK_SEEN_EVENT, refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [enabled, refresh])

  return count
}

// The pill. Sits at the end of a nav row (marginLeft auto), on the sidebar's
// dark green, in the brand gold so it reads at a glance on both the desktop
// sidebar and the phone drawer. 20px tall and never shrinks, so a two-digit
// count is not clipped at 390px.
export function NavCountBadge({ count }) {
  if (!(count > 0)) return null
  const text = count > 99 ? '99+' : String(count)
  return (
    <span
      data-nav-unread-badge={count}
      aria-label={`${count} unread ${count === 1 ? 'reply' : 'replies'}`}
      style={{
        marginLeft: 'auto', flexShrink: 0,
        minWidth: '20px', height: '20px', padding: '0 6px', boxSizing: 'border-box',
        borderRadius: '10px', background: '#d4a046', color: '#1f2d2b',
        fontSize: '11.5px', fontWeight: 700, lineHeight: '20px', textAlign: 'center',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  )
}
