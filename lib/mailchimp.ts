// lib/mailchimp.ts
// ─────────────────────────────────────────────────────────────────────────────
// Mailchimp Marketing API client + OAuth2 exchange. Mirrors the SHAPE of
// lib/jobber.ts — a thin, pure-ish transport layer that the routes drive — but
// deliberately NOT its token lifecycle.
//
// ── WHY THERE IS NO REFRESH CODE HERE ───────────────────────────────────────
// lib/jobber.ts is mostly token management: a refresh token, a token_expiry
// column, a three-path validator, and a write-back on every renewal. NONE of
// that transfers. Mailchimp's OAuth2 grant returns an access token with
// `expires_in: 0` and no refresh token at all — the token is valid until the
// user revokes the app inside Mailchimp. So there is no expiry column, no
// refresh path, and no getValidMailchimpToken(). A dead token is not a stale
// token to renew; it is a revoked grant, and the only cure is reconnecting.
// Copying Jobber's refresh shape would have invented a token lifecycle that
// does not exist and left a permanently-empty refresh column behind.
//
// ── THE SERVER PREFIX IS NOT OPTIONAL ───────────────────────────────────────
// Mailchimp shards every account onto a data centre ("us7", "us21", …). The
// access token alone cannot reach the API: the host itself carries the shard.
// The prefix comes from the metadata endpoint, which is why the callback calls
// getMetadata() BEFORE it writes anything — a token stored without its prefix
// is a row that looks connected and 404s on every call it will ever make.
//
// ── THE TWO AUTHORIZATION HEADERS, WHICH ARE NOT THE SAME ───────────────────
// This trips people up, so both are stated at their call site below:
//   • the metadata endpoint takes  `Authorization: OAuth <token>`
//   • the Marketing API takes      `Authorization: Bearer <token>`
// Sending Bearer to metadata, or OAuth to /lists, fails 401 — they are
// different services that happen to accept the same credential.
// ─────────────────────────────────────────────────────────────────────────────

export const MAILCHIMP_AUTHORIZE_URL = 'https://login.mailchimp.com/oauth2/authorize'
export const MAILCHIMP_TOKEN_URL = 'https://login.mailchimp.com/oauth2/token'
export const MAILCHIMP_METADATA_URL = 'https://login.mailchimp.com/oauth2/metadata'

// The redirect_uri must be byte-identical in the authorize call and the token
// exchange or Mailchimp rejects the code — so both read it from HERE, never
// from a second hand-built string.
export function redirectUri(): string {
  return `${process.env.NEXT_PUBLIC_APP_URL}/api/mailchimp/callback`
}

// ── The authorize URL ─────────────────────────────────────────
// `state` is minted and signed by lib/mailchimp-oauth-guard — this function
// only carries it. It never invents one, so there is no path where a caller
// gets an unprotected flow by forgetting an argument.
export function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.MAILCHIMP_CLIENT_ID!,
    redirect_uri: redirectUri(),
    state,
  })
  return `${MAILCHIMP_AUTHORIZE_URL}?${params.toString()}`
}

export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string }

// ── Code → access token ───────────────────────────────────────
// Form-encoded, like the Jobber and Slack exchanges. Returns a verdict rather
// than throwing: every caller is a redirect-based route that has to land the
// user somewhere with a reason, and an exception would just become a 500.
export async function exchangeCode(code: string): Promise<TokenResult> {
  let res: Response
  try {
    res = await fetch(MAILCHIMP_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.MAILCHIMP_CLIENT_ID!,
        client_secret: process.env.MAILCHIMP_CLIENT_SECRET!,
        redirect_uri: redirectUri(),
        code,
      }),
      cache: 'no-store',
    })
  } catch (err: any) {
    return { ok: false, error: `token_request_failed: ${err?.message || err}` }
  }

  const text = await res.text().catch(() => '')
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, error: `token_parse_failed: ${text.slice(0, 200)}` }
  }

  // Mailchimp signals failure both by HTTP status and by an `error` field.
  // Check the body too: a 200 carrying { error: 'invalid_grant' } is a failure.
  if (!res.ok || payload?.error || !payload?.access_token) {
    return { ok: false, error: String(payload?.error || `token_http_${res.status}`) }
  }
  return { ok: true, accessToken: String(payload.access_token) }
}

export type MetadataResult =
  | { ok: true; dc: string; accountName: string }
  | { ok: false; error: string }

