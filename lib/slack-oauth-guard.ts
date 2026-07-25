// lib/slack-oauth-guard.ts
// ─────────────────────────────────────────────────────────────
// The gate on the per-location Slack install (app/api/slack/connect →
// app/api/slack/callback). Owns BOTH halves of the guard so the two routes
// cannot drift apart:
//
//   1. AUTHORIZATION — who may bind a Slack workspace to a location.
//      super_admin / admin anywhere; owner only for their OWN location.
//      Checked at initiation AND again at token exchange, because a role or
//      location change between the two must not be honored.
//
//   2. STATE — a real, verifiable, single-use nonce.
//      The connect route used to mint `${locationId}:${nonce}` and call it CSRF
//      protection while the callback never verified the nonce — it split off the
//      locationId and wrote a bot token onto whatever location the string named.
//      Combined with an unauthenticated connect route, anyone who could guess a
//      slug could point their own Slack workspace at a franchise's lead cards.
//
// ── WHY A SIGNED COOKIE AND NOT A TABLE ──────────────────────────────────────
// The obvious store is a `slack_oauth_states` table, but a migration would be
// HELD for Kevin to run — which would leave this SECURITY fix dark in prod
// until it ran. A migration is the wrong dependency for a patch that closes an
// active hijack path. So the record travels as an httpOnly, SameSite=Lax,
// short-TTL cookie signed with HMAC-SHA256, which:
//   • needs no schema change, so it is live the moment it deploys;
//   • is tamper-proof — the payload is signed, so a caller cannot edit the
//     location id or user id inside it;
//   • binds the callback to the BROWSER that started the flow, which a shared
//     server-side table does NOT do.
// SameSite=Lax is what makes this work: Slack's redirect back to us is a
// top-level GET navigation, which Lax cookies are sent on.
//
// ── THE ONE THING A COOKIE CANNOT DO, STATED PLAINLY ────────────────────────
// A cookie store cannot, by itself, prove a nonce was already consumed — the
// server keeps no record. Two things cover that gap:
//   • the cookie is deleted on EVERY callback response, success or failure, so
//     the normal browser cannot present it twice; and
//   • CONSUMED_NONCES below rejects a repeat within the same warm instance.
// Neither is airtight across serverless instances. The backstop that IS
// airtight: Slack authorization codes are single-use, so a replayed callback
// fails the token exchange (`invalid_code`) and reaches no write regardless.
// Replaying successfully would require stealing an httpOnly cookie AND an
// unused code AND still passing the re-authorization below — i.e. being the
// legitimate user. If a durable store is ever wanted, this module is the seam:
// swap CONSUMED_NONCES for a table and nothing else changes.
// ─────────────────────────────────────────────────────────────

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { supabaseService } from './supabase-service'

export const SLACK_OAUTH_STATE_COOKIE = 'bh_slack_oauth'

// 10 minutes: long enough to read Slack's consent screen and pick a channel,
// short enough that a leaked state is worthless by the time it is found.
export const SLACK_OAUTH_STATE_TTL_MS = 10 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Authorization ─────────────────────────────────────────────

function isElevated(role: string | null | undefined): boolean {
  return role === 'super_admin' || role === 'admin'
}

export type SlackAuthzVerdict =
  | { ok: true; role: string }
  | { ok: false; reason: 'no_hub_user' | 'forbidden' }

// Authorize a caller against ONE location. Mirrors the sibling write routes
// (/api/locations/[id]/slack-disconnect, …/slack-invite) exactly: elevated
// anywhere, owner only for their own location, everything else rejected.
//
// Takes the SESSION client (not the service client) so the hub_users read runs
// under RLS as the caller — the same self-read the siblings do.
export async function authorizeSlackConnect(
  supabase: { from: (table: string) => any },
  userId: string,
  locationUuid: string,
): Promise<SlackAuthzVerdict> {
  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', userId)
    .single()

  if (!caller) return { ok: false, reason: 'no_hub_user' }

  const isOwnerOfTargetLoc =
    caller.role === 'owner' && caller.location_id === locationUuid
  if (!isElevated(caller.role) && !isOwnerOfTargetLoc) {
    return { ok: false, reason: 'forbidden' }
  }
  return { ok: true, role: caller.role }
}

// Resolve the ?location_id= param — which may be the uuid PK or the slug — to
// the location row. Service-role read: the caller is authorized against the
// RESOLVED uuid immediately after, never against the string they supplied.
export async function resolveSlackLocation(
  idOrSlug: string,
): Promise<{ id: string; location_id: string | null; name: string | null } | null> {
  const field = UUID_RE.test(idOrSlug) ? 'id' : 'location_id'
  const { data, error } = await supabaseService
    .from('locations')
    .select('id, location_id, name')
    .eq(field, idOrSlug)
    .maybeSingle()
  if (error || !data) return null
  return data as any
}

// ── State: mint ───────────────────────────────────────────────

type StateRecord = {
  // nonce
  n: string
  // location uuid this install is bound to (resolved, never the raw param)
  loc: string
  // hub user who started the flow
  uid: string
  // absolute expiry, ms since epoch
  exp: number
}

// HMAC key. SLACK_CLIENT_SECRET is already REQUIRED for the token exchange, so
// reusing it adds no new env dependency and no new way for the flow to break —
// a deploy missing it could never have completed an install anyway. Domain-
// separated so this signature can never be confused with another use of the
// same secret.
const SIGNING_PREFIX = 'beehub.slack.oauth.state.v1:'

