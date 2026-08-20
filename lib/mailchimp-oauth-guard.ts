// lib/mailchimp-oauth-guard.ts
// ─────────────────────────────────────────────────────────────────────────────
// The gate on the per-location Mailchimp connect flow (app/api/mailchimp/
// connect → callback → audiences). Owns BOTH halves of the guard, for the same
// reason lib/slack-oauth-guard does: two routes that each implement half of a
// security check drift, and the drift is invisible until it is exploited.
//
//   1. AUTHORIZATION — who may bind a Mailchimp account to a location, and
//      WHICH location they get. Checked at initiation AND again at token
//      exchange, so a role or location change between the two is not honored.
//
//   2. STATE — a signed, short-lived, single-use record.
//
// ── WHY THE STATE IS SIGNED, STATED AS THE ATTACK IT STOPS ──────────────────
// If ?state= were a bare location_id, the callback would take an attacker's
// string and write THEIR Mailchimp token onto ANOTHER franchise's location row.
// That franchise's clients would then be marketed to from an account the
// attacker controls, and the row would read "connected" the whole time. So the
// location a token is written to comes ONLY from the signed cookie record; the
// state string must AGREE with that record but is never itself a lookup key.
//
// This is the same httpOnly + SameSite=Lax + HMAC-SHA256 cookie shape the Slack
// guard uses, and for the same reason: it needs no migration, so it is live the
// moment it deploys, and it binds the callback to the BROWSER that started the
// flow. It is a deliberate reuse of a proven shape, not a copy — the
// authorization rule below is genuinely different (see WHO GETS WHICH).
//
// Single-use has the same three layers as Slack's, with the same honest limit:
// the cookie is cleared on every callback response, CONSUMED_NONCES rejects a
// repeat within a warm instance, and the airtight backstop is that Mailchimp
// authorization codes are single-use — a replayed callback fails the exchange
// and reaches no write.
//
// ── WHO GETS WHICH LOCATION (this is NOT the Slack rule) ────────────────────
// The Slack guard treats admin as elevated: admin may bind ANY location. This
// flow does not. Mailchimp carries an owner's own marketing list and their own
// billing relationship with Mailchimp, so the blast radius of picking the wrong
// location is somebody else's audience:
//
//   super_admin  — any location; the ?location_id= param is honored.
//   admin, owner — their OWN location only. The param is IGNORED, not
//                  validated-and-rejected: there is no request they can send
//                  that reaches another franchise's row, so there is no
//                  mismatch case to get wrong.
//   everyone else (manager, lite_user, unknown) — 403.
//
// That last line is an ALLOWLIST on purpose. Per the manager-role rollout, a
// new owner-only route that blocks only lite_user silently admits manager —
// manager is lite_user's old permissions plus explicit grants, and this is not
// one of them. Connections is `ownerConfig` (franchiseRole==='owner') in the
// Settings UI, so a manager cannot even see this card; the server now agrees.
// An unrecognized role string falls through to 403 rather than to a default.
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { supabaseService } from './supabase-service'

export const MAILCHIMP_OAUTH_STATE_COOKIE = 'bh_mailchimp_oauth'

// 10 minutes — long enough to sign in to Mailchimp and read its consent
// screen, short enough that a leaked state is worthless by the time it is found.
export const MAILCHIMP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Authorization ─────────────────────────────────────────────

export type MailchimpTarget =
  | { ok: true; locationUuid: string; role: string }
  | { ok: false; reason: 'no_hub_user' | 'forbidden' | 'no_location' | 'location_not_found' }

// Resolve BOTH "may this caller connect Mailchimp" and "to which location" in
// ONE call. Fusing them is the point: a two-call shape (authorize here, pick
// the location there) is exactly how a route ends up authorizing one location
// and writing another.
//
// Takes the SESSION client so the hub_users read runs under RLS as the caller,
// matching the sibling write routes.
export async function resolveMailchimpTarget(
  supabase: { from: (table: string) => any },
  userId: string,
  requestedIdOrSlug: string | null | undefined,
): Promise<MailchimpTarget> {
  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', userId)
    .single()

  if (!caller) return { ok: false, reason: 'no_hub_user' }

  // super_admin — and ONLY super_admin — may name a location.
  if (caller.role === 'super_admin') {
    // Falling back to their own location keeps the flow working when the param
    // is absent; a super_admin without one is a real "which location?" error.
    const target = requestedIdOrSlug || caller.location_id
    if (!target) return { ok: false, reason: 'no_location' }
    const loc = await resolveMailchimpLocation(String(target))
    if (!loc) return { ok: false, reason: 'location_not_found' }
    return { ok: true, locationUuid: loc.id, role: caller.role }
  }

  // admin + owner — own location only. `requestedIdOrSlug` is deliberately not
  // read below this line.
  if (caller.role === 'admin' || caller.role === 'owner') {
    if (!caller.location_id) return { ok: false, reason: 'no_location' }
    // hub_users.location_id is TEXT holding the locations.id uuid. Confirm the
    // row still exists so a stale seat can't drive a write at a phantom id.
    const loc = await resolveMailchimpLocation(String(caller.location_id))
    if (!loc) return { ok: false, reason: 'location_not_found' }
    return { ok: true, locationUuid: loc.id, role: caller.role }
  }

  // manager, lite_user, and any role string this build has never heard of.
  return { ok: false, reason: 'forbidden' }
}

