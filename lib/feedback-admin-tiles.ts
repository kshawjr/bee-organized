// lib/feedback-admin-tiles.ts
// ─────────────────────────────────────────────────────────────────────────
// THE ADMIN FEEDBACK SCREEN'S ARITHMETIC — the six tiles, their two groups,
// the nav badge and the age colour. One home, so the badge, the tiles, the
// section headings and the row filter cannot disagree about which item is
// where.
//
// WHY. The sidebar badge said 40 and Leslie read it as forty things on fire.
// Four were bugs nobody had answered; the other thirty-six were questions,
// ideas and items we had already replied to. So:
//
//   THE BADGE counts people waiting on a real answer: open bugs with no reply,
//   plus open questions with no reply. Ideas are excluded on purpose — they get
//   a tile and never set off the alarm. Internal items are excluded too: an
//   internal item has nobody on the other end waiting.
//
//   SIX TILES, in two groups, MUTUALLY EXCLUSIVE AND SUMMING TO THE OPEN TOTAL:
//
//     NOBODY HAS REPLIED (no admin_response)
//       fix      bugs (and internal hazards — a bug that has not happened yet)
//       answer   questions
//       decide   ideas (and internal decisions, and any unrecognised type —
//                something has to hold every open item, and an unknown type
//                is a thing to decide about, not an alarm)
//     WE REPLIED (admin_response present)
//       build    planned — and in_progress, which is "building it now", the
//                same promise further along
//       deciding under_review
//       stuck    submitted WITH a reply — a defect state, not a status. The
//                reply floor (ee2cc9e) stops new ones forming from a team
//                reply; the route refuses a hand-set move into it.
//
//   "Replied" is admin_response, the same test lib/feedback-queues'
//   hasFeedbackReply makes everywhere else. (Checked against production on
//   2026-10-22: no open item has a team thread row without admin_response.)
//
//   AGE is the item's age since it was filed (created_at), the number an owner
//   would quote. Plain under 30 days, amber 30 to 59, red at 60 or more.
// ─────────────────────────────────────────────────────────────────────────

import { isClosedFeedback, hasFeedbackReply, feedbackAgeDays } from '@/lib/feedback-queues'

export type AdminTileKey = 'fix' | 'answer' | 'decide' | 'build' | 'deciding' | 'stuck'
export type AdminGroupKey = 'unreplied' | 'replied'

// THE WORDS (the plain-English pass, 2026-10-22). Plain nouns, not verbs — the
// tile says what the pile IS ("Bugs"), not a chore ("Fix") — and one full
// sentence each, sentence case, full stop. The KEYS are unchanged; nothing
// below the words moved. Stuck keeps its internal name and is not a tile on
// the screen: it is a strip that appears only when its count is not zero.
export interface AdminTileDef {
  key: AdminTileKey
  group: AdminGroupKey
  /** The tile's name AND its section heading. */
  name: string
  /** One full sentence: what is in this pile. The tile only — never repeated under the section heading. */
  what: string
}

export const ADMIN_TILES: readonly AdminTileDef[] = [
  { key: 'fix',      group: 'unreplied', name: 'Bugs',          what: 'Something is broken and they are stuck with it.' },
  { key: 'answer',   group: 'unreplied', name: 'Questions',     what: 'They asked us something. A reply finishes it.' },
  { key: 'decide',   group: 'unreplied', name: 'Ideas',         what: 'They want something new. Yes, no, or not now.' },
  { key: 'build',    group: 'replied',   name: 'We said yes',   what: 'Promised and not built yet.' },
  { key: 'deciding', group: 'replied',   name: 'We said maybe', what: 'We said we would look, and never came back.' },
  { key: 'stuck',    group: 'replied',   name: 'Stuck',         what: 'Someone wrote back and the status never moved.' },
] as const

export const ADMIN_GROUPS: readonly { key: AdminGroupKey; label: string }[] = [
  { key: 'unreplied', label: 'Waiting to hear from us' },
  { key: 'replied',   label: 'Heard from us, still waiting' },
] as const

export interface AdminTileItem {
  type?: string | null
  status?: string | null
  admin_response?: string | null
  is_internal?: unknown
  created_at?: string | null
}

