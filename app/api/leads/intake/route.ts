// app/api/leads/intake/route.ts
//
// Producer-agnostic webhook for inbound lead form submissions.
// Auth: X-API-Key header, constant-time compared to LEAD_INTAKE_API_KEY env.
//
// MATCH-OR-CREATE: this was the last un-deduped door into people-world
// (Jobber import dedups on jobber_client_id, NewClientSheet matches
// before creating). Before inserting, the submission is matched against
// existing leads via the shared clientMatch vocabulary, evaluated with
// no human present:
//   SOLID       — exact email or exact phone_normalized → exactly one
//                 lead. NO new row: fill the matched lead's empty
//                 contact fields, log a "Webform resubmission"
//                 touchpoint, enroll drip only if never enrolled.
//   IN QUESTION — strong key hits >1 lead, conflicting keys, or a
//                 name-only match. Still CREATE (never lose a webform
//                 lead) but set possible_duplicate_of + a touchpoint.
//   NO MATCH    — insert as before (stage='New').
// A failed dedup read degrades to plain insert with a warning — losing
// the lead is worse than a duplicate.
//
// No service_requests row is created here — these are pre-Jobber leads,
// the Hive pipeline will pick them up via stage filter.
//
// CONTACT POLICY: full_name + at least one of (valid email | phone with
// ≥7 digits). FB/IG lead ads are often phone-only — requiring email
// would 400 those and lose the lead. Phone-only leads are captured but
// NOT drip-enrolled (see the no_email gate below).
//
// OBSERVABILITY: every authenticated outcome writes a sync_log row
// (topic=LEAD_INTAKE) so failures surface on the admin Webhooks tab and
// the Slack digest instead of dying in Vercel logs. Payload contract
// for Make lives in INTAKE_CONTRACT.md.

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { supabaseService } from '@/lib/supabase-service'
import { writeSyncLog } from '@/lib/sync-log'
import { applyDripSideEffects, startDripForLead } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'
import { notifyNewLead } from '@/lib/lead-notification-email'
import {
  queryLeadMatches,
  classifyLeadMatches,
} from '@/components/hive/shared/clientMatch'

