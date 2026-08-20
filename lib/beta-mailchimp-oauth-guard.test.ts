// Issue 246 step 2 — the Mailchimp connect guard.
//
// This file pins the ONE thing that turns a convenience feature into a
// cross-tenant hijack if it is wrong. An unsigned state would let anyone who
// can guess a location slug attach THEIR Mailchimp account to ANOTHER
// franchise's location row: that franchise's clients would then sit in a
// marketing audience somebody else owns, and the row would read "connected"
// the entire time. Every way of forging or reusing a state is pinned below,
// and every one of them must FAIL CLOSED.
//
// The second half pins the authorization rule, which is deliberately NOT the
// Slack guard's. Slack treats admin as elevated; this does not. Mailchimp
// carries an owner's own list and their own billing relationship, so admin and
// owner are pinned to their OWN location and the requested id is IGNORED
// rather than validated — there is no request they can send that reaches
// another franchise's row.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The guard reads locations through the service client. Every case here drives
// it through this stub, so no test touches a real database.
const locationRows: Record<string, any> = {
  'aaaaaaaa-1111-4222-8333-444455556666': {
    id: 'aaaaaaaa-1111-4222-8333-444455556666', location_id: 'loc_kc', name: 'Kansas City',
  },
  'bbbbbbbb-2222-4222-8333-444455556666': {
    id: 'bbbbbbbb-2222-4222-8333-444455556666', location_id: 'loc_pdx', name: 'Portland',
  },
}
const LOC_A = 'aaaaaaaa-1111-4222-8333-444455556666'
const LOC_B = 'bbbbbbbb-2222-4222-8333-444455556666'

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: () => ({
      select: () => ({
        eq: (field: string, value: string) => ({
          maybeSingle: async () => {
            const row = field === 'id'
              ? locationRows[value]
              : Object.values(locationRows).find((r: any) => r.location_id === value)
            return row ? { data: row, error: null } : { data: null, error: null }
          },
        }),
      }),
    }),
  },
}))

vi.mock('../lib/supabase-service', () => ({
  supabaseService: {
    from: () => ({
      select: () => ({
        eq: (field: string, value: string) => ({
          maybeSingle: async () => {
            const row = field === 'id'
              ? locationRows[value]
              : Object.values(locationRows).find((r: any) => r.location_id === value)
            return row ? { data: row, error: null } : { data: null, error: null }
          },
        }),
      }),
    }),
  },
}))

import {
  mintMailchimpOAuthState,
  consumeMailchimpOAuthState,
  resolveMailchimpTarget,
  targetFailureResponse,
  __resetConsumedNoncesForTest,
  MAILCHIMP_OAUTH_STATE_COOKIE,
  MAILCHIMP_OAUTH_STATE_TTL_MS,
} from '@/lib/mailchimp-oauth-guard'

const USER = '9a8b7c6d-1111-4222-8333-444455556666'

