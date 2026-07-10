// app/api/webhooks/jobber/route.ts
//
// Inbound webhook receiver for Jobber events.
//
// Flow:
//   1. Read RAW body (signature verification needs exact bytes).
//   2. Verify HMAC-SHA256 using JOBBER_CLIENT_SECRET (Jobber signs
//      webhooks with the OAuth client secret — no separate webhook
//      secret exists in their model).
//   3. Parse + extract { topic, account_id, item_id, occurred_at }.
//   4. Look up the Bee Hub location via jobber_account_id.
//   5. Dispatch to per-topic handler (lib/jobber-webhook-handlers.ts).
//   6. Landed check (lib/webhook-landed.ts) — re-read the record's
//      actual state and record landed/not_landed/na.
//   7. Write a sync_log row (direction='inbound', landed_status set).
//   8. Always 200 once we accept the request — Jobber stops retrying.
//      Unknown topics / disconnected accounts / handler errors are
//      logged but don't propagate as 5xx.
//
// EVERY signature-valid event writes a sync_log row — including
// unparseable payloads, missing-field envelopes, and events from
// accounts with no connected location (those log with location_id=null).
// The one deliberate exception: signature-INVALID requests are 401'd
// without a DB write — they are unauthenticated, and persisting them
// would let anyone spam rows into sync_log.
//
// Replay protection: occurred_at older than 5 minutes is logged but
// still processed (Jobber occasionally re-sends).
//
// JOBBER_CLIENT_SECRET must be set in Vercel env vars (already used by
// the OAuth flow). Without it, verifyWebhookSignature returns false and
// every webhook is 401'd.

import { NextRequest, NextResponse } from 'next/server'
import {
  verifyWebhookSignature,
  lookupLocationByJobberAccountId,
} from '@/lib/jobber-webhook'
import {
  TOPIC_HANDLERS,
  SUPPORTED_TOPICS,
  type HandlerCtx,
  type HandlerResult,
} from '@/lib/jobber-webhook-handlers'
import { writeSyncLog } from '@/lib/sync-log'
import { checkLanded, type LandedStatus } from '@/lib/webhook-landed'

export const runtime = 'nodejs'
export const maxDuration = 60

const REPLAY_WINDOW_MS = 5 * 60 * 1000

// Jobber's webhook envelope ships in slightly different shapes between
// the management API and per-account subscriptions. Accept both:
//   { topic, accountId, itemId, occurredAt }
//   { data: { webHookEvent: { topic, accountId, itemId, occurredAt } } }
type EventEnvelope = {
  topic?: string
  accountId?: string | number
  itemId?: string | number
  occurredAt?: string
  data?: {
    webHookEvent?: {
      topic?: string
      accountId?: string | number
      itemId?: string | number
      occurredAt?: string
    }
  }
}

function unwrap(env: EventEnvelope) {
  const inner = env.data?.webHookEvent
  return {
    topic: env.topic || inner?.topic || null,
    accountId: env.accountId ?? inner?.accountId ?? null,
    itemId: env.itemId ?? inner?.itemId ?? null,
    occurredAt: env.occurredAt || inner?.occurredAt || null,
  }
}

