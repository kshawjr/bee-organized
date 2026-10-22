// app/api/webhooks/clickup/route.ts
//
// Inbound webhook receiver for ClickUp — the Bee Desk half of the two-way sync
// (lib/clickup-sync has the rules). Same shape as app/api/webhooks/jobber:
//
//   1. Read the RAW body (the signature is over the exact bytes).
//   2. Verify X-Signature — hex HMAC-SHA256 of the body with
//      CLICKUP_WEBHOOK_SECRET (the secret ClickUp returns at registration).
//      Invalid → 401 with NO DB write: unauthenticated requests must not be
//      able to spam rows into sync_log.
//   3. Parse; unparseable-but-signed → sync_log error row + 400.
//   4. handleClickUpEvent does the rest and writes its own sync_log row for
//      every outcome except Source Internal/Idea (which trigger nothing).
//   5. 200 once accepted, errors included — ClickUp retries non-2xx and then
//      suspends the webhook, which would stop every later reply too. The
//      sync_log row is the loud record; the body says ok:false.
//
// Register for one event: taskStatusUpdated. The reply is read from the
// task's Reply to Owner field at the moment of the move (lib/clickup-sync).

import { NextRequest, NextResponse } from 'next/server'
import { clickUpClientFromEnv, verifyClickUpSignature } from '@/lib/clickup'
import { handleClickUpEvent } from '@/lib/clickup-sync'
import { supabaseService } from '@/lib/supabase-service'
import { writeSyncLog } from '@/lib/sync-log'

export const runtime = 'nodejs'
// Same reason as the Jobber receiver: supabase-js reads go through Next's
// patched fetch, and a constant-predicate read must never be served from the
// Data Cache.
export const fetchCache = 'force-no-store'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const rawBody = await req.text()

  if (!verifyClickUpSignature(rawBody, req.headers.get('x-signature'))) {
    console.warn('[clickup-webhook] signature_invalid')
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let event: { event?: string; task_id?: string }
  try {
    event = JSON.parse(rawBody)
  } catch (err) {
    console.error('[clickup-webhook] bad_json', err)
    await writeSyncLog({
      location_id: null,
      entity_id: 'unparseable',
      entity_type: 'feedback',
      direction: 'inbound',
      status: 'error',
      message: `clickup error=bad_json — signature-valid body failed JSON.parse: ${rawBody.slice(0, 180)}`,
    })
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }

  const result = await handleClickUpEvent({
    client: clickUpClientFromEnv(),
    db: supabaseService,
    event,
  })
  return NextResponse.json(result)
}