beforeEach(() => {
  __resetConsumedNoncesForTest()
  process.env.MAILCHIMP_CLIENT_SECRET = 'test-secret-value'
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// A hub_users read stub shaped like the session client the routes pass in.
const supaFor = (caller: any) => ({
  from: () => ({
    select: () => ({
      eq: () => ({ single: async () => ({ data: caller, error: null }) }),
    }),
  }),
})

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE STATE IS SIGNED, AND EVERY FORGERY FAILS CLOSED
// ═══════════════════════════════════════════════════════════════════════════
describe('the state cannot be forged', () => {
  it('a minted state round-trips to the location it was bound to', () => {
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    expect(minted).toBeTruthy()
    const verdict = consumeMailchimpOAuthState(minted.cookie.value, minted.state)
    expect(verdict).toEqual({ ok: true, locationUuid: LOC_A, userId: USER })
  })

  it('THE ATTACK: editing the location in ?state= is rejected', () => {
    // The whole reason the state is signed. An attacker who starts their own
    // flow and swaps the location half of the state string must not have their
    // token written onto that other location.
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    const nonce = minted.state.split(':')[1]
    const forged = `${LOC_B}:${nonce}`
    const verdict = consumeMailchimpOAuthState(minted.cookie.value, forged)
    expect(verdict.ok).toBe(false)
    expect((verdict as any).failure).toBe('state_mismatch')
  })

  it('the location comes from the SIGNED cookie, never from the state string', () => {
    // Even a well-formed state cannot redirect the write: the returned uuid is
    // the record's, and a disagreeing string is refused outright.
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    const ok = consumeMailchimpOAuthState(minted.cookie.value, minted.state)
    expect((ok as any).locationUuid).toBe(LOC_A)
    expect((ok as any).locationUuid).not.toBe(LOC_B)
  })

  it('a tampered payload fails the signature', () => {
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    const [payload, sig] = minted.cookie.value.split('.')
    // Re-encode the record pointing at another location, keep the old signature.
    const record = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    record.loc = LOC_B
    const forgedPayload = Buffer.from(JSON.stringify(record), 'utf8').toString('base64url')
    const verdict = consumeMailchimpOAuthState(`${forgedPayload}.${sig}`, `${LOC_B}:${record.n}`)
    expect(verdict.ok).toBe(false)
    expect((verdict as any).failure).toBe('bad_signature')
  })

  it('a signature made with a DIFFERENT secret is rejected', () => {
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    process.env.MAILCHIMP_CLIENT_SECRET = 'a-completely-different-secret'
    const verdict = consumeMailchimpOAuthState(minted.cookie.value, minted.state)
    expect(verdict.ok).toBe(false)
    expect((verdict as any).failure).toBe('bad_signature')
  })

  it('a Slack-guard signature cannot be reused here — the prefix is domain-separated', async () => {
    // Both guards run HMAC-SHA256 over an identical payload shape. Without the
    // domain prefix, a state minted by one would verify in the other whenever
    // the two secrets happened to match.
    process.env.SLACK_CLIENT_SECRET = 'test-secret-value'
    const slack = await import('@/lib/slack-oauth-guard')
    const slackMinted = slack.mintSlackOAuthState({ locationUuid: LOC_A, userId: USER })!
    const verdict = consumeMailchimpOAuthState(slackMinted.cookie.value, slackMinted.state)
    expect(verdict.ok).toBe(false)
    expect((verdict as any).failure).toBe('bad_signature')
  })

  it('an expired state is rejected', () => {
    vi.useFakeTimers()
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    vi.advanceTimersByTime(MAILCHIMP_OAUTH_STATE_TTL_MS + 1000)
    const verdict = consumeMailchimpOAuthState(minted.cookie.value, minted.state)
    expect(verdict.ok).toBe(false)
    expect((verdict as any).failure).toBe('expired')
  })

  it('a replayed state is rejected the second time', () => {
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    expect(consumeMailchimpOAuthState(minted.cookie.value, minted.state).ok).toBe(true)
    const second = consumeMailchimpOAuthState(minted.cookie.value, minted.state)
    expect(second.ok).toBe(false)
    expect((second as any).failure).toBe('replayed')
  })

  it('no cookie, no state, or a malformed cookie all fail closed', () => {
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    expect((consumeMailchimpOAuthState(null, minted.state) as any).failure).toBe('missing_cookie')
    expect((consumeMailchimpOAuthState(minted.cookie.value, null) as any).failure).toBe('missing_state')
    expect((consumeMailchimpOAuthState('not-a-cookie', minted.state) as any).failure).toBe('malformed')
    // A state with no separator is a mismatch, not an accidental pass.
    expect((consumeMailchimpOAuthState(minted.cookie.value, 'nocolon') as any).failure).toBe('state_mismatch')
  })

  it('WITHOUT the signing secret it refuses to mint AND refuses to verify', () => {
    // The one failure mode that must never degrade to "start it unprotected".
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    delete process.env.MAILCHIMP_CLIENT_SECRET
    expect(mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })).toBeNull()
    expect((consumeMailchimpOAuthState(minted.cookie.value, minted.state) as any).failure).toBe('no_secret')
  })

  it('the cookie is httpOnly, SameSite=Lax, short-lived and route-scoped', () => {
    const minted = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    expect(minted.cookie.name).toBe(MAILCHIMP_OAUTH_STATE_COOKIE)
    expect(minted.cookie.options.httpOnly).toBe(true)
    // Lax is load-bearing: the provider's redirect back is a top-level GET.
    expect(minted.cookie.options.sameSite).toBe('lax')
    expect(minted.cookie.options.path).toBe('/api/mailchimp')
    expect(minted.cookie.options.maxAge).toBe(MAILCHIMP_OAUTH_STATE_TTL_MS / 1000)
  })

  it('two mints never share a nonce', () => {
    const a = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    const b = mintMailchimpOAuthState({ locationUuid: LOC_A, userId: USER })!
    expect(a.state).not.toBe(b.state)
    expect(a.cookie.value).not.toBe(b.cookie.value)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · WHO GETS WHICH LOCATION
// ═══════════════════════════════════════════════════════════════════════════
describe('authorization: admin and owner cannot reach another location', () => {
  it('super_admin may name any location, by uuid or by slug', async () => {
    const supa = supaFor({ id: USER, role: 'super_admin', location_id: LOC_A })
    expect(await resolveMailchimpTarget(supa as any, USER, LOC_B))
      .toEqual({ ok: true, locationUuid: LOC_B, role: 'super_admin' })
    // Slugs resolve to the same uuid — the caller is authorized against the
    // RESOLVED id, never the string they sent.
    expect(await resolveMailchimpTarget(supa as any, USER, 'loc_pdx'))
      .toEqual({ ok: true, locationUuid: LOC_B, role: 'super_admin' })
  })

  it('THE ATTACK: an owner asking for another location still gets their own', async () => {
    const supa = supaFor({ id: USER, role: 'owner', location_id: LOC_A })
    const target = await resolveMailchimpTarget(supa as any, USER, LOC_B)
    expect(target).toEqual({ ok: true, locationUuid: LOC_A, role: 'owner' })
    // Not an error — there is simply no request that reaches LOC_B, so there
    // is no mismatch case for a future edit to get wrong.
    expect((target as any).locationUuid).not.toBe(LOC_B)
  })

  it('an admin asking for another location also still gets their own', async () => {
    // Deliberately unlike the Slack guard, where admin is elevated.
    const supa = supaFor({ id: USER, role: 'admin', location_id: LOC_B })
    expect(await resolveMailchimpTarget(supa as any, USER, LOC_A))
      .toEqual({ ok: true, locationUuid: LOC_B, role: 'admin' })
  })

  it('the slug form of another location is ignored too', async () => {
    const supa = supaFor({ id: USER, role: 'owner', location_id: LOC_A })
    expect(await resolveMailchimpTarget(supa as any, USER, 'loc_pdx'))
      .toEqual({ ok: true, locationUuid: LOC_A, role: 'owner' })
  })

  it('lite_user is refused', async () => {
    const supa = supaFor({ id: USER, role: 'lite_user', location_id: LOC_A })
    expect(await resolveMailchimpTarget(supa as any, USER, null))
      .toEqual({ ok: false, reason: 'forbidden' })
  })

  it('MANAGER is refused too — the allowlist is the point', async () => {
    // Per the manager-role rollout: a new owner-only route that blocks only
    // lite_user SILENTLY ADMITS manager. Connections is owner-only in the UI,
    // so the server must agree.
    const supa = supaFor({ id: USER, role: 'manager', location_id: LOC_A })
    expect(await resolveMailchimpTarget(supa as any, USER, null))
      .toEqual({ ok: false, reason: 'forbidden' })
  })

  it('an unknown role fails closed rather than falling through to a default', async () => {
    for (const role of ['viewer', 'readonly', 'light', 'partner', '', 'OWNER']) {
      const supa = supaFor({ id: USER, role, location_id: LOC_A })
      expect(await resolveMailchimpTarget(supa as any, USER, null), role)
        .toEqual({ ok: false, reason: 'forbidden' })
    }
  })

  it('a caller with no hub_users row is refused', async () => {
    const supa = supaFor(null)
    expect(await resolveMailchimpTarget(supa as any, USER, null))
      .toEqual({ ok: false, reason: 'no_hub_user' })
  })

  it('an owner with no location, and a location that no longer exists, are both refused', async () => {
    const seatless = supaFor({ id: USER, role: 'owner', location_id: null })
    expect(await resolveMailchimpTarget(seatless as any, USER, LOC_A))
      .toEqual({ ok: false, reason: 'no_location' })

    // A stale seat must not drive a write at a phantom id.
    const stale = supaFor({ id: USER, role: 'owner', location_id: 'cccccccc-3333-4222-8333-444455556666' })
    expect(await resolveMailchimpTarget(stale as any, USER, null))
      .toEqual({ ok: false, reason: 'location_not_found' })
  })

  it('ADMIN WITH NO LOCATION → 403, and nothing null ever reaches a query', async () => {
    // Leslie: admin, location_id null. Two things must hold. First the guard
    // must short-circuit on the falsy check BEFORE String(caller.location_id),
    // which would otherwise send the literal string "null" to the locations
    // lookup and could match a row. Second the wire answer must be 403 — she
    // has no seat to connect anything with, which is a fact about HER, not a
    // missing location. This was a 404 "location not found" and that was wrong
    // on the merits, not just on the number.
    const supa = supaFor({ id: USER, role: 'admin', location_id: null })
    const target = await resolveMailchimpTarget(supa as any, USER, LOC_A)
    expect(target).toEqual({ ok: false, reason: 'no_location' })

    const fail = targetFailureResponse((target as any).reason)
    expect(fail.status).toBe(403)
    expect(fail.error).toBe('no location assigned')
    // It must not claim a location was looked for and not found.
    expect(fail.error).not.toMatch(/not found/i)
  })

  it('an OWNER with no location gets the same 403, not a 404', async () => {
    const supa = supaFor({ id: USER, role: 'owner', location_id: null })
    const target = await resolveMailchimpTarget(supa as any, USER, null)
    expect(target).toEqual({ ok: false, reason: 'no_location' })
    expect(targetFailureResponse((target as any).reason).status).toBe(403)
  })

  it('the refusal mapping keeps caller-facts and location-facts apart', () => {
    // no_location is about the CALLER (403). location_not_found is about a
    // LOCATION that genuinely does not resolve (404). Collapsing the two is the
    // exact bug this pins shut.
    expect(targetFailureResponse('no_location')).toEqual({ status: 403, error: 'no location assigned' })
    expect(targetFailureResponse('location_not_found')).toEqual({ status: 404, error: 'location not found' })
    expect(targetFailureResponse('forbidden')).toEqual({ status: 403, error: 'forbidden' })
    expect(targetFailureResponse('no_hub_user')).toEqual({ status: 403, error: 'forbidden' })
  })

  it('all three routes share the one mapping — none hand-rolls a status', () => {
    // The bug existed because three routes each wrote the mapping themselves.
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const routes = [
      'app/api/mailchimp/connect/route.ts',
      'app/api/mailchimp/audiences/route.ts',
      'app/api/locations/[id]/mailchimp-disconnect/route.ts',
    ]
    for (const r of routes) {
      const src = readFileSync(join(process.cwd(), r), 'utf8')
      expect(src, r).toMatch(/targetFailureResponse\(/)
      // No route may test the reason itself and pick its own number again.
      expect(src, r).not.toMatch(/reason === 'no_location'/)
      expect(src, r).not.toMatch(/reason === 'location_not_found'/)
    }
  })

  it('a super_admin naming a location that does not exist is refused', async () => {
    const supa = supaFor({ id: USER, role: 'super_admin', location_id: LOC_A })
    expect(await resolveMailchimpTarget(supa as any, USER, 'loc_nope'))
      .toEqual({ ok: false, reason: 'location_not_found' })
  })
})
