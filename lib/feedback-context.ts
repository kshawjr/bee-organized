// lib/feedback-context.ts
//
// Shared, side-effect-free helpers for the feedback "record context" — the
// small structured pointer that rides a feedback item filed FROM a specific
// record (e.g. the "Report a problem with this client" menu item on a client
// profile). Kept pure so both the API route and the tests exercise the exact
// same logic.
//
// PRIVACY (issue 110a): the context stores IDS ONLY. Names, emails, and phones
// are never written here — the reader resolves the id to the live record. A log
// full of names became a privacy cleanup once; this column must not repeat it.
// buildSafeContext() is the hard boundary: it whitelists a fixed key set and
// drops everything else, so even a tampered request body can't smuggle PII (or
// an oversized blob) into the column.

// The ONLY keys ever persisted. Everything is an id or a non-PII descriptor:
//   kind        — record type ('client'), so the shape can extend later
//   lead_id     — the record; the reader resolves name/contact from this
//   location_id — the record's franchise (already non-PII, aids triage scoping)
//   screen      — friendly screen label the user was on ('Clients')
//   path        — deep link to reopen the exact record ('/clients/<id>')
//   origin      — which affordance filed it ('client_profile_menu')
export const FEEDBACK_CONTEXT_KEYS = ['kind', 'lead_id', 'location_id', 'screen', 'path', 'origin'] as const

export type FeedbackContext = Partial<Record<(typeof FEEDBACK_CONTEXT_KEYS)[number], string>>

// Per-key length caps. path is a touch longer (it carries an id-bearing URL);
// everything else is a short id/label. Values are coerced to strings, trimmed,
// and capped — anything empty after that is dropped.
const MAX_LEN: Record<string, number> = { path: 300 }
const DEFAULT_MAX_LEN = 120

// Re-derive a safe context from arbitrary input. Returns a plain object with
// only the whitelisted, coerced, capped keys — or null when nothing survives
// (so callers can simply omit the column). This is the PII boundary: keys
// outside the whitelist (name/email/phone/etc.) are silently discarded.
export function buildSafeContext(raw: unknown): FeedbackContext | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const out: FeedbackContext = {}
  for (const key of FEEDBACK_CONTEXT_KEYS) {
    const v = src[key]
    if (v === undefined || v === null) continue
    const s = String(v).slice(0, MAX_LEN[key] ?? DEFAULT_MAX_LEN).trim()
    if (s) out[key] = s
  }
  return Object.keys(out).length ? out : null
}

// Does this Supabase/Postgres error mean the `context` column isn't there yet?
// The migration is HELD (Kevin runs the DDL), so until then the insert must
// degrade gracefully rather than 500. PostgREST surfaces an unknown insert
// column as PGRST204 ("Could not find the 'context' column … in the schema
// cache"); a raw Postgres path would be 42703 (undefined_column).
export function isMissingContextColumn(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  const code = String(e.code ?? '')
  if (code === 'PGRST204' || code === '42703') return true
  const msg = String(e.message ?? '').toLowerCase()
  return msg.includes('context') && (msg.includes('column') || msg.includes('schema cache'))
}

// Insert a feedback row, attaching context when present but NEVER letting a
// missing `context` column fail the submission. runInsert is the caller's real
// insert (Supabase in the route; a fake in tests). On a missing-column error we
// retry once WITHOUT context so the report still files. Any other error is
// returned as-is (real failures still fail).
export async function insertFeedbackRow<T>(
  runInsert: (row: Record<string, unknown>) => Promise<{ data: T | null; error: unknown }>,
  baseRow: Record<string, unknown>,
  context: FeedbackContext | null,
): Promise<{ data: T | null; error: unknown; contextDropped: boolean }> {
  if (!context) {
    const r = await runInsert(baseRow)
    return { ...r, contextDropped: false }
  }
  const first = await runInsert({ ...baseRow, context })
  if (!first.error) return { ...first, contextDropped: false }
  if (isMissingContextColumn(first.error)) {
    const retry = await runInsert(baseRow)
    return { ...retry, contextDropped: true }
  }
  return { ...first, contextDropped: false }
}
