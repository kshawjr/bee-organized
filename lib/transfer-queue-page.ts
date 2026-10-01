// lib/transfer-queue-page.ts
//
// Which ten of the unrouted queue are on screen. PURE and browser-safe: the
// Inbox imports this, so it must never import anything that reads the
// database (lib/transfer-queue.ts holds those and re-exports this).

// Rows visible at once in the section (Kevin, 30 Sept 2026: ten, with a way
// forward and back — the queue must not take over the Inbox).
export const TRANSFER_QUEUE_PAGE_SIZE = 10

export type QueuePage<T> = {
  rows: T[]
  page: number      // 0-based, clamped into range
  pages: number     // at least 1
  total: number
  from: number      // 1-based position of the first row shown (0 when empty)
  to: number        // 1-based position of the last row shown
  hasPrev: boolean
  hasNext: boolean
}

/**
 * One page of the queue. The requested page is CLAMPED: when the last row on
 * the last page is routed away, the view steps back instead of going blank.
 */
export function pageOfQueue<T>(all: T[], requestedPage: number, size = TRANSFER_QUEUE_PAGE_SIZE): QueuePage<T> {
  const total = all.length
  const pages = Math.max(1, Math.ceil(total / size))
  const page = Math.min(Math.max(0, Math.floor(Number(requestedPage) || 0)), pages - 1)
  const start = page * size
  const rows = all.slice(start, start + size)
  return {
    rows, page, pages, total,
    from: total ? start + 1 : 0,
    to: start + rows.length,
    hasPrev: page > 0,
    hasNext: page < pages - 1,
  }
}