export async function POST(req: NextRequest) {
  // 1. Read raw body for signature verification.
  const rawBody = await req.text()

  // 2. HMAC-SHA256 verify.
  const signature = req.headers.get('x-jobber-hmac-sha256')
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn('[jobber-webhook] signature_invalid')
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  // 3. Parse + unwrap envelope.
  // Everything past the signature check is a genuine Jobber event and
  // gets a sync_log row — "capture every webhook" includes payloads we
  // can't parse or can't attribute to a connected location. Those rows
  // carry location_id=null (requires migrations/sync_log_landed_status.sql).
  let envelope: EventEnvelope
  try {
    envelope = JSON.parse(rawBody) as EventEnvelope
  } catch (err) {
    console.error('[jobber-webhook] bad_json', err)
    await writeSyncLog({
      location_id: null,
      entity_id: 'unparseable',
      entity_type: 'request',
      direction: 'inbound',
      status: 'error',
      message: `topic=UNPARSEABLE error=bad_json — signature-valid body failed JSON.parse: ${rawBody.slice(0, 180)}`,
      landed_status: 'na',
    })
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }

  const { topic, accountId, itemId, occurredAt } = unwrap(envelope)

  if (!topic || accountId == null || itemId == null) {
    console.error('[jobber-webhook] missing_fields', { topic, accountId, itemId })
    await writeSyncLog({
      location_id: null,
      entity_id: itemId != null ? String(itemId) : 'unknown',
      entity_type: topic ? topicToEntityType(topic) : 'request',
      direction: 'inbound',
      jobber_record_id: itemId != null ? String(itemId) : undefined,
      status: 'error',
      message: `topic=${topic || 'UNKNOWN'} item=${itemId ?? 'unknown'} error=missing_fields account=${accountId ?? 'unknown'}`,
      landed_status: 'na',
    })
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  // Replay-window check (warn-only).
  if (occurredAt) {
    const ageMs = Date.now() - new Date(occurredAt).getTime()
    if (Number.isFinite(ageMs) && ageMs > REPLAY_WINDOW_MS) {
      console.warn(
        `[jobber-webhook] stale_event topic=${topic} item=${itemId} age=${Math.round(ageMs / 1000)}s — processing anyway`,
      )
    }
  }

  // 4. Look up the location via jobber_account_id.
  const location = await lookupLocationByJobberAccountId(accountId)
  if (!location) {
    // Common case: an account that was once connected then disconnected.
    // Acknowledge so Jobber stops retrying. Logged with location_id=null
    // so the event is still visible on the admin dashboard.
    console.warn(
      `[jobber-webhook] no_location_for_account topic=${topic} account=${accountId} item=${itemId}`,
    )
    await writeSyncLog({
      location_id: null,
      entity_id: String(itemId),
      entity_type: topicToEntityType(topic),
      direction: 'inbound',
      jobber_record_id: String(itemId),
      status: 'success',
      message: `topic=${topic} item=${itemId} — skipped: no connected location for account=${accountId}`,
      landed_status: 'na',
    })
    return NextResponse.json({ ok: true, skipped: 'unknown_account' })
  }

  // 5. Unknown topic — acknowledge + log + skip.
  if (!SUPPORTED_TOPICS.includes(topic)) {
    console.warn(`[jobber-webhook] unknown_topic topic=${topic} item=${itemId}`)
    await writeSyncLog({
      location_id: location.location_id,
      entity_id: String(itemId),
      direction: 'inbound',
      jobber_record_id: String(itemId),
      status: 'success',
      message: `[skipped] unknown topic=${topic}`,
      landed_status: 'na',
    })
    return NextResponse.json({ ok: true, skipped: 'unknown_topic' })
  }

  // 6. Dispatch.
  const ctx: HandlerCtx = {
    topic,
    itemId: String(itemId),
    occurredAt: occurredAt || new Date().toISOString(),
    location,
  }

  let result: HandlerResult
  try {
    result = await TOPIC_HANDLERS[topic](ctx)
  } catch (err: any) {
    console.error(`[jobber-webhook] handler_threw topic=${topic} item=${itemId}`, err)
    result = { processed: false, error: String(err?.message || err) }
  }

  // 7. Landed check — did the record actually reach its intended state?
  // Recorded, not inferred from "no error threw" (lib/webhook-landed.ts).
  // checkLanded never throws (records 'na' on internal failure).
  const landed: LandedStatus = await checkLanded(ctx, result)

  // 8. sync_log.
  const entityType = topicToEntityType(topic)
  const status = result.error ? 'error' : 'success'
  const stagePart =
    result.lead_stage && result.prev_stage && result.lead_stage !== result.prev_stage
      ? ` (stage ${result.prev_stage} → ${result.lead_stage})`
      : ''
  const errPart = result.error ? ` error=${result.error}` : ''
  const leadPart = result.lead_id ? ` lead=${result.lead_id}` : ''
  const notePart = result.note ? ` — ${result.note}` : ''
  const message =
    `topic=${topic} item=${itemId}${leadPart}${stagePart}${errPart}${notePart}`.slice(0, 1000)

  await writeSyncLog({
    location_id: location.location_id,
    entity_id: result.lead_id || String(itemId),
    entity_type: entityType,
    direction: 'inbound',
    jobber_record_id: String(itemId),
    status,
    message,
    landed_status: landed,
  })

  // Always 200 after we accept it — Jobber retries on 5xx, and the
  // sync_log row is the diagnostic trail for any handler errors.
  return NextResponse.json({
    ok: true,
    processed: result.processed,
    landed,
    lead_id: result.lead_id || null,
    lead_stage: result.lead_stage || null,
    prev_stage: result.prev_stage || null,
    error: result.error || null,
  })
}

function topicToEntityType(
  topic: string,
):
  | 'client'
  | 'request'
  | 'quote'
  | 'job'
  | 'invoice'
  | 'property'
  | 'assessment'
  | 'location' {
  if (topic === 'APP_DISCONNECT')     return 'location'
  if (topic.startsWith('CLIENT_'))    return 'client'
  if (topic.startsWith('REQUEST_'))   return 'request'
  if (topic.startsWith('QUOTE_'))     return 'quote'
  if (topic.startsWith('JOB_'))       return 'job'
  if (topic.startsWith('INVOICE_'))   return 'invoice'
  if (topic.startsWith('PROPERTY_'))  return 'property'
  if (topic.startsWith('ASSESSMENT_')) return 'assessment'
  return 'request'
}
