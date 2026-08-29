// lib/feedback-replies.ts
//
// ONE definition of "the conversation on a feedback item", and the fail-soft
// plumbing that lets every read work BEFORE migrations/feedback_replies.sql has
// run (Kevin runs migrations; the system is live — the lib/feedback-internal
// precedent).
//
// THE SHAPE. feedback_replies holds the thread: every reply, either side, with
// author and timestamp. feedback_items.admin_response is NOT retired — it stays
// as the denormalized "latest team reply" that the owner banner, the unread
// derivation (lib/feedback-queues), the email send rules and the seen stamping
// all already read. The triage PATCH keeps writing it AND appends a thread row;
// the thread adds history and authorship on top of a column whose consumers are
// all correct as-is.
//
// THE LEGACY MERGE (buildFeedbackThread). 47 replies were written to production
// before the thread table existed — they live only in admin_response, with no
// author row to join. Rather than backfilling rows with guessed authors, the
// READER folds a legacy reply into the thread: when admin_response carries text
// that no team-authored row already contains, it renders as a synthetic first
// team entry. The same rule also covers the freshly-saved case, where the row
// object's embedded replies are a stale snapshot from list load but its
// admin_response was just updated — the new reply appears in the thread
// immediately instead of after a refetch.

import { isClosedFeedback } from './feedback-queues'

export const MAX_FEEDBACK_REPLY_CHARS = 2000

// ── fail-soft: is this error "the table isn't there yet"? ─────────────
// Stricter than a bare code check, like isMissingInternalColumn: the error must
// NAME feedback_replies, because a false positive here silently drops the
// thread from a read. The shapes that occur:
//   Postgres:  'relation "feedback_replies" does not exist'          (42P01)
//   PostgREST: "Could not find the table 'public.feedback_replies'
//              in the schema cache"                                  (PGRST205)
//   PostgREST embed: "Could not find a relationship between
//              'feedback_items' and 'feedback_replies' …"            (PGRST200)
export function isMissingRepliesTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  const msg = String(e.message ?? '').toLowerCase()
  if (!msg.includes('feedback_replies')) return false
  const code = String(e.code ?? '')
  return (
    code === '42P01' ||
    code === 'PGRST200' ||
    code === 'PGRST205' ||
    msg.includes('does not exist') ||
    msg.includes('schema cache') ||
    msg.includes('relationship')
  )
}

// Run a read that embeds feedback_replies, retrying once without the embed when
// the table has not been migrated yet. Same contract as withInternalFallback:
// `attempt` must build the SAME query both ways apart from the embed, so the
// retry differs in exactly one clause. Composes with withInternalFallback —
// pass-through of any extra keys the inner helper returns is deliberate.
export async function withRepliesFallback<T, R extends { data: T | null; error: unknown }>(
  attempt: (includeReplies: boolean) => Promise<R>,
): Promise<R & { repliesSupported: boolean }> {
  const first = await attempt(true)
  if (!first.error) return { ...first, repliesSupported: true }
  if (isMissingRepliesTable(first.error)) {
    const retry = await attempt(false)
    return { ...retry, repliesSupported: false }
  }
  // A real error. Surface it — never fall through to a threadless read.
  return { ...first, repliesSupported: true }
}

// ── the thread ────────────────────────────────────────────────────────

export interface FeedbackReplyRow {
  id?: string | null
  author_id?: string | null
  author_role?: string | null
  body?: string | null
  created_at?: string | null
}

export interface FeedbackThreadItem {
  admin_response?: string | null
  admin_response_at?: string | null
  replies?: FeedbackReplyRow[] | null
  user_id?: string | null
  status?: string | null
}

export interface FeedbackThreadEntry {
  id: string
  /** Which voice wrote it — 'team' (corp) or 'owner' (the franchise side). */
  authorRole: 'team' | 'owner'
  authorId: string | null
  body: string
  createdAt: string | null
  /** True for the synthetic entry derived from admin_response (no thread row). */
  legacy: boolean
}

function stamp(iso: string | null | undefined): number {
  if (!iso) return -Infinity // undated legacy entry predates every dated row
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? -Infinity : t
}

// The full conversation on an item, oldest first. Thread rows lead; a legacy
// admin_response is folded in as a synthetic team entry ONLY when its text is
// not already present as a team-authored row — which covers both the 47
// pre-thread production replies and the stale-embed window right after a save.
export function buildFeedbackThread(
  item: FeedbackThreadItem | null | undefined,
): FeedbackThreadEntry[] {
  if (!item) return []
  const rows = Array.isArray(item.replies) ? item.replies : []
  const entries: FeedbackThreadEntry[] = []
  for (const r of rows) {
    const body = String(r?.body ?? '').trim()
    if (!body) continue
    entries.push({
      id: String(r?.id || `reply-${entries.length}`),
      authorRole: r?.author_role === 'team' ? 'team' : 'owner',
      authorId: r?.author_id ?? null,
      body,
      createdAt: r?.created_at ?? null,
      legacy: false,
    })
  }
  const legacyText = String(item.admin_response ?? '').trim()
  if (legacyText) {
    const alreadyThere = entries.some(e => e.authorRole === 'team' && e.body === legacyText)
    if (!alreadyThere) {
      entries.push({
        id: 'legacy-admin-response',
        authorRole: 'team',
        authorId: null,
        body: legacyText,
        createdAt: item.admin_response_at ?? null,
        legacy: true,
      })
    }
  }
  return entries.sort((a, b) => stamp(a.createdAt) - stamp(b.createdAt))
}

// "The ball is in the team's court." True when the conversation exists and its
// last word came from the owner side — the state the triage list must make
// loud, because nothing else about the row changes when an owner writes back.
// An item with no conversation at all is NOT awaiting a team reply in this
// sense; it is unanswered, and the list already marks that separately.
export function awaitingTeamReply(item: FeedbackThreadItem | null | undefined): boolean {
  const thread = buildFeedbackThread(item)
  if (thread.length === 0) return false
  return thread[thread.length - 1].authorRole === 'owner'
}

// Does this item invite a reply from its submitter at all? Two doors in:
//   · the team has written something — a reply is an answer; or
//   · the item is CLOSED. An ending is itself the team saying something — the
//     Fixed announcement email explicitly invites "tell us if it still doesn't
//     look right", and that invitation must have a box behind it even when the
//     item was marked Fixed with no words (the bare-shipped case).
// What stays out: "add more to my own OPEN, unanswered report" — a different
// feature (entry ede746a9 asks for it) and still deliberately not this.
export function threadInvitesReply(item: FeedbackThreadItem | null | undefined): boolean {
  if (!item) return false
  if (buildFeedbackThread(item).some(e => e.authorRole === 'team')) return true
  return isClosedFeedback(item.status)
}

// May THIS viewer write into the thread from the owner screen? The submitter
// only — reply_seen_at is submitter-scoped and the conversation is theirs; a
// colleague at the same location reads it but does not speak in it.
export function ownerCanReply(
  item: FeedbackThreadItem | null | undefined,
  viewerId: string | null | undefined,
): boolean {
  if (!item || !viewerId || item.user_id !== viewerId) return false
  return threadInvitesReply(item)
}

// Re-exported so screen code can gate on closedness without a second import.
export { isClosedFeedback }
