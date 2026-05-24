// lib/jobber-webhook.ts
// ─────────────────────────────────────────────────────────────
// Inbound-side helpers for /api/webhooks/jobber.
//
// - verifyWebhookSignature: HMAC-SHA256 over the raw request body
//   using JOBBER_WEBHOOK_SECRET. Timing-safe compare. The Jobber
//   webhook signature ships in the X-Jobber-Hmac-Sha256 header.
//
// - lookupLocationByJobberAccountId: maps the webhook payload's
//   accountId (numeric) to the Bee Hub location whose
//   locations.jobber_account_id matches. Returns null when no
//   location is connected to the originating Jobber account —
//   common case after a disconnect.
//
// We compare both the raw value AND the numeric portion extracted
// from a base64-encoded GraphQL global ID, because the OAuth
// callback (app/api/jobber/callback/route.ts) writes the GraphQL
// global ID (e.g. "Z2lkOi8vSm9iYmVyL0FjY291bnQvMTIzNDU=") while
// webhooks send the bare numeric id. Future imports/connections
// may converge on one form; this helper tolerates both.
// ─────────────────────────────────────────────────────────────

import { createHmac, timingSafeEqual } from 'crypto'
import { supabaseService } from './supabase-service'
import { extractJobberId } from './jobber-import'

export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
): boolean {
  const secret = process.env.JOBBER_WEBHOOK_SECRET
  if (!secret) {
    console.error('[jobber-webhook] JOBBER_WEBHOOK_SECRET not set — refusing all webhooks')
    return false
  }
  if (!signature) return false

  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')

  // Header may be base64 or hex depending on Jobber config. Try base64
  // first (Jobber's documented default), then hex.
  const candidates = [
    computed,
    Buffer.from(computed, 'base64').toString('hex'),
  ]

  try {
    const sigBuf = Buffer.from(signature, 'utf8')
    for (const c of candidates) {
      const cBuf = Buffer.from(c, 'utf8')
      if (cBuf.length === sigBuf.length && timingSafeEqual(cBuf, sigBuf)) return true
    }
  } catch {
    return false
  }
  return false
}

export type LocationRow = {
  id: string
  location_id: string
  name: string | null
  timezone: string | null
  jobber_account_id: string | null
  jobber_access_token: string | null
}

export async function lookupLocationByJobberAccountId(
  accountId: string | number,
): Promise<LocationRow | null> {
  const raw = String(accountId)
  const numeric = extractJobberId(raw) // handles both bare numeric and base64 forms

  // Try exact match on the raw value first (covers either form), then
  // fall back to a match against the extracted numeric portion of stored
  // values when they're base64-encoded.
  const { data: byRaw } = await supabaseService
    .from('locations')
    .select('id, location_id, name, timezone, jobber_account_id, jobber_access_token')
    .eq('jobber_account_id', raw)
    .maybeSingle()
  if (byRaw) return byRaw as LocationRow

  if (numeric && numeric !== raw) {
    const { data: byNumeric } = await supabaseService
      .from('locations')
      .select('id, location_id, name, timezone, jobber_account_id, jobber_access_token')
      .eq('jobber_account_id', numeric)
      .maybeSingle()
    if (byNumeric) return byNumeric as LocationRow
  }

  // Last resort: scan locations that have a token + base64 account_id and
  // compare the decoded numeric portion. O(n_locations) but n is small
  // (≤ ~20 production locations) and the fast paths above cover the
  // common case once jobber_account_id is normalized.
  if (numeric) {
    const { data: rows } = await supabaseService
      .from('locations')
      .select('id, location_id, name, timezone, jobber_account_id, jobber_access_token')
      .not('jobber_account_id', 'is', null)
    for (const row of rows || []) {
      if (extractJobberId(row.jobber_account_id) === numeric) return row as LocationRow
    }
  }

  return null
}
