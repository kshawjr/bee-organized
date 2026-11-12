// lib/location-bees.ts
// ─────────────────────────────────────────────────────────────
// The bee roster (Slack job channels, slice 2 of 3). A bee is a ROSTER entry,
// not an account: a name and an email per location, typed by the owner. No
// login, no seat, no access control. Table: migrations/location_bees.sql.
//
//   · Never deleted. Remove = is_active false + removed_at. A bee who comes
//     back reactivates the SAME row (one row per person per location, ever),
//     so their Slack id survives.
//   · The email is checked against the location's Slack when the bee is
//     added, when their email changes, and when the owner taps "Check again"
//     — never on a page load. users.lookupByEmail needs users:read.email,
//     which every connected install already has.
//   · A lookup failure is never a save failure.
//
// Who manages it: the same people who manage a location's own tags
// (lib/tag-guard.ts LOCATION_TAG_ROLES — owner + manager of THAT location)
// plus super_admin / admin for any location. The same check
// app/api/tags/own uses; not a new one.
//
// SERVER-ONLY. slack_bot_token is read here and handed to fetch's
// Authorization header — it never goes into a return value, a log line or an
// error message. toPublicBee is the only shape a route sends.
//
// Later: if bees ever sign in, a bee becomes a lite_user. This stays the
// roster; nothing here is built for that.
// ─────────────────────────────────────────────────────────────
import { LOCATION_TAG_ROLES } from '@/lib/tag-guard'

export const SLACK_LOOKUP_BY_EMAIL_URL = 'https://slack.com/api/users.lookupByEmail'
const SLACK_TIMEOUT_MS = 5000

export const BEE_COLUMNS =
  'id, location_uuid, name, email, jobber_user_id, slack_user_id, slack_checked_at, is_active, removed_at, created_at, updated_at'

export type BeeRow = {
  id: string
  location_uuid: string
  name: string
  email: string
  jobber_user_id: string | null
  slack_user_id: string | null
  slack_checked_at: string | null
  is_active: boolean
  removed_at: string | null
  created_at: string
  updated_at: string
}

// What the browser gets. Built field by field so nothing new on the row (or
// on a joined location) can ride along by accident.
export type PublicBee = {
  id: string
  name: string
  email: string
  is_active: boolean
  removed_at: string | null
  slack_user_id: string | null
  slack_checked_at: string | null
}

export function toPublicBee(row: BeeRow): PublicBee {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    is_active: row.is_active !== false,
    removed_at: row.removed_at ?? null,
    slack_user_id: row.slack_user_id ?? null,
    slack_checked_at: row.slack_checked_at ?? null,
  }
}

// ── Who may manage a location's bees ──────────────────────────
export function canManageBees(
  hubUser: { role?: string | null; location_id?: string | null } | null | undefined,
  locationUuid: string,
): boolean {
  if (!hubUser) return false
  const role = String(hubUser.role || '')
  if (role === 'super_admin' || role === 'admin') return true
  return LOCATION_TAG_ROLES.has(role) && hubUser.location_id === locationUuid
}

// ── Input ─────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const emailKey = (email: string) => String(email || '').trim().toLowerCase()

export function cleanName(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
  return s && s.length <= 120 ? s : null
}

export function cleanEmail(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && s.length <= 254 && EMAIL_RE.test(s) ? s : null
}

// The plain line a refused duplicate answers with.
export function duplicateMessage(existing: { name: string; email: string; is_active: boolean }): string {
  return existing.is_active
    ? `${existing.name} is already on your bees with ${existing.email}.`
    : `${existing.name} used ${existing.email} and was removed — bring them back from Removed instead.`
}

// ── Slack ─────────────────────────────────────────────────────
export type SlackLookup =
  | { status: 'found'; slackUserId: string }
  | { status: 'not_found' }
  | { status: 'unavailable'; reason: string }

// One users.lookupByEmail call. Never throws. 'not_found' ONLY for Slack's
// own users_not_found — every other failure (network, timeout, rate limit,
// dead token, missing scope) is 'unavailable', which leaves the cache alone:
// "Slack was down" must never read as "nobody has this email".
export async function lookupSlackUserByEmail(token: string, email: string): Promise<SlackLookup> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SLACK_TIMEOUT_MS)
  try {
    const res = await fetch(`${SLACK_LOOKUP_BY_EMAIL_URL}?email=${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { status: 'unavailable', reason: `http_${res.status}` }
    const j: any = await res.json().catch(() => null)
    if (j?.ok === true && typeof j?.user?.id === 'string' && j.user.id) {
      return { status: 'found', slackUserId: j.user.id }
    }
    if (j?.ok === false && j?.error === 'users_not_found') return { status: 'not_found' }
    // Slack's error code only (e.g. invalid_auth, ratelimited) — never the body.
    return { status: 'unavailable', reason: typeof j?.error === 'string' ? j.error.slice(0, 60) : 'bad_response' }
  } catch (e: any) {
    // e.name only: a fetch error's message can carry the URL (and the email).
    return { status: 'unavailable', reason: e?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

export type Db = { from: (table: string) => any }

// Is this location's Slack usable for a lookup? The token stays in here.
export async function readLocationSlack(db: Db, locationUuid: string): Promise<{ connected: boolean; token: string | null }> {
  try {
    const { data, error } = await db
      .from('locations')
      .select('slack_connected, slack_bot_token')
      .eq('id', locationUuid)
      .maybeSingle()
    if (error || !data) return { connected: false, token: null }
    const token = typeof data.slack_bot_token === 'string' && data.slack_bot_token ? data.slack_bot_token : null
    return { connected: data.slack_connected === true && !!token, token }
  } catch {
    return { connected: false, token: null }
  }
}

export type SlackCheck = 'found' | 'not_found' | 'unavailable' | 'not_connected'

// Look the bee up and store the answer. Never throws; the bee is already
// saved. Returns the row as it now stands (unchanged on 'unavailable').
export async function checkBeeAgainstSlack(
  db: Db,
  bee: BeeRow,
  slack: { connected: boolean; token: string | null },
): Promise<{ bee: BeeRow; check: SlackCheck }> {
  if (!slack.connected || !slack.token) return { bee, check: 'not_connected' }
  try {
    const r = await lookupSlackUserByEmail(slack.token, bee.email)
    if (r.status === 'unavailable') {
      console.warn('[location-bees] Slack lookup unavailable for bee', bee.id, '—', r.reason)
      return { bee, check: 'unavailable' }
    }
    const now = new Date().toISOString()
    const patch = { slack_user_id: r.status === 'found' ? r.slackUserId : null, slack_checked_at: now, updated_at: now }
    const { data, error } = await db
      .from('location_bees')
      .update(patch)
      .eq('id', bee.id)
      .select(BEE_COLUMNS)
      .maybeSingle()
    if (error || !data) {
      console.warn('[location-bees] Slack answer not stored for bee', bee.id, '—', error?.message || 'no row')
      return { bee: { ...bee, ...patch }, check: r.status }
    }
    return { bee: data as BeeRow, check: r.status }
  } catch (e: any) {
    console.warn('[location-bees] Slack check failed for bee', bee.id, '—', e?.name || 'error')
    return { bee, check: 'unavailable' }
  }
}