function signingKey(): string | null {
  const secret = process.env.SLACK_CLIENT_SECRET
  return secret && secret.length ? secret : null
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(SIGNING_PREFIX + payload).digest('hex')
}

export type MintedState = {
  // Goes to Slack as ?state= — `${locationUuid}:${nonce}`, the same SHAPE the
  // flow always used, so nothing downstream has to change.
  state: string
  cookie: {
    name: string
    value: string
    options: {
      httpOnly: true
      secure: boolean
      sameSite: 'lax'
      path: string
      maxAge: number
    }
  }
}

// Mint a state + its signed cookie record. Returns null when the signing key is
// absent — the caller must treat that as "cannot start the flow", never as
// "start it unprotected".
export function mintSlackOAuthState(args: {
  locationUuid: string
  userId: string
}): MintedState | null {
  const key = signingKey()
  if (!key) return null

  const nonce = randomBytes(24).toString('hex')
  const record: StateRecord = {
    n: nonce,
    loc: args.locationUuid,
    uid: args.userId,
    exp: Date.now() + SLACK_OAUTH_STATE_TTL_MS,
  }
  const payload = Buffer.from(JSON.stringify(record), 'utf8').toString('base64url')
  const value = `${payload}.${sign(payload, key)}`

  return {
    state: `${args.locationUuid}:${nonce}`,
    cookie: {
      name: SLACK_OAUTH_STATE_COOKIE,
      value,
      options: {
        httpOnly: true,
        // Plain http in local dev would drop a Secure cookie and break the flow.
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        // Scoped to the only routes that read it.
        path: '/api/slack',
        maxAge: Math.floor(SLACK_OAUTH_STATE_TTL_MS / 1000),
      },
    },
  }
}

// ── State: verify + consume ───────────────────────────────────

// Best-effort single-use enforcement within a warm instance. See the header for
// why this is a layer rather than the guarantee.
const CONSUMED_NONCES = new Map<string, number>()

// forEach + a collected list rather than `for…of` over the Map: this repo's TS
// target predates downlevel iteration, so iterating a Map directly won't build.
// Deleting inside forEach is also the kind of thing that reads fine and behaves
// badly, so the keys are gathered first.
function pruneConsumed(now: number): void {
  const stale: string[] = []
  CONSUMED_NONCES.forEach((expiry, nonce) => {
    if (expiry <= now) stale.push(nonce)
  })
  stale.forEach((nonce) => CONSUMED_NONCES.delete(nonce))
}

export type StateFailure =
  | 'no_secret'
  | 'missing_cookie'
  | 'missing_state'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'state_mismatch'
  | 'replayed'

export type StateVerdict =
  | { ok: true; locationUuid: string; userId: string }
  | { ok: false; failure: StateFailure }

// Verify the cookie record against the ?state= Slack handed back, and CONSUME
// the nonce. Verification and consumption are one call on purpose: a two-call
// shape invites a caller that verifies and forgets to consume.
//
// FAILS CLOSED. Every doubt — no cookie, no secret, bad signature, expired,
// state that doesn't match the signed record, a nonce already seen — returns
// ok:false. There is no path where an unverifiable state falls through.
export function consumeSlackOAuthState(
  cookieValue: string | null | undefined,
  state: string | null | undefined,
): StateVerdict {
  const key = signingKey()
  if (!key) return { ok: false, failure: 'no_secret' }
  if (!cookieValue) return { ok: false, failure: 'missing_cookie' }
  if (!state) return { ok: false, failure: 'missing_state' }

  const dot = cookieValue.lastIndexOf('.')
  if (dot <= 0) return { ok: false, failure: 'malformed' }
  const payload = cookieValue.slice(0, dot)
  const signature = cookieValue.slice(dot + 1)

  // Length-guarded before timingSafeEqual, which throws on a length mismatch.
  const expected = sign(payload, key)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, failure: 'bad_signature' }
  }

  let record: StateRecord
  try {
    record = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, failure: 'malformed' }
  }
  if (!record?.n || !record?.loc || !record?.uid || typeof record.exp !== 'number') {
    return { ok: false, failure: 'malformed' }
  }

  const now = Date.now()
  if (record.exp <= now) return { ok: false, failure: 'expired' }

  // The state string is attacker-reachable; the signed record is not. Require
  // them to agree, then use the RECORD for everything downstream.
  const sep = state.indexOf(':')
  if (sep < 0) return { ok: false, failure: 'state_mismatch' }
  const stateLoc = state.slice(0, sep)
  const stateNonce = state.slice(sep + 1)
  if (stateLoc !== record.loc || stateNonce !== record.n) {
    return { ok: false, failure: 'state_mismatch' }
  }

  pruneConsumed(now)
  if (CONSUMED_NONCES.has(record.n)) return { ok: false, failure: 'replayed' }
  CONSUMED_NONCES.set(record.n, record.exp)

  return { ok: true, locationUuid: record.loc, userId: record.uid }
}

// Test seam only — the consumed-nonce map is module state, and a suite that
// mints a fixed nonce twice needs to clear it between cases.
export function __resetConsumedNoncesForTest(): void {
  CONSUMED_NONCES.clear()
}
