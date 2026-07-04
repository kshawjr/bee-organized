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

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { supabaseService } from '@/lib/supabase-service'
import { applyDripSideEffects, startDripForLead } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'
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

export async function POST(req: NextRequest) {
  if (!verifyApiKey(req.headers.get('x-api-key'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
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
    source,
    metadata,
  } = body || {}

  if (!location_slug || typeof location_slug !== 'string') {
    return NextResponse.json({ error: 'location_slug required' }, { status: 400 })
  }
  if (!full_name || typeof full_name !== 'string' || !full_name.trim()) {
    return NextResponse.json({ error: 'full_name required' }, { status: 400 })
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 })
  }

  // Slug lives in locations.location_id (Zoho-style ID, used as slug across repo).
  const { data: location, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, location_id, lifecycle_status')
    .eq('location_id', location_slug)
    .maybeSingle()

  if (locErr) {
    return NextResponse.json(
      { error: 'location_lookup_failed', detail: locErr.message },
      { status: 500 },
    )
  }
  if (!location) {
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
  try {
    const strongRows = await queryLeadMatches(supabaseService, {
      email,
      phone,
      locationUuid: location.id,
    })
    // (cast: the JS module's inferred return is a union TS won't narrow)
    const verdict = classifyLeadMatches(strongRows, { email, phone }) as {
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
        submission: { email, phone, address, city, state, zip, project_type, message },
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
      email: email.trim(),
      phone: phone || null,
      address: address || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      project_type: project_type || null,
      stage: 'New',
      source: source || 'web_form',
      notes: message || null,
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
  if (location.lifecycle_status === 'active') {
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
  }
  matchedOn: string
  location: { id: string; name: string; location_id: string; lifecycle_status: string | null }
  submission: {
    email: string
    phone?: string | null
    address?: string | null
    city?: string | null
    state?: string | null
    zip?: string | null
    project_type?: string | null
    message?: string | null
  }
  now: string
}): Promise<NextResponse> {
  const { matched, matchedOn, location, submission, now } = args
  const warnings: string[] = []

  const incoming: Record<string, string | null> = {
    email: submission.email.trim(),
    phone: submission.phone || null,
    address: submission.address || null,
    city: submission.city || null,
    state: submission.state || null,
    zip: submission.zip || null,
    project_type: submission.project_type || null,
  }
  const fills: Record<string, unknown> = {}
  for (const key of Object.keys(incoming)) {
    if (!isEmptyField(incoming[key]) && isEmptyField((matched as any)[key])) {
      fills[key] = incoming[key]
    }
  }

  if (Object.keys(fills).length > 0) {
    fills.updated_at = now
    const { error: updErr } = await supabaseService
      .from('leads')
      .update(fills)
      .eq('id', matched.id)
    if (updErr) {
      console.error('[intake] merge fill update failed', updErr)
      warnings.push(`merge_update_failed: ${updErr.message}`)
    }
  }

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
  if (location.lifecycle_status === 'active') {
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
    ...(warnings.length ? { warnings } : {}),
  })
}
