// lib/enquiry-resubmission.ts
//
// A RETURNING PERSON'S NEW ENQUIRY, ATTACHED TO THEIR EXISTING RECORD.
//
// Moved out of app/api/leads/intake/route.ts (22 Oct 2026) so a second door
// can run exactly the same attach. Two doors, one rule:
//   · intake — the website form matched an existing lead at the routed
//     location (SOLID tier: exact email or phone_normalized, one lead).
//   · transfer (lib/lead-transfer.ts) — an enquiry that landed in Other, or
//     at the wrong location, is moved to a location where the same person is
//     already a client. Until this module existed the move made a second
//     record there (Shirley Ann Morgan, Central Denver, 13 Oct).
//
// What it does is unchanged from intake: NO new row. Fill the matched lead's
// empty contact fields (never overwrite good data), surface onto an open
// engagement or found one for a past client, log a "Webform resubmission"
// touchpoint, enroll the drip only if this lead never had a progress row,
// and notify the location as a returning client.
//
// Callers own their own logging and response: intake writes its LEAD_INTAKE
// sync_log row and its JSON; the transfer returns its own body. The result
// object below carries everything both of them report.

import { supabaseService } from '@/lib/supabase-service'
import { startDripForLead } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'
import { notifyNewLead } from '@/lib/lead-notification-email'
import { assignIncomingLead, getLeadAssigneeIds } from '@/lib/lead-assignment'
import { notifyNewLeadSlack } from '@/lib/slack-bot'
import { logSlackNotification } from '@/lib/notification-log'
import { findOpenEngagementForClient, foundManualEngagement } from '@/lib/engagements'
import { recordPhoneNote } from '@/lib/phone-note'

// phone_normalized is generated — it must never appear in the payload;
// filling raw `phone` makes Postgres recompute it.
const isEmptyField = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

export type ResubmissionArgs = {
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
  // The name the returning client typed on the resubmission (freshest spelling);
  // what the #86 resubmission notification is addressed with.
  submittedName: string
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
  source: string | null
  baseWarnings: string[]
  now: string
  // Request origin for the notification deep-link (#86). Null degrades to a
  // button-less email / link-less Slack card, exactly like the create path.
  reqOrigin: string | null
  // The original phone field when phoneForWrite kept only its first number
  // (see intake POST). Noted on the lead only if this merge fills its phone.
  phoneNote: string | null
  // How the enquiry reached this record, when it was not straight off the
  // form — written on the touchpoint so the timeline says so.
  via?: string | null
}

export type ResubmissionResult = {
  engagementId: string | null
  engagementFounded: boolean
  foundingSkipped: string | null
  returningDrip: string
  dripEnrolled: boolean
  dripSkippedReason: string | null
  assignedCount: number
  assignmentBasis: string | null
  notifiedCount: number
  notificationsMuted: boolean
  warnings: string[]
}