// ── Token → data centre + account name ────────────────────────
// Called immediately after the exchange, and its failure is FATAL to the
// connect flow by design (see the callback route). `dc` is the shard every
// later request is addressed to; `accountname` is the only human-readable
// label we can show an owner to confirm they linked the right account.
export async function getMetadata(accessToken: string): Promise<MetadataResult> {
  let res: Response
  try {
    res = await fetch(MAILCHIMP_METADATA_URL, {
      // `OAuth`, NOT `Bearer` — the login service and the Marketing API take
      // different schemes for the same token. See the header note.
      headers: { Authorization: `OAuth ${accessToken}` },
      cache: 'no-store',
    })
  } catch (err: any) {
    return { ok: false, error: `metadata_request_failed: ${err?.message || err}` }
  }

  const text = await res.text().catch(() => '')
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, error: `metadata_parse_failed: ${text.slice(0, 200)}` }
  }

  if (!res.ok) {
    return { ok: false, error: `metadata_http_${res.status}` }
  }
  // No dc = no usable connection. Fail here rather than storing a token that
  // cannot address a host.
  if (!payload?.dc) {
    return { ok: false, error: 'metadata_missing_dc' }
  }
  return {
    ok: true,
    dc: String(payload.dc),
    // accountname is what the Mailchimp UI calls the account; login.email is
    // the fallback when an account was never named.
    accountName: String(payload.accountname || payload?.login?.email || ''),
  }
}

// ── The sharded API host ──────────────────────────────────────
export function apiBase(dc: string): string {
  return `https://${dc}.api.mailchimp.com/3.0/`
}

export interface MailchimpAudience {
  id: string
  name: string
  memberCount: number
}

export type AudiencesResult =
  | { ok: true; audiences: MailchimpAudience[] }
  | { ok: false; error: string }

// ── GET /lists ────────────────────────────────────────────────
// `count` is LOAD-BEARING, not a tuning knob: Mailchimp's default page size is
// 10, so omitting it hands an owner with 11 audiences a picker showing 10 and
// no indication the list was cut. It is set to 1000 — Mailchimp's documented
// maximum — rather than to a smaller page, because every audience the account
// has should be selectable and there is no pagination UI to reach the rest.
//
// `fields` trims the response to what the picker actually renders; a bare
// /lists call returns a large object per audience, and at count=1000 that
// difference is the whole payload.
//
// Beyond 1000 the list IS truncated, so total_items is requested and compared
// below: the cap is logged when it actually bites rather than passing silently.
// An account with >1000 audiences is not a case this product has, which is why
// the answer is a log line and not pagination code nobody would exercise.
//
// An account with ZERO audiences is a SUCCESS with an empty array, not an
// error. The card has to tell that owner to go make one in Mailchimp, and it
// can only do that if this function distinguishes "none" from "failed".
export async function listAudiences(
  accessToken: string,
  dc: string,
): Promise<AudiencesResult> {
  const url = `${apiBase(dc)}lists?${new URLSearchParams({
    count: '1000',
    fields: 'lists.id,lists.name,lists.stats.member_count,total_items',
  })}`

  let res: Response
  try {
    res = await fetch(url, {
      // `Bearer`, NOT `OAuth` — the Marketing API's scheme. See the header note.
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    })
  } catch (err: any) {
    return { ok: false, error: `lists_request_failed: ${err?.message || err}` }
  }

  const text = await res.text().catch(() => '')
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, error: `lists_parse_failed: ${text.slice(0, 200)}` }
  }

  if (!res.ok) {
    // Mailchimp's error body carries a `detail` worth surfacing — a revoked
    // token reads "API Key Invalid", which is the one message that tells an
    // owner to reconnect rather than retry.
    return { ok: false, error: String(payload?.detail || `lists_http_${res.status}`) }
  }

  const rows = Array.isArray(payload?.lists) ? payload.lists : []

  // The one case where the picker is not the whole truth. Never silent.
  const total = Number(payload?.total_items ?? rows.length)
  if (total > rows.length) {
    console.warn(
      `[mailchimp] account has ${total} audiences; showing the first ${rows.length} — the picker is truncated`,
    )
  }

  return {
    ok: true,
    audiences: rows.map((l: any) => ({
      id: String(l?.id || ''),
      name: String(l?.name || ''),
      memberCount: Number(l?.stats?.member_count ?? 0),
    })).filter((a: MailchimpAudience) => a.id),
  }
}