// ── The HTTP shape of a refusal ───────────────────────────────
// ONE mapping, shared by every route that calls resolveMailchimpTarget, because
// the first version of this was three hand-written copies and one of them was
// wrong: `no_location` was bucketed with `location_not_found` and answered 404
// "location not found".
//
// That conflated two different facts. `location_not_found` is about a LOCATION
// — a uuid or slug that does not resolve, which is genuinely a 404.
// `no_location` is about the CALLER — an admin or owner whose seat carries no
// location_id at all. Nothing they asked for is missing; they have nothing to
// connect Mailchimp to. That is an authorization fact, so it is a 403, and the
// message says so rather than implying a lookup ran and came back empty.
export function targetFailureResponse(
  reason: 'no_hub_user' | 'forbidden' | 'no_location' | 'location_not_found',
): { status: number; error: string } {
  if (reason === 'location_not_found') {
    return { status: 404, error: 'location not found' }
  }
  if (reason === 'no_location') {
    return { status: 403, error: 'no location assigned' }
  }
  // no_hub_user collapses into forbidden on the wire: whether a caller has no
  // hub_users row or the wrong role is not a distinction worth handing back.
  return { status: 403, error: 'forbidden' }
}

// Resolve a uuid OR slug to the location row. Service-role read: the caller is
// authorized against the RESOLVED uuid, never against the string they supplied.
export async function resolveMailchimpLocation(
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
  n: string    // nonce
  loc: string  // location uuid this connect is bound to (resolved, never raw)
  uid: string  // hub user who started the flow
  exp: number  // absolute expiry, ms since epoch
}

// HMAC key. MAILCHIMP_CLIENT_SECRET is already REQUIRED for the token exchange,
// so reusing it adds no new env dependency and no new way for the flow to
// break — a deploy missing it could never have completed a connect anyway.
// Domain-separated so this signature can never be confused with the Slack
// guard's, which uses the identical algorithm over an identical payload shape.
const SIGNING_PREFIX = 'beehub.mailchimp.oauth.state.v1:'

function signingKey(): string | null {
  const secret = process.env.MAILCHIMP_CLIENT_SECRET
  return secret && secret.length ? secret : null
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(SIGNING_PREFIX + payload).digest('hex')
}

export type MintedState = {
  // Goes to Mailchimp as ?state= — `${locationUuid}:${nonce}`.
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

// Returns null when the signing key is absent. The caller MUST treat that as
// "cannot start the flow", never as "start it unprotected".
export function mintMailchimpOAuthState(args: {
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
    exp: Date.now() + MAILCHIMP_OAUTH_STATE_TTL_MS,
  }
  const payload = Buffer.from(JSON.stringify(record), 'utf8').toString('base64url')
  const value = `${payload}.${sign(payload, key)}`

  return {
    state: `${args.locationUuid}:${nonce}`,
    cookie: {
      name: MAILCHIMP_OAUTH_STATE_COOKIE,
      value,
      options: {
        httpOnly: true,
        // Plain http in local dev would drop a Secure cookie and break the flow.
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        // Scoped to the only routes that read it.
        path: '/api/mailchimp',
        maxAge: Math.floor(MAILCHIMP_OAUTH_STATE_TTL_MS / 1000),
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

// Verify the cookie record against the ?state= Mailchimp handed back, and
// CONSUME the nonce. One call on purpose: a two-call shape invites a caller
// that verifies and forgets to consume.
//
// FAILS CLOSED. Every doubt — no cookie, no secret, bad signature, expired, a
// state that doesn't match the signed record, a nonce already seen — returns
// ok:false. There is no path where an unverifiable state falls through.
export function consumeMailchimpOAuthState(
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