export const runtime = 'nodejs'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function verifyApiKey(headerValue: string | null): boolean {
  const expected = process.env.LEAD_INTAKE_API_KEY
  if (!expected || !headerValue) return false
  const a = Buffer.from(headerValue)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function splitName(full: string): { first: string | null; last: string | null } {
  const trimmed = full.trim()
  const idx = trimmed.indexOf(' ')
  if (idx === -1) return { first: trimmed || null, last: null }
  return {
    first: trimmed.slice(0, idx),
    last: trimmed.slice(idx + 1).trim() || null,
  }
}

// ─── sync_log observability ─────────────────────────────────────
// Every AUTHENTICATED outcome writes a sync_log row so a failed Make
// lead is visible on the admin Webhooks tab + the Slack digest instead
// of dying in Vercel logs. 401s are deliberately NOT logged — mirrors
// the Jobber receiver's signature-invalid exception (unauthenticated
// noise must not be able to fill the log).
//
// The `topic=LEAD_INTAKE` token is load-bearing: fetchWebhookLogEvents
// (lib/webhook-observability.ts) drops rows without a parseable topic.
// sync_log.location_id holds the location SLUG — the dashboard resolves
// location names by joining on locations.location_id, same as the
// Jobber dispatcher. writeSyncLog is fail-soft internally; awaited
// because Vercel serverless kills post-response work.
async function logIntake(args: {
  status: 'success' | 'error'
  landed: 'landed' | 'na'
  locationSlug: string | null
  entityId: string
  detail: string
}) {
  await writeSyncLog({
    location_id: args.locationSlug,
    entity_id: args.entityId,
    entity_type: 'client',
    direction: 'inbound',
    status: args.status,
    message: `[intake] topic=LEAD_INTAKE ${args.detail}`.slice(0, 1000),
    landed_status: args.landed,
  })
}

export async function POST(req: NextRequest) {
  if (!verifyApiKey(req.headers.get('x-api-key'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    await logIntake({
      status: 'error', landed: 'na', locationSlug: null,
      entityId: 'unknown', detail: 'error=invalid_json',
    })
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const {
    location_slug,
    full_name,
    email,
    phone,
    address,
    city,
    state,
    zip,
    project_type,
    message,
    preferred_contact,
    source,
    metadata,
  } = body || {}

  // `message` is the project-details free-text the form collects ("I have a
  // medically complex condition…"). It is the CLIENT-level request record →
  // leads.request_details (what /api/leads POST writes, EditableDesc edits,
  // and engagements/people-mapper read as the description). Trimmed; empty
  // stays null so the merge path never overwrites good data with a blank.
  const requestDetails: string | null =
    typeof message === 'string' && message.trim() ? message.trim() : null
  // preferred_contact ("Text" | "Email" | "Phone" | …) — producer-agnostic
  // free-text mirroring Zoho's Preferred_Method_of_Contact. Stored in the
  // dedicated leads.preferred_contact column (see migrations/leads_preferred_contact.sql).
  const preferredContact: string | null =
    typeof preferred_contact === 'string' && preferred_contact.trim()
      ? preferred_contact.trim()
      : null

  // Email-or-phone: FB/IG lead ads are often phone-only. An email that
  // is present but unparseable is treated as absent (warned below) —
  // never stored, never drip-targeted.
  const validEmail: string | null =
    typeof email === 'string' && EMAIL_RE.test(email) ? email.trim() : null
  const phoneDigits = typeof phone === 'string' ? phone.replace(/\D/g, '') : ''
  const hasPhone = phoneDigits.length >= 7
  // Best pre-insert handle for error-row entity_id: no lead id exists yet.
  const emailEntity =
    typeof email === 'string' && email.trim() ? email.trim() : 'unknown'

  if (!location_slug || typeof location_slug !== 'string') {
    await logIntake({
      status: 'error', landed: 'na', locationSlug: null,
      entityId: emailEntity, detail: 'error=location_slug required',
    })
    return NextResponse.json({ error: 'location_slug required' }, { status: 400 })
  }
  if (!full_name || typeof full_name !== 'string' || !full_name.trim()) {
    await logIntake({
      status: 'error', landed: 'na', locationSlug: null,
      entityId: emailEntity, detail: 'error=full_name required',
    })
    return NextResponse.json({ error: 'full_name required' }, { status: 400 })
  }
  if (!validEmail && !hasPhone) {
    await logIntake({
      status: 'error', landed: 'na', locationSlug: null,
      entityId: emailEntity, detail: 'error=email_or_phone_required',
    })
    return NextResponse.json({ error: 'email_or_phone_required' }, { status: 400 })
  }

  // Slug lives in locations.location_id (Zoho-style ID, used as slug across repo).
  const { data: location, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, location_id, lifecycle_status')
    .eq('location_id', location_slug)
    .maybeSingle()

  if (locErr) {
    await logIntake({
      status: 'error', landed: 'na', locationSlug: null,
      entityId: location_slug,
      detail: `error=location_lookup_failed slug=${location_slug} — ${locErr.message}`,
    })
    return NextResponse.json(
      { error: 'location_lookup_failed', detail: locErr.message },
      { status: 500 },
    )
  }
  if (!location) {
    // The slug is the diagnostic: a Make mapping typo must be readable
    // straight off the dashboard row.
    await logIntake({
      status: 'error', landed: 'na', locationSlug: null,
      entityId: location_slug,
      detail: `error=location_not_found slug=${location_slug} — no location with this slug (check the Make location mapping)`,
    })
    return NextResponse.json({ error: 'location_not_found' }, { status: 400 })
  }

  const { first, last } = splitName(full_name)
  const now = new Date().toISOString()

  // ─── Match-or-create dedup gate ───────────────────────────────
  // Scoped to this location (multi-tenant: the same person at another
  // location is a different lead). queryLeadMatches carries the standing
  // patterns: .or() only from existing keys, .not('is_junk','is',true),
  // .range(0,999). Phone matches phone_normalized (generated, digits-
  // only) — raw leads.phone is free-text and never matched DB-side.
  let possibleDuplicateIds: string[] = []
  const dedupWarnings: string[] = []
  if (email && !validEmail) {
    // Present-but-unparseable email: the lead proceeds on phone, but the
    // dropped value must be visible in the response + sync_log message.
    dedupWarnings.push('email_invalid_ignored')
  }
  try {
    const strongRows = await queryLeadMatches(supabaseService, {
      email: validEmail,
      phone,
      locationUuid: location.id,
    })
    // (cast: the JS module's inferred return is a union TS won't narrow)
    const verdict = classifyLeadMatches(strongRows, { email: validEmail, phone }) as {
      tier: 'solid' | 'in_question' | 'none'
      match?: any
      matchedOn?: string
      matchIds?: string[]
    }

    if (verdict.tier === 'solid') {
      return await mergeResubmission({
        matched: verdict.match,
        matchedOn: verdict.matchedOn ?? 'email',
        location,
        submission: { email: validEmail, phone, address, city, state, zip, project_type, message, preferred_contact },
        source: source || 'web_form',
        baseWarnings: dedupWarnings,
        now,
      })
    }

    if (verdict.tier === 'in_question') {
      possibleDuplicateIds = verdict.matchIds ?? []
    } else {
      // No strong-key hit — name-only check. Name matches NEVER merge;
      // they can only flag. ilike with escaped wildcards = case-
      // insensitive exact match on the stored name.
      const nameEsc = full_name.trim().replace(/[\\%_]/g, (m) => `\\${m}`)
      const { data: nameRows, error: nameErr } = await supabaseService
        .from('leads')
        .select('id, name')
        .eq('location_uuid', location.id)
        .ilike('name', nameEsc)
        .not('is_junk', 'is', true)
        .range(0, 999)
      if (nameErr) throw new Error(nameErr.message)
      if (nameRows && nameRows.length > 0) {
        possibleDuplicateIds = nameRows.map((r: { id: string }) => r.id)
      }
    }
  } catch (err: any) {
    // Losing a webform lead is worse than a duplicate — degrade to the
    // pre-dedup blind insert and surface a warning.
    console.error('[intake] dedup match failed — falling back to plain insert', err)
    dedupWarnings.push(`dedup_match_failed: ${err?.message || String(err)}`)
    possibleDuplicateIds = []
  }

  // leads.location_id stores the slug string (matches lib/dual-write.ts and
  // app/api/import/jobber-clients/route.ts). location_uuid is the canonical
  // FK used by drip/welcome/stage-email reads — write both.
  // NOTE: phone_normalized is a generated column — never in the payload.
  const { data: lead, error: insertErr } = await supabaseService
    .from('leads')
    .insert({
      location_id: location.location_id,
      location_uuid: location.id,
      name: full_name.trim(),
      first_name: first,
      last_name: last,
      email: validEmail,
      phone: phone || null,
      address: address || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      project_type: project_type || null,
      stage: 'New',
      source: source || 'web_form',
      request_details: requestDetails,
      preferred_contact: preferredContact,
      metadata: metadata || {},
      ...(possibleDuplicateIds.length
        ? { possible_duplicate_of: possibleDuplicateIds }
        : {}),
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single()

  if (insertErr || !lead) {
    await logIntake({
      status: 'error', landed: 'na', locationSlug: location.location_id,
      entityId: emailEntity,
      detail: `error=insert_failed — ${insertErr?.message || 'insert returned no row'}`,
    })
    return NextResponse.json(
      { error: 'insert_failed', detail: insertErr?.message },
      { status: 500 },
    )
  }

  // ─── Post-create side effects ─────────────────────────────────
  // Mirror /api/leads (the in-app POST) so a web-form lead lands in the
  // same state as a hand-created one. Failures here are non-fatal — the
  // lead row is already written and that's the primary goal — so we log
  // and collect warnings rather than returning an error.
  const warnings: string[] = [...dedupWarnings]

  // Seed creation touchpoint (unconditional, even for pre-launch
  // locations) so the internal activity log reflects the capture and the
  // PersonPanel "Last Activity" field isn't an em-dash. Mirrors the
  // touchpoint written by /api/leads POST 1:1.
  try {
    const { error: tpErr } = await supabaseService.from('touchpoints').insert({
      lead_id:       lead.id,
      location_uuid: location.id,
      kind:          'system',
      method:        'system',
      label:         'Client created',
      status:        'done',
      occurred_at:   now,
      user_id:       null,
    })
    if (tpErr) throw tpErr
  } catch (err: any) {
    console.error('[intake] touchpoint insert failed', err)
    warnings.push(`touchpoint_insert_failed: ${err?.message || String(err)}`)
  }

  // IN QUESTION tier: the lead row is flagged via possible_duplicate_of;
  // also leave a human-readable trace in the activity log.
  if (possibleDuplicateIds.length > 0) {
    try {
      const { error: dupTpErr } = await supabaseService.from('touchpoints').insert({
        lead_id:       lead.id,
        location_uuid: location.id,
        kind:          'system',
        method:        'system',
        label:         'Possible duplicate — webform matched existing lead(s)',
        notes:         `Suspected match: ${possibleDuplicateIds.join(', ')}`,
        status:        'done',
        occurred_at:   now,
        user_id:       null,
      })
      if (dupTpErr) throw dupTpErr
    } catch (err: any) {
      console.error('[intake] duplicate-flag touchpoint insert failed', err)
      warnings.push(`dup_touchpoint_insert_failed: ${err?.message || String(err)}`)
    }
  }

  // Drip enrollment is gated on the location having completed onboarding.
  // lifecycle_status flips 'onboarding' → 'active' on the launch endpoint;
  // strict === 'active' is fail-closed (null / any other state skips). A
  // pre-launch location may not have send_from_email / default_drip_path
  // set yet, so firing the drip would silently half-fail. Capture the lead
  // + touchpoint regardless, but only enroll active locations.
  let dripEnrolled = false
  let dripSkippedReason: string | null = null
  if (!validEmail) {
    // CRITICAL: never enroll a phone-only lead. sendDripStep would stop
    // the progress row with stopped_reason='no_email', and the merge path
    // blocks re-enrollment on ANY existing progress row — enrolling here
    // would permanently burn the lead's drip eligibility. Skipping keeps
    // a later email-bearing resubmission eligible.
    dripSkippedReason = 'no_email'
    console.log(`[intake] lead ${lead.id} has no email — drip not enrolled`)
  } else if (location.lifecycle_status === 'active') {
    // Mirror /api/leads POST: applyDripSideEffects starts the default drip
    // (prevStage=null signals a fresh start), then an inline sendDripStep
    // fires step 1 immediately instead of waiting for the hourly cron. Both
    // are awaited because Vercel serverless kills background work after the
    // response is sent. Errors are non-fatal.
    try {
      await applyDripSideEffects({
        leadId:       lead.id,
        locationUuid: location.id,
        prevStage:    null,
        patch:        { stage: 'New' },
      })
      dripEnrolled = true
    } catch (err: any) {
      console.error('[intake] applyDripSideEffects threw', err)
      warnings.push(`drip_side_effects_failed: ${err?.message || String(err)}`)
    }

    if (dripEnrolled) {
      try {
        await sendDripStep(lead.id)
      } catch (err: any) {
        console.error('[intake] inline sendDripStep threw', err)
        warnings.push(`drip_send_failed: ${err?.message || String(err)}`)
      }
    }
  } else {
    console.log(
      `[intake] location ${location.location_id} is not active ` +
        `(lifecycle_status=${location.lifecycle_status ?? 'null'}) — ` +
        `lead captured but drip not enrolled`,
    )
  }

  // ─── New-lead notification (CREATE path only) ─────────────────
  // A genuinely new lead just landed: notify the location's effective
  // recipients (B1 resolveLeadRecipients) with ONE email to all of them.
  // Deliberately NOT called on the merge/resubmit path above — a returning
  // client's resubmission must never re-notify. Non-fatal: a send failure
  // logs + warns but never flips the lead capture, which already succeeded.
  // Zero recipients is a normal quiet no-send.
  let notifiedCount = 0
  try {
    const notify = await notifyNewLead({
      location: { id: location.id, name: location.name },
      lead: {
        id: lead.id,
        name: full_name.trim(),
        email: validEmail,
        phone: phone || null,
        project_type: project_type || null,
        request_details: requestDetails,
        preferred_contact: preferredContact,
      },
    })
    notifiedCount = notify.sent ? notify.recipientCount : 0
    if (notify.error) {
      warnings.push(`lead_notification_failed: ${notify.error}`)
    }
  } catch (err: any) {
    console.error('[intake] notifyNewLead threw', err)
    warnings.push(`lead_notification_failed: ${err?.message || String(err)}`)
  }

  // Success row. Warnings never flip status — the lead row landed and
  // that's the primary goal — but they must be readable off the row.
  const dedupTier = possibleDuplicateIds.length
    ? `in_question(${possibleDuplicateIds.length})`
    : 'none'
  await logIntake({
    status: 'success', landed: 'landed', locationSlug: location.location_id,
    entityId: lead.id,
    detail:
      `lead=${lead.id} source=${source || 'web_form'} dedup=${dedupTier}` +
      ` drip_enrolled=${dripEnrolled} notified=${notifiedCount}` +
      (dripSkippedReason ? ` drip_skipped_reason=${dripSkippedReason}` : '') +
      (warnings.length ? ` — warnings: ${warnings.join('; ')}` : ''),
  })

  return NextResponse.json({
    success: true,
    lead_id: lead.id,
    location: {
      id: location.id,
      name: location.name,
      slug: location.location_id,
      lifecycle_status: location.lifecycle_status ?? null,
    },
    drip_enrolled: dripEnrolled,
    ...(dripSkippedReason ? { drip_skipped_reason: dripSkippedReason } : {}),
    ...(possibleDuplicateIds.length
      ? { possible_duplicate_of: possibleDuplicateIds }
      : {}),
    ...(warnings.length ? { warnings } : {}),
  })
}

// ─── SOLID-tier merge ───────────────────────────────────────────
// The submission is a returning client: NO new leads row. Fill the
// matched lead's empty contact fields (never overwrite good data with a
// resubmission), log a "Webform resubmission" touchpoint, and enroll
// the drip only if this lead has never had a drip progress row.
// phone_normalized is generated — it must never appear in the payload;
// filling raw `phone` makes Postgres recompute it.
const isEmptyField = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

async function mergeResubmission(args: {
  matched: {
    id: string
    stage?: string | null
    email?: string | null
    phone?: string | null
    address?: string | null
    city?: string | null
    state?: string | null
    zip?: string | null
    project_type?: string | null
    request_details?: string | null
    preferred_contact?: string | null
  }
  matchedOn: string
  location: { id: string; name: string; location_id: string; lifecycle_status: string | null }
  submission: {
    email: string | null
    phone?: string | null
    address?: string | null
    city?: string | null
    state?: string | null
    zip?: string | null
    project_type?: string | null
    message?: string | null
    preferred_contact?: string | null
  }
  source: string
  baseWarnings: string[]
  now: string
}): Promise<NextResponse> {
  const { matched, matchedOn, location, submission, source, now } = args
  const warnings: string[] = [...args.baseWarnings]

  const incoming: Record<string, string | null> = {
    email: submission.email || null,
    phone: submission.phone || null,
    address: submission.address || null,
    city: submission.city || null,
    state: submission.state || null,
    zip: submission.zip || null,
    project_type: submission.project_type || null,
    // message → request_details, same fill-empty rule: only backfill when the
    // matched lead has none and this submission carries a non-blank message.
    request_details: submission.message?.trim() || null,
    preferred_contact: submission.preferred_contact?.trim() || null,
  }
  const fills: Record<string, unknown> = {}
  for (const key of Object.keys(incoming)) {
    if (!isEmptyField(incoming[key]) && isEmptyField((matched as any)[key])) {
      fills[key] = incoming[key]
    }
  }

  let fillUpdateFailed = false
  if (Object.keys(fills).length > 0) {
    fills.updated_at = now
    const { error: updErr } = await supabaseService
      .from('leads')
      .update(fills)
      .eq('id', matched.id)
    if (updErr) {
      console.error('[intake] merge fill update failed', updErr)
      warnings.push(`merge_update_failed: ${updErr.message}`)
      fillUpdateFailed = true
    }
  }

  // The email the lead ACTUALLY has on record after the merge: what was
  // already stored, else the submitted fill — but only if the fill write
  // succeeded (enrolling against an email that never persisted would let
  // sendDripStep stop the row with stopped_reason='no_email', permanently
  // burning drip eligibility — same trap as the fresh-insert path).
  const emailOnRecord: string | null = !isEmptyField(matched.email)
    ? (matched.email as string)
    : !fillUpdateFailed && typeof fills.email === 'string'
      ? fills.email
      : null

  try {
    const { error: tpErr } = await supabaseService.from('touchpoints').insert({
      lead_id:       matched.id,
      location_uuid: location.id,
      kind:          'system',
      method:        'system',
      label:         'Webform resubmission',
      notes:         submission.message?.trim()
        ? `Matched on ${matchedOn}. Message: ${submission.message.trim()}`
        : `Matched on ${matchedOn}.`,
      status:        'done',
      occurred_at:   now,
      user_id:       null,
    })
    if (tpErr) throw tpErr
  } catch (err: any) {
    console.error('[intake] resubmission touchpoint insert failed', err)
    warnings.push(`touchpoint_insert_failed: ${err?.message || String(err)}`)
  }

  // Drip: only if never enrolled (ANY progress row — active, completed,
  // or stopped — means the lead already had its shot; a resubmission
  // must not restart a finished sequence or double-send step 1). Same
  // active-location gate as the fresh-insert path, and only drip-
  // eligible stages seed (mirrors resumePausedDripsForLead).
  let dripEnrolled = false
  let dripSkippedReason: string | null = null
  if (!emailOnRecord) {
    dripSkippedReason = 'no_email'
    console.log(`[intake] merged lead ${matched.id} has no email — drip not enrolled`)
  } else if (location.lifecycle_status === 'active') {
    try {
      const { data: anyProgress, error: progErr } = await supabaseService
        .from('lead_drip_progress')
        .select('id')
        .eq('lead_id', matched.id)
        .limit(1)
        .maybeSingle()
      if (progErr) throw progErr

      if (!anyProgress && (matched.stage === 'New' || matched.stage === 'Attempting')) {
        await startDripForLead(matched.id, location.id)
        // startDripForLead swallows its own skips (paused lead, no
        // default path) — re-check so drip_enrolled reports the truth.
        const { data: seeded } = await supabaseService
          .from('lead_drip_progress')
          .select('id')
          .eq('lead_id', matched.id)
          .limit(1)
          .maybeSingle()
        if (seeded) {
          dripEnrolled = true
          try {
            await sendDripStep(matched.id)
          } catch (err: any) {
            console.error('[intake] merge inline sendDripStep threw', err)
            warnings.push(`drip_send_failed: ${err?.message || String(err)}`)
          }
        }
      }
    } catch (err: any) {
      console.error('[intake] merge drip enrollment failed', err)
      warnings.push(`drip_side_effects_failed: ${err?.message || String(err)}`)
    }
  }

  await logIntake({
    status: 'success', landed: 'landed', locationSlug: location.location_id,
    entityId: matched.id,
    detail:
      `lead=${matched.id} source=${source} merged (matched on ${matchedOn})` +
      ` drip_enrolled=${dripEnrolled}` +
      (dripSkippedReason ? ` drip_skipped_reason=${dripSkippedReason}` : '') +
      (warnings.length ? ` — warnings: ${warnings.join('; ')}` : ''),
  })

  return NextResponse.json({
    success: true,
    lead_id: matched.id,
    merged: true,
    matched_on: matchedOn,
    location: {
      id: location.id,
      name: location.name,
      slug: location.location_id,
      lifecycle_status: location.lifecycle_status ?? null,
    },
    drip_enrolled: dripEnrolled,
    ...(dripSkippedReason ? { drip_skipped_reason: dripSkippedReason } : {}),
    ...(warnings.length ? { warnings } : {}),
  })
}
