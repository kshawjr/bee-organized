// lib/network/paging.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 1 — page arithmetic. Pure functions
// only, ported unchanged from the design's contact-pagination.ts.
//
// These slice a list that is already in hand. That is right for the Network
// tab (263 people today). The Nurturing tab is far too large to hold in the
// browser, so it will page on the server and use only pageCount / clampPage
// from here, never contactPage.
// ─────────────────────────────────────────────────────────────

export const PAGE_SIZES = [10, 15, 25, 50, 100] as const

export function defaultPageSize(mobile: boolean) { return mobile ? 10 : 25 }

export function pageCount(total: number, size: number) {
  return Math.max(1, Math.ceil(total / size))
}

/** A page number that exists: 0-based, never past the last page. */
export function clampPage(page: number, total: number, size: number) {
  return Math.max(0, Math.min(page, pageCount(total, size) - 1))
}

export function contactPage<T>(items: readonly T[], page: number, size: number): T[] {
  const current = clampPage(page, items.length, size)
  return items.slice(current * size, (current + 1) * size)
}