// Which tile an item belongs to. null = closed (no tile). Every open item gets
// exactly one — that is what makes the six sum to the open total.
export function adminTileOf(item: AdminTileItem): AdminTileKey | null {
  const status = String(item?.status || '')
  if (isClosedFeedback(status)) return null
  if (!hasFeedbackReply(item as any)) {
    const type = String(item?.type || '')
    if (type === 'bug' || type === 'hazard') return 'fix'
    if (type === 'question') return 'answer'
    return 'decide'
  }
  if (status === 'under_review') return 'deciding'
  if (status === 'submitted') return 'stuck'
  // planned, in_progress — and any status outside the vocabulary, which the
  // CHECK constraint makes impossible but which must still land somewhere.
  return 'build'
}

export function adminGroupOf(tile: AdminTileKey): AdminGroupKey {
  return ADMIN_TILES.find(t => t.key === tile)!.group
}

// THE BADGE. Unanswered bugs + unanswered questions, owner-filed, open.
export function isBadgeItem(item: AdminTileItem): boolean {
  if (item?.is_internal === true) return false
  const tile = adminTileOf(item)
  if (tile !== 'fix' && tile !== 'answer') return false
  // 'fix' also holds hazards, which are internal-only; the line above already
  // excludes them, and this keeps the badge to the two owner types by name.
  const type = String(item?.type || '')
  return type === 'bug' || type === 'question'
}

export function adminBadgeCount(items: AdminTileItem[]): number {
  return (items || []).filter(isBadgeItem).length
}

export interface AdminTileSummary {
  key: AdminTileKey
  count: number
  /** Age in days of the oldest item in the tile, or null when empty. */
  oldestDays: number | null
}

export interface AdminTilesResult {
  tiles: Record<AdminTileKey, AdminTileSummary>
  groups: Record<AdminGroupKey, { count: number; oldestDays: number | null }>
  open: number
  closed: number
}

export function summarizeAdminTiles(items: AdminTileItem[], now: number = Date.now()): AdminTilesResult {
  const tiles = Object.fromEntries(
    ADMIN_TILES.map(t => [t.key, { key: t.key, count: 0, oldestDays: null }]),
  ) as Record<AdminTileKey, AdminTileSummary>
  const groups: AdminTilesResult['groups'] = {
    unreplied: { count: 0, oldestDays: null },
    replied: { count: 0, oldestDays: null },
  }
  let open = 0
  let closed = 0
  for (const item of items || []) {
    const tile = adminTileOf(item)
    if (!tile) { closed++; continue }
    open++
    const age = feedbackAgeDays(item.created_at ?? null, now)
    const t = tiles[tile]
    t.count++
    if (age != null && (t.oldestDays == null || age > t.oldestDays)) t.oldestDays = age
    const g = groups[adminGroupOf(tile)]
    g.count++
    if (age != null && (g.oldestDays == null || age > g.oldestDays)) g.oldestDays = age
  }
  return { tiles, groups, open, closed }
}

// ── AGE COLOUR ────────────────────────────────────────────────────────────
// Three steps, set for THIS backlog: at 10/21 every age on the live screen was
// red, which made red mean nothing. Under 30 days plain, 30 to 59 amber, 60 or
// more red — so 29 is plain, 30 amber, 59 amber, 60 red.
export type AgeTone = 'plain' | 'amber' | 'red'
export const AGE_AMBER_FROM = 30
export const AGE_RED_FROM = 60

export function ageTone(days: number | null | undefined): AgeTone {
  if (days == null) return 'plain'
  if (days >= AGE_RED_FROM) return 'red'
  if (days >= AGE_AMBER_FROM) return 'amber'
  return 'plain'
}

// ── STUCK IS NEVER SET BY HAND ────────────────────────────────────────────
// Would this status change, made by hand, put a replied item into Stuck? The
// route refuses it and the dropdown disables the option. Moving an item that
// is ALREADY at 'submitted' is not a move into anything.
export function wouldHandSetStuck(args: {
  fromStatus: string | null | undefined
  toStatus: string | null | undefined
  replyAfter: string | null | undefined
}): boolean {
  if (String(args.toStatus || '') !== 'submitted') return false
  if (String(args.fromStatus || '') === 'submitted') return false
  return !!String(args.replyAfter || '').trim()
}

// ── INITIALS for the claim circle ─────────────────────────────────────────
export function initialsOf(name: string | null | undefined): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