export async function attachResubmission(args: ResubmissionArgs): Promise<ResubmissionResult> {
  const { matched, matchedOn, location, submittedName, submission, source, now, reqOrigin } = args
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
    } else if (fills.phone && args.phoneNote) {
      const noted = await recordPhoneNote({ leadId: matched.id, locationUuid: location.id, original: args.phoneNote, kept: String(fills.phone) })
      if (!noted.ok) warnings.push(`phone_note_failed: ${noted.error}`)
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

  // ─── #94: found or update a visibly-returning engagement ──────
  // The resubmission is actionable work, not just a notification. If the client
  // has an OPEN engagement, surface the new request onto it — never a second
  // card (David's same-apartment case: two submissions, one job). If none is
  // open, found a fresh manual engagement at Request (Samantha's genuine next
  // job: her prior engagement is Closed Won = terminal = not open, so a new
  // card is correct). "Open" is the one shared predicate everywhere — stage not
  // in the two terminals — via findOpenEngagementForClient, the same resolver
  // #67's SR path uses.
  //
  // The lead's own stage is deliberately left UNTOUCHED. leads.stage is not a
  // rollup of engagement state and founding never writes it; Nurturing and Won
  // are both drip-STOP stages, so only an explicit write to 'New' could re-
  // enroll a past customer in a nurture drip — which we never do. The
  // directory's client-status chip flips to Active on its own (it is derived
  // from the presence of an open engagement, not stored).
  //
  // NON-FATAL: the merge already committed; a founding failure only warns.
  //
  // ─── Fresh-lead guard (3 Sept 2026) ───
  // Founding is for a PAST client's genuine next job. A brand-new website lead
  // whose form arrives twice (three prod cases were 1½–3 minutes apart, one a
  // day later) is not a past client: founding gave them a Request engagement,
  // the engagement made them derive Active, and Active is outside the Inbox,
  // the badge and the Home tile — six uncalled leads vanished from every
  // worklist. So a resubmission founds ONLY when the client is a past client,
  // by the same test the returning-client sequence already applies
  // (isPastClient: Jobber-imported, paid history, or a Closed WON on record —
  // a Closed Lost alone, e.g. the 35-day auto-close, does not count). A fresh
  // lead's second form merges, notifies and leaves its touchpoint at lead
  // level, and the lead stays New/Attempting exactly as after the first form.
  // The answer is computed once here and reused by the sequence below.
  // If the check itself fails, founding is SKIPPED (fail toward visibility —
  // a hidden lead is worse than a past client without a card) and the reason
  // rides the warnings + log line.
  let engagementId: string | null = null
  let engagementFounded = false
  let foundingSkipped: string | null = null
  try {
    const open = await findOpenEngagementForClient(matched.id)
    if (open) {
      engagementId = open.id
    } else {
      let pastClient = false
      let checkFailed = false
      try {
        const { isPastClient } = await import('@/lib/drip-lifecycle')
        pastClient = await isPastClient(matched.id)
      } catch (err: any) {
        checkFailed = true
        console.error('[intake] resubmission past-client check failed; not founding', err)
        warnings.push(`past_client_check_failed: ${err?.message || String(err)}`)
      }
      if (!pastClient) {
        foundingSkipped = checkFailed ? 'past_client_check_failed' : 'not_past_client'
      } else {
        // The blank rule (2026-09-28): the card says what it is. The title
        // names where it came from; the form's own message is what they
        // said, when they wrote one.
        const founded = await foundManualEngagement({
          clientId: matched.id,
          title: 'Website enquiry',
          description: submission.message?.trim() || null,
          note: `founded from webform resubmission (matched on ${matchedOn})`,
        })
        if ('engagement' in founded) {
          engagementId = founded.engagement.id
          engagementFounded = true
        } else {
          warnings.push(`engagement_found_failed: ${founded.error}`)
        }
      }
    }
  } catch (err: any) {
    console.error('[intake] resubmission engagement found/surface failed', err)
    warnings.push(`engagement_found_failed: ${err?.message || String(err)}`)
  }

  // ─── Returning-client sequence ─────────────────────────────────
  // A PAST client's fresh enquiry gets its own short sequence (path_key
  // returning-a..d, the variant following the location's two Settings
  // answers), enrolled here and only here. The founding above already
  // proved all three shape conditions — no other open engagement (else the
  // request was surfaced onto it and nothing was founded), the enquiry sits
  // at Request, and the client IS a past client (the fresh-lead guard asked
  // isPastClient before founding; a fresh lead's second form founds nothing
  // and reads skipped:not_past_client here, exactly as before the guard). So
  // engagementFounded alone is the gate, and the set of people enrolled is
  // unchanged. The sequence bypasses the import pause on purpose (see
  // enrolReturningSequence). Non-fatal: the merge, the founding and the
  // notifications already stand; the token on the log line says what
  // happened. Dynamic import keeps this route's module graph unchanged.
  let returningDrip = foundingSkipped === 'not_past_client' ? 'skipped:not_past_client' : 'skipped:not_founded'
  if (engagementFounded) {
    try {
      const { enrolReturningSequence } = await import('@/lib/drip-lifecycle')
      {
        const r = await enrolReturningSequence(matched.id, location.id)
        if (r.enrolled) {
          returningDrip = 'enrolled'
          // Step 1 is scheduled for "now" — send it inline like the ordinary
          // drip does, so the client hears back within the minute, not the hour.
          try {
            await sendDripStep(matched.id)
          } catch (err: any) {
            console.error('[intake] returning-sequence inline send threw', err)
            warnings.push(`returning_drip_send_failed: ${err?.message || String(err)}`)
          }
        } else {
          returningDrip = `skipped:${r.reason}`
        }
      }
    } catch (err: any) {
      console.error('[intake] returning-sequence enrol failed', err)
      warnings.push(`returning_drip_failed: ${err?.message || String(err)}`)
    }
  }

  // The resubmission touchpoint is anchored to that engagement (engagement_id),
  // so it lands on the engagement's timeline — the "new request arrived" trace
  // on the returning card (Kevin's option 1). Founded-or-existing both carry it.
  // The label is what lib/enquiry-exit reads as a fresh enquiry date, so a
  // transferred-in enquiry reopens the Inbox exactly like one off the form.
  try {
    const matchedLine = args.via ? `Matched on ${matchedOn} (${args.via}).` : `Matched on ${matchedOn}.`
    const { error: tpErr } = await supabaseService.from('touchpoints').insert({
      lead_id:       matched.id,
      location_uuid: location.id,
      engagement_id: engagementId,
      kind:          'system',
      method:        'system',
      label:         'Webform resubmission',
      notes:         submission.message?.trim()
        ? `${matchedLine} Message: ${submission.message.trim()}`
        : matchedLine,
      status:        'done',
      occurred_at:   now,
      user_id:       null,
    })
    if (tpErr) throw tpErr
  } catch (err: any) {
    console.error('[intake] resubmission touchpoint insert failed', err)
    warnings.push(`touchpoint_insert_failed: ${err?.message || String(err)}`)
  }

  // Surfacing onto an EXISTING engagement bumps its updated_at so the card
  // reads as freshly touched (a founded engagement is already fresh). No
  // transient chip — #86's notification is the signal that something happened.
  if (engagementId && !engagementFounded) {
    const { error: bumpErr } = await supabaseService
      .from('engagements')
      .update({ updated_at: now })
      .eq('id', engagementId)
    if (bumpErr) warnings.push(`engagement_bump_failed: ${bumpErr.message}`)
  }

  // ─── Assignment on merge: FILL-EMPTY, never overwrite ─────────
  // Same rule as the fill loop above, applied to ownership. A resubmission of
  // a lead that already has an assignee must NOT reassign it — that would take
  // work away from whoever picked it up. But a lead that is still blank (any of
  // the 106 that came through this door before assignment existed) gets the
  // rule applied now, which is what "never nobody" means for a returning
  // submission. Non-fatal; the merge has already committed.
  //
  // Reads the junction, not leads.assigned_to: the legacy column carries
  // ~7,129 import blanket-stamps and is not evidence that a human chose anyone.
  let mergeAssignedCount = 0
  let mergeAssignmentBasis: string | null = null
  try {
    const existing = await getLeadAssigneeIds(matched.id)
    if (existing.length === 0) {
      // The project type the lead has AFTER the merge fills.
      const effectiveProjectType =
        (matched.project_type || '').trim() ||
        (!fillUpdateFailed && typeof fills.project_type === 'string' ? fills.project_type : '') ||
        null
      const assignment = await assignIncomingLead({
        leadId: matched.id,
        locationUuid: location.id,
        projectType: effectiveProjectType,
      })
      mergeAssignedCount = assignment.hubUserIds.length
      mergeAssignmentBasis = assignment.basis
      warnings.push(...assignment.warnings)
    } else {
      mergeAssignedCount = existing.length
      mergeAssignmentBasis = 'existing'
    }
  } catch (err: any) {
    console.error('[intake] merge assignIncomingLead threw', err)
    warnings.push(`assignment_failed: ${err?.message || String(err)}`)
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

  // ─── Resubmission notification (#86) ──────────────────────────
  // THE fix for #86: a returning client who re-submitted the website form must
  // be notified, using the SAME path as a new lead — notifyNewLead (email) + the
  // Slack rail — with resubmission:true so the copy reads "returning client" and
  // the rows log under the resubmission email_kind. Everything else is inherited
  // by construction from notifyNewLead / notifyNewLeadSlack: the notifications_live
  // gate, the #91 hub/non-hub email branch, global CC on a visible CC, and the
  // recipient dedupe. Deliberately NOT a stage change — moving a Nurturing client
  // has drip/engagement knock-ons Kevin decides separately (#86).
  //
  // The notification carries what they JUST submitted: the freshest name, the new
  // message (submission.message → request_details), and the contact fields on
  // record after the fill (submitted value, else what the matched lead already
  // had). Non-fatal end to end, exactly like the create path — the merge has
  // already committed and a send failure must never flip it. The touchpoint above
  // is untouched: the existing dedupe behavior is preserved.
  const notifyLead = {
    id: matched.id,
    name: submittedName,
    email: submission.email || matched.email || null,
    phone: submission.phone || matched.phone || null,
    project_type: submission.project_type || matched.project_type || null,
    // The new request is the point of the alert — the message they just sent,
    // NOT the older stored request_details.
    request_details: submission.message?.trim() || null,
    preferred_contact: submission.preferred_contact || matched.preferred_contact || null,
    // Address on record after the fill: the submitted value, else what the
    // matched lead already had — same submitted-else-stored rule as the contact
    // fields above. formatLeadAddressLabeled de-dupes a full-joined `address`
    // column (an imported client the resubmission matched) so the row never
    // double-renders the parts. Feeds BOTH the email and the Slack card below.
    address: submission.address || matched.address || null,
    city: submission.city || matched.city || null,
    state: submission.state || matched.state || null,
    zip: submission.zip || matched.zip || null,
  }

  let notifiedCount = 0
  let notificationsMuted = false
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || reqOrigin || null
    const notify = await notifyNewLead({
      location: { id: location.id, name: location.name },
      locationSlug: location.location_id,
      baseUrl,
      resubmission: true,
      lead: notifyLead,
    })
    notifiedCount = notify.sent ? notify.recipientCount : 0
    notificationsMuted = notify.muted === true
    if (notify.error) {
      warnings.push(`lead_notification_failed: ${notify.error}`)
    }
  } catch (err: any) {
    console.error('[intake] resubmission notifyNewLead threw', err)
    warnings.push(`lead_notification_failed: ${err?.message || String(err)}`)
  }

  // Slack (ADDITIVE) — same double-wrapped, never-throws contract as the create
  // path. Bee Hub references are fine here: Slack only posts where the office
  // installed the app (the #91 non-hub concern is email-only).
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
      process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
      reqOrigin ||
      null
    const slackRes = await notifyNewLeadSlack({
      locationId: location.id,
      locationName: location.name,
      baseUrl,
      resubmission: true,
      lead: { ...notifyLead, source },
    })
    if (slackRes.error) {
      warnings.push(`slack_notification_failed: ${slackRes.error}`)
    }
    await logSlackNotification(slackRes, {
      lead_id: matched.id,
      lead_name: submittedName,
      location_id: location.id,
      location_slug: location.location_id,
    })
  } catch (err: any) {
    console.error('[intake] resubmission notifyNewLeadSlack threw', err)
    warnings.push(`slack_notification_failed: ${err?.message || String(err)}`)
    await logSlackNotification(
      { ok: false, error: err?.message || String(err) },
      {
        lead_id: matched.id,
        lead_name: submittedName,
        location_id: location.id,
        location_slug: location.location_id,
      },
    )
  }

  return {
    engagementId,
    engagementFounded,
    foundingSkipped,
    returningDrip,
    dripEnrolled,
    dripSkippedReason,
    assignedCount: mergeAssignedCount,
    assignmentBasis: mergeAssignmentBasis,
    notifiedCount,
    notificationsMuted,
    warnings,
  }
}
