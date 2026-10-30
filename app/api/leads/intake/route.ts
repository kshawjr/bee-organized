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
import { applyDripSideEffects } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'
import { notifyNewLead } from '@/lib/lead-notification-email'
import { assignIncomingLead } from '@/lib/lead-assignment'
import { notifyNewLeadSlack } from '@/lib/slack-bot'
import { logSlackNotification } from '@/lib/notification-log'
import {
  queryLeadMatches,
  classifyLeadMatches,
} from '@/components/hive/shared/clientMatch'
import { attachResubmission, type ResubmissionArgs } from '@/lib/enquiry-resubmission'
import { normalizeLeadSource, DEFAULT_LEAD_SOURCE } from '@/lib/lead-source'
import { routeByZip, zipDecides, routeLogToken, type ZipRouteDecision } from '@/lib/zip-routing'
import { isClosedLocation, OTHER_SLUG } from '@/lib/location-close'
import { phoneForWrite } from '@/lib/phone'
import { recordPhoneNote } from '@/lib/phone-note'

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
    phone: rawPhone,
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

  // Phone in the universal shape, (123) 456-7890 (lib/phone.ts). A field that
  // also held a second number or words keeps the first number here and the
  // whole original as a note on the lead (recordPhoneNote, below).
  const phoneW = phoneForWrite(rawPhone)
  const phone = phoneW.value

  // `message` is the project-details free-text the form collects ("I have a
  // medically complex condition…"). It is the CLIENT-level request record →
  // leads.request_details (what /api/leads POST writes, EditableDesc edits,
  // and engagements/people-mapper read as the description). Trimmed; empty
  // stays null so the merge path never overwrites good data with a blank.
  //
  // ALIASES: `message` is the contract key, but a producer-side key rename
  // must not silently blank every description — accept the obvious aliases
  // in priority order. A non-contract key winning is surfaced on the
  // sync_log row (desc_key=…) so the Make mapping can be fixed; a payload
  // with NO description under any key is flagged no_description=true —
  // legitimate (the form field is optional, ~10% of real submissions skip
  // it) but it must be readable off the Webhooks tab, never invisible.
  const DESC_KEYS = ['message', 'description', 'request_details'] as const
  let requestDetails: string | null = null
  let descKey: (typeof DESC_KEYS)[number] | null = null
  for (const key of DESC_KEYS) {
    const v = (body || {})[key]
    if (typeof v === 'string' && v.trim()) {
      requestDetails = v.trim()
      descKey = key
      break
    }
  }
  if (descKey && descKey !== 'message') {
    console.warn(
      `[intake] description arrived under non-contract key "${descKey}" — update the producer mapping to \`message\``,
    )
  }
  if (!requestDetails) {
    console.warn('[intake] payload has no description under any accepted key (message/description/request_details)')
  }

  // ─── Unknown-key detection ────────────────────────────────────
  // The destructure above names a FIXED set of keys; anything else a
  // producer sends — a Make mapping rename like `zipcode` for `zip` — is
  // silently dropped and the lead lands with that field blank, no signal.
  // Surface the dropped KEY NAMES (never their values) on the sync_log row
  // so the drift is diagnosable straight off the Webhooks tab, exactly like
  // the desc_key=/no_description= presence tokens. This is the one gap the
  // #108 scout found: a Make rename would vanish, which is how the zip field
  // went unnoticed until someone happened to look.
  //
  // KEY NAMES ONLY — a key called `zipcode` is not PII; its VALUE (an email,
  // a phone) is. We join the names and never touch body[k].
  //
  // NOTE: `metadata` is a passthrough object (stored verbatim as
  // leads.metadata), so nested drift INSIDE it is deliberately not inspected
  // — only TOP-LEVEL keys, which is the drift that matters: a renamed
  // top-level form field is what lands nowhere.
  const KNOWN_INTAKE_KEYS = new Set([
    'location_slug', 'full_name', 'email', 'phone', 'address', 'city',
    'state', 'zip', 'project_type', 'message', 'preferred_contact',
    'source', 'metadata',
    // The global form's "Global" | "Local" marker (20 Aug zip-routing plan).
    // Routing does not read it — the ABSENCE of location_slug is what sends a
    // lead down the zip path — but it is a contract key, not drift.
    'form_source',
    // description aliases the DESC_KEYS loop above already accepts.
    'description', 'request_details',
  ])
  const unknownKeys =
    body && typeof body === 'object'
      ? Object.keys(body).filter((k) => !KNOWN_INTAKE_KEYS.has(k))
      : []
  const unknownKeysToken = unknownKeys.length
    ? ` unknown_keys=${unknownKeys.join(',')}`
    : ''

  // leads.source answers "how did the client hear about us" in the admin
  // lead_sources vocabulary. Producers send per-form slugs — normalize
  // here (the ONLY seam every stored value passes through) so the picker
  // and the card share one vocabulary. Unknown values pass through
  // verbatim; see lib/lead-source.ts.
  const leadSource = normalizeLeadSource(source) ?? DEFAULT_LEAD_SOURCE

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
  // Error-row entity_id: NEVER the raw email (PII that lives forever in
  // sync_log). No lead id exists pre-insert, so use the location_slug as the
  // handle where it's known, 'unknown' on the pre-slug path. The diagnostic
  // "did the payload carry an email at all" survives as a presence token on
  // the message (email_present=true even for an unparseable address — that's
  // exactly the signal the email_or_phone path needs). See #110a.
  const emailPresent =
    typeof email === 'string' && email.trim().length > 0
  const emailPresentToken = ` email_present=${emailPresent}`

  // ─── Location: the zip decides ────────────────────────────────
  // THE ZIP WINS (30 Sep 2026, Leslie's ruling — lib/zip-routing.ts): when a
  // lead has a zip, the territory list decides and the location_slug the
  // website sent is ignored. Every non-match — malformed, unmatched,
  // conflicted, not-live, lookup error — lands at loc_other for Leslie.
  // Only a lead with NO zip falls back to the sent location (no zip and no
  // location → loc_other). The sent slug is not read anywhere else below:
  // everything after this block uses the resolved `location`.
  const sentSlug =
    typeof location_slug === 'string' && location_slug.trim() ? location_slug : null
  const errEntity = sentSlug ?? 'unknown'

  if (!full_name || typeof full_name !== 'string' || !full_name.trim()) {
    await logIntake({
      status: 'error', landed: 'na', locationSlug: null,
      entityId: errEntity, detail: `error=full_name required${emailPresentToken}${unknownKeysToken}`,
    })
    return NextResponse.json({ error: 'full_name required' }, { status: 400 })
  }
  if (!validEmail && !hasPhone) {
    await logIntake({
      status: 'error', landed: 'na', locationSlug: null,
      entityId: errEntity, detail: `error=email_or_phone_required${emailPresentToken}${unknownKeysToken}`,
    })
    return NextResponse.json({ error: 'email_or_phone_required' }, { status: 400 })
  }

  const zipRoute: ZipRouteDecision | null = zipDecides(zip, sentSlug) ? await routeByZip(zip) : null
  const routeSlug: string = zipRoute ? zipRoute.slug : sentSlug!
  // Rides on every row from here (success and error): what the zip chose,
  // what the website sent, and whether the zip overruled it.
  let zipRouteLogToken = routeLogToken(zipRoute, sentSlug)

  // Slug lives in locations.location_id (Zoho-style ID, used as slug across repo).
  const lookupLocation = (slug: string) =>
    supabaseService
      .from('locations')
      .select('id, name, location_id, lifecycle_status')
      .eq('location_id', slug)
      .maybeSingle()
  let { data: location, error: locErr } = await lookupLocation(routeSlug)

  // A CLOSED location takes no new leads (lib/location-close). The zip path
  // can't reach one — routing sends anything not active/onboarding to Other —
  // but a lead with NO zip goes where the website says, and the website keeps
  // a closed franchise's page. Send it to Other, and say so on the log row.
  if (!locErr && location && isClosedLocation(location.lifecycle_status)) {
    zipRouteLogToken += ` sent_loc_closed=${location.location_id}`
    ;({ data: location, error: locErr } = await lookupLocation(OTHER_SLUG))
  }

  if (locErr) {
    await logIntake({
      status: 'error', landed: 'na', locationSlug: null,
      entityId: routeSlug,
      detail: `error=location_lookup_failed slug=${routeSlug} — ${locErr.message}${zipRouteLogToken}${unknownKeysToken}`,
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
      entityId: routeSlug,
      detail: `error=location_not_found slug=${routeSlug} — no location with this slug (check the Make location mapping)${zipRouteLogToken}${unknownKeysToken}`,
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
        // The name the returning client just typed on the form — the freshest
        // spelling, and what the resubmission notification is addressed with.
        submittedName: full_name.trim(),
        // message carries the alias-resolved description so a non-contract
        // key still backfills + reaches the resubmission touchpoint note.
        submission: { email: validEmail, phone, address, city, state, zip, project_type, message: requestDetails, preferred_contact },
        source: leadSource,
        baseWarnings: dedupWarnings,
        now,
        // #86 — the resubmission notification builds the same /clients/<id>
        // deep-link the create path does, from the same origin source.
        reqOrigin: req.nextUrl?.origin ?? null,
        // #108 — same unknown-key signal on the merge (success) path: a
        // returning client's resubmission can drift its mapping too.
        unknownKeysToken,
        // Zip routing — how this location was decided, when the form sent none.
        zipRouteLogToken,
        zipRoute,
        phoneNote: phoneW.note,
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
      source: leadSource,
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
      entityId: location.location_id,
      detail: `error=insert_failed — ${insertErr?.message || 'insert returned no row'}${emailPresentToken}${unknownKeysToken}`,
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

  // The phone field held more than one number (or words): the first number
  // is the phone; the whole original is kept as a note on the lead.
  if (phoneW.note && phone) {
    const noted = await recordPhoneNote({ leadId: lead.id, locationUuid: location.id, original: phoneW.note, kept: phone })
    if (!noted.ok) warnings.push(`phone_note_failed: ${noted.error}`)
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

  // ─── Assignment (CREATE path) ─────────────────────────────────
  // Until now this route wrote NO assignment at all — every webform lead
  // landed with assigned_to NULL and no junction row, which is the blank
  // Kevin was seeing (106 leads, 100% of them from this door). Resolve the
  // owner(s) from the location's project-type notification config and write
  // both the lead_assignees junction (plural truth) and leads.assigned_to
  // (first assignee, legacy compat). See lib/lead-assignment.ts for the rule.
  //
  // Non-fatal, like every other side effect here: the lead row is already
  // committed and a lost assignment must never cost us the lead. A missing
  // lead_assignees table (migration not yet applied) degrades to the
  // assigned_to write alone, which still clears the blank.
  let assignedCount = 0
  let assignmentBasis: string | null = null
  try {
    const assignment = await assignIncomingLead({
      leadId: lead.id,
      locationUuid: location.id,
      projectType: project_type || null,
    })
    assignedCount = assignment.hubUserIds.length
    assignmentBasis = assignment.basis
    warnings.push(...assignment.warnings)
    if (assignment.basis === 'none') {
      warnings.push('assignment_no_owner: location has no resolvable owner')
    }
  } catch (err: any) {
    console.error('[intake] assignIncomingLead threw', err)
    warnings.push(`assignment_failed: ${err?.message || String(err)}`)
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
  //
  // GATED on the location's notifications_live flag, but NOT here and NOT via
  // this route's `location` select — which stays exactly as it was, no new
  // columns, for the same reason the Slack block below gives: a not-yet-applied
  // migration must never be able to 500 lead intake. notifyNewLead does its own
  // fail-soft (fail-CLOSED) read. A muted location returns sent:false with no
  // error — the lead still lands, still enrolls in drip, still shows in the
  // Inbox; only the email is suppressed, and the suppression is recorded in
  // notification_log rather than being silent.
  let notifiedCount = 0
  let notificationsMuted = false
  try {
    // Base URL for the "open this lead" deep-link — same pattern the invite
    // emails use: the NEXT_PUBLIC_SITE_URL override (for proxy-fronted deploys)
    // falls back to the request origin so prod / preview / local each build a
    // correct absolute link to /clients/<lead.id>.
    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
      req.nextUrl?.origin ||
      null
    const notify = await notifyNewLead({
      location: { id: location.id, name: location.name },
      // locations.location_id is the SLUG, not the uuid — recorded on the
      // notification_log row so the admin screen reads 'boulder-01', not a uuid.
      locationSlug: location.location_id,
      baseUrl,
      lead: {
        id: lead.id,
        name: full_name.trim(),
        email: validEmail,
        phone: phone || null,
        project_type: project_type || null,
        request_details: requestDetails,
        preferred_contact: preferredContact,
        address: address || null,
        city: city || null,
        state: state || null,
        zip: zip || null,
      },
    })
    notifiedCount = notify.sent ? notify.recipientCount : 0
    notificationsMuted = notify.muted === true
    if (notify.error) {
      warnings.push(`lead_notification_failed: ${notify.error}`)
    }
  } catch (err: any) {
    console.error('[intake] notifyNewLead threw', err)
    warnings.push(`lead_notification_failed: ${err?.message || String(err)}`)
  }

  // ─── New-lead Slack post (ADDITIVE, CREATE path only) ─────────
  // In ADDITION to the email above, post to the location's Slack channel when
  // it has installed the Bee Hub Slack app. Strictly additive + non-blocking:
  // notifyNewLeadSlack never throws, and this block is double-wrapped in
  // try/catch — a Slack failure can NEVER affect the email (already sent), the
  // lead row (already inserted), or the success response (returned regardless).
  // Only on the CREATE path — like the email, a returning client's resubmission
  // (mergeResubmission) must never re-notify.
  //
  // The Slack connection state is NOT read via this route's `location` select
  // (which stays exactly as it was — no new columns) so a not-yet-applied
  // migration can never 500 lead intake. Instead notifyNewLeadSlack does its own
  // fail-soft read of slack_connected/slack_bot_token/slack_channel_id: any read
  // error (incl. missing columns before the migration runs) or a not-connected
  // location returns a quiet skip — exactly like an email location with zero
  // recipients.
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
      process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
      req.nextUrl?.origin ||
      null
    const slackRes = await notifyNewLeadSlack({
      locationId: location.id,
      locationName: location.name,
      baseUrl,
      lead: {
        id: lead.id,
        name: full_name.trim(),
        email: validEmail,
        phone: phone || null,
        project_type: project_type || null,
        request_details: requestDetails,
        preferred_contact: preferredContact,
        source: leadSource,
        address: address || null,
        city: city || null,
        state: state || null,
        zip: zip || null,
      },
    })
    // Only a real send failure warns; a quiet skip (not connected / not yet
    // migrated) carries no error and is silent.
    if (slackRes.error) {
      warnings.push(`slack_notification_failed: ${slackRes.error}`)
    }
    await logSlackNotification(slackRes, {
      lead_id: lead.id,
      lead_name: full_name.trim(),
      location_id: location.id,
      location_slug: location.location_id,
    })
  } catch (err: any) {
    console.error('[intake] notifyNewLeadSlack threw', err)
    warnings.push(`slack_notification_failed: ${err?.message || String(err)}`)
    await logSlackNotification(
      { ok: false, error: err?.message || String(err) },
      {
        lead_id: lead.id,
        lead_name: full_name.trim(),
        location_id: location.id,
        location_slug: location.location_id,
      },
    )
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
      `lead=${lead.id} source=${leadSource} dedup=${dedupTier}` +
      ` drip_enrolled=${dripEnrolled} notified=${notifiedCount}` +
      // Assignment observability. `assigned=0` is the alarm state (rule 5 —
      // never nobody); the basis token says WHICH tier decided it, so a
      // "why did the owner get this?" question is answerable off the row.
      ` assigned=${assignedCount}` +
      (assignmentBasis ? ` assigned_via=${assignmentBasis}` : '') +
      // Description observability: absent-under-any-key is flagged, and a
      // non-contract alias winning names the drifted key. Both tokens are
      // presence-signals — a normal `message` lead carries neither.
      (!requestDetails ? ' no_description=true' : '') +
      (descKey && descKey !== 'message' ? ` desc_key=${descKey}` : '') +
      // Producer-mapping drift: names the top-level keys we received but
      // don't recognize (KEY NAMES ONLY, never values). A clean payload
      // carries no token.
      unknownKeysToken +
      // Zip routing: present only when the form sent no location.
      zipRouteLogToken +
      // Only when muted, so the token's presence is the signal. Without it a
      // muted location reads as `notified=0`, which is indistinguishable from
      // "nobody was subscribed" — the ambiguity this flag has to avoid.
      (notificationsMuted ? ' notifications_muted=true' : '') +
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
    // Zip routing — only when the form sent no location.
    ...(zipRoute ? { zip_route: zipRoute } : {}),
    drip_enrolled: dripEnrolled,
    assigned_count: assignedCount,
    ...(assignmentBasis ? { assigned_via: assignmentBasis } : {}),
    ...(dripSkippedReason ? { drip_skipped_reason: dripSkippedReason } : {}),
    ...(possibleDuplicateIds.length
      ? { possible_duplicate_of: possibleDuplicateIds }
      : {}),
    ...(warnings.length ? { warnings } : {}),
  })
}

// ─── SOLID-tier merge ───────────────────────────────────────────
// The submission is a returning client: NO new leads row. The attach itself
// lives in lib/enquiry-resubmission.ts (attachResubmission) so the transfer
// door runs the same rule; this wrapper keeps intake's own log row and JSON.
async function mergeResubmission(args: Omit<ResubmissionArgs, 'via'> & {
  // #108 — pre-rendered ` unknown_keys=<names>` token (or '' when clean),
  // computed once in POST. KEY NAMES ONLY — never values.
  unknownKeysToken: string
  zipRouteLogToken: string
  zipRoute: ZipRouteDecision | null
}): Promise<NextResponse> {
  const { matched, matchedOn, location, source, unknownKeysToken, zipRouteLogToken, zipRoute } = args
  const submission = args.submission
  const r = await attachResubmission(args)
  const warnings = r.warnings
  const engagementId = r.engagementId
  const engagementFounded = r.engagementFounded
  const foundingSkipped = r.foundingSkipped
  const dripEnrolled = r.dripEnrolled
  const dripSkippedReason = r.dripSkippedReason
  const returningDrip = r.returningDrip
  const mergeAssignedCount = r.assignedCount
  const mergeAssignmentBasis = r.assignmentBasis
  const notifiedCount = r.notifiedCount
  const notificationsMuted = r.notificationsMuted

  await logIntake({
    status: 'success', landed: 'landed', locationSlug: location.location_id,
    entityId: matched.id,
    detail:
      `lead=${matched.id} source=${source} merged (matched on ${matchedOn})` +
      // #94 — resubmissions now produce an engagement: founded a new one, or
      // surfaced onto the client's open one. Absent only if the found/surface
      // failed (a warning carries the reason).
      (engagementId
        ? ` engagement=${engagementFounded ? 'founded' : 'updated'}:${engagementId}`
        // Fresh-lead guard: nothing founded on purpose, and why.
        : foundingSkipped ? ` engagement=skipped:${foundingSkipped}` : '') +
      ` drip_enrolled=${dripEnrolled}` +
      // Returning-client sequence outcome: enrolled | skipped:<reason>.
      ` returning_drip=${returningDrip}` +
      // assigned_via=existing means the merge left a human's choice alone.
      ` assigned=${mergeAssignedCount}` +
      // #86 — resubmissions now notify; surface the count + mute state the same
      // way the create path does so a silent resubmission is visible on the row.
      ` notified=${notifiedCount}` +
      (notificationsMuted ? ' notifications_muted=true' : '') +
      (mergeAssignmentBasis ? ` assigned_via=${mergeAssignmentBasis}` : '') +
      // submission.message is the alias-resolved description (see POST) —
      // same presence-signal as the create path.
      (!submission.message?.trim() ? ' no_description=true' : '') +
      // #108 — producer-mapping drift, key names only (see POST).
      unknownKeysToken +
      zipRouteLogToken +
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
    // Zip routing — only when the form sent no location.
    ...(zipRoute ? { zip_route: zipRoute } : {}),
    drip_enrolled: dripEnrolled,
    assigned_count: mergeAssignedCount,
    // #94 — the engagement the resubmission founded or surfaced onto.
    ...(engagementId
      ? { engagement_id: engagementId, engagement_action: engagementFounded ? 'founded' : 'updated' }
      : foundingSkipped ? { engagement_action: 'skipped', engagement_skipped: foundingSkipped } : {}),
    // #86 — resubmissions notify now; expose the count + mute like the create path.
    notified_count: notifiedCount,
    ...(notificationsMuted ? { notifications_muted: true } : {}),
    ...(mergeAssignmentBasis ? { assigned_via: mergeAssignmentBasis } : {}),
    ...(dripSkippedReason ? { drip_skipped_reason: dripSkippedReason } : {}),
    ...(warnings.length ? { warnings } : {}),
  })
}
