// lib/resend.ts
// Email sending via Resend.
//
// sendEmail() looks up the location's send_from_email/sender_name/reply_to_email
// from the DB and sends as that location. Used by drip emails — anything that
// represents the franchise corresponding with their own customers.
//
// sendEmailDirect() is for callers that already have sender details and don't
// want a DB lookup: system emails (invitations, password resets), and any
// case where the location's sender config isn't yet populated (e.g., owner
// invites going out before the owner has onboarded).

import { Resend } from 'resend'
import { supabaseService } from './supabase-service'
import { logNotificationFanout, type NotificationContext } from './notification-log'
import { resolveHandlerForRawType } from './project-type-handlers'

let _resend: import('resend').Resend | null = null
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

type SendSuccess = { success: true; id: string }
// errorName / errorStatus carry Resend's structured classification up to
// callers that must decide whether a failure is worth retrying — the drip
// engine keys terminal-vs-transient off errorName (lib/drip-send.ts). They are
// only populated when Resend itself returned a typed error object; a malformed
// send caught before Resend, or a thrown network error, leaves them undefined
// (treated as transient). `error` (the human message) is unchanged.
type SendFailure = {
  success: false
  error: string
  errorName?: string | null
  errorStatus?: number | null
}
export type SendResult = SendSuccess | SendFailure

interface SendEmailArgs extends NotificationContext {
  locationId: string
  to: string | string[]
  subject: string
  html: string
  text?: string
  // Per-project-type sender routing. When set, the send resolves the location's
  // assigned sender for this project type (locations.split_senders_enabled +
  // location_project_type_senders) and sends AS that identity, falling back to
  // the base sender when the split is off, the type is unassigned, or the table
  // isn't present yet. Omitted → base sender (unchanged; B2 notifications,
  // welcome, and stage emails never pass this).
  senderProjectType?: string | null
}

// Context is OPTIONAL and purely descriptive — it colors the notification_log
// row and changes nothing about the send. Callers that have lead/location on
// hand (the notification rails) pass it; system mail omits it and those columns
// land null. Every pre-existing call site keeps compiling untouched.
interface SendEmailDirectArgs extends NotificationContext {
  from: string
  fromName: string
  replyTo: string
  to: string | string[]
  // Blind-carbon recipients. A general-purpose rail (no current caller after
  // the lead-notification global CC moved to a visible cc — see below). Logged
  // exactly like To recipients — one notification_log row per address, sharing
  // the message id — because a BCC'd address received the email just as really
  // as an addressed one.
  bcc?: string[]
  // Visible carbon-copy recipients. Used by the lead-notification global CC
  // list so corporate oversight addresses appear ON each recipient's copy —
  // everyone can see who else received the lead. Logged exactly like To and BCC
  // recipients — one notification_log row per address, sharing the message id.
  cc?: string[]
  subject: string
  html: string
  text?: string
}

// ─── Template variable substitution ──────────────────────────────────
// Replaces {{variable}} placeholders in a subject + body. Missing or
// null/undefined values substitute as empty string so unrendered
// "{{first_name}}" never reaches the recipient.
//
// Variable inventory lives in docs/bee_organized_email_content.md. The
// canonical Bee Hub variable names mirror what the master drip templates
// (seed_master_drip_paths.sql) and standalone master templates (Welcome,
// Opportunity Stages) reference verbatim. Sources:
//
//   first_name           lead.first_name (or first word of lead.name)
//   organizer_name       location.sender_name        (legacy — kept for old templates)
//   location_name        location.name
//   phone                location.phone, fallback owner.phone (legacy)
//   booking_link         location.calendar_link      (legacy alias of book_assessment_link)
//   service_area         "City, State" from location  (legacy)
//   owner_name           lead.assigned_to hub_user.full_name
//   owner_first_name     first word of owner_name
//   owner_booking_link   assignee's booking_link → location owner's → calendar_link
//   location_owner_name  location's owner-role hub_user.full_name
//   rate_per_hour        location.rate_per_hour
//   location_phone       location.phone (no fallback — alias used by new templates)
//   book_assessment_link location.calendar_link (alias used by new templates)
//   reviews_link         location.reviews_link
//   partner_name         (Partner Drip — Phase 2, currently no-op)
export interface RenderContext {
  first_name?: string | null
  organizer_name?: string | null
  location_name?: string | null
  phone?: string | null
  booking_link?: string | null
  service_area?: string | null
  owner_name?: string | null
  owner_first_name?: string | null
  // Per-assignee scheduling link (lib/booking-link). Resolves through
  // assignee → location primary owner → locations.calendar_link, so it is
  // never worse than the location-level aliases below.
  owner_booking_link?: string | null
  location_owner_name?: string | null
  rate_per_hour?: string | null
  location_phone?: string | null
  book_assessment_link?: string | null
  reviews_link?: string | null
  partner_name?: string | null
}

const VAR_RE = /\{\{(\w+)\}\}/g

function applyVars(input: string | null | undefined, ctx: RenderContext): string {
  if (!input) return ''
  return input.replace(VAR_RE, (_match, key: string) => {
    const v = (ctx as Record<string, unknown>)[key]
    if (v === null || v === undefined) return ''
    return String(v)
  })
}

export function renderTemplate(
  template: { subject: string | null; body: string },
  context: RenderContext,
): { subject: string; body: string } {
  return {
    subject: applyVars(template.subject, context),
    body: applyVars(template.body, context),
  }
}

export async function sendEmail(args: SendEmailArgs): Promise<SendResult> {
  const { locationId, to, subject, html, text, senderProjectType } = args
  // Every sendEmail() send is by definition scoped to a location, so the log
  // row gets location_id for free even when the caller passed no context.
  // An explicit args.location_id still wins.
  const context: NotificationContext = {
    lead_id: args.lead_id,
    lead_name: args.lead_name,
    location_id: args.location_id ?? locationId,
    location_slug: args.location_slug,
    email_kind: args.email_kind,
  }

  if (!locationId || !to || !subject || !html) {
    const error = 'sendEmail: missing required field (locationId, to, subject, html)'
    console.error(error, { locationId, hasTo: !!to, hasSubject: !!subject, hasHtml: !!html })
    return { success: false, error }
  }

  const { data: location, error: lookupError } = await supabaseService
    .from('locations')
    .select('send_from_email, sender_name, reply_to_email')
    .eq('id', locationId)
    .single()

  if (lookupError || !location) {
    const error = `sendEmail: location ${locationId} not found${lookupError ? `: ${lookupError.message}` : ''}`
    console.error(error)
    return { success: false, error }
  }

  const { send_from_email, sender_name, reply_to_email } = location
  if (!send_from_email || !sender_name || !reply_to_email) {
    const error = `sendEmail: location ${locationId} missing sender config (send_from_email, sender_name, reply_to_email)`
    console.error(error, { send_from_email, sender_name, reply_to_email })
    return { success: false, error }
  }

  // Per-project-type sender routing. The base trio above IS the default sender.
  // When this drip carries a project type AND the location has split enabled +
  // an assignment for that type, send AS that sender; name/reply-to each fall
  // back to base individually. Any miss (split off, unassigned, or the table /
  // flag not present yet) → base sender: a drip NEVER fails to send for want of
  // a per-type sender.
  let from = send_from_email
  let fromName = sender_name
  let replyTo = reply_to_email
  if (senderProjectType) {
    const override = await resolveProjectTypeSenderOverride(locationId, senderProjectType)
    if (override?.sender_email) {
      from = override.sender_email
      fromName = override.sender_name ?? sender_name
      replyTo = override.sender_reply_to ?? reply_to_email
    }
  }

  return sendEmailDirect({
    from,
    fromName,
    replyTo,
    to,
    subject,
    html,
    text,
    ...context,
  })
}

// Resolve what a location's project type SENDS AS.
//
// issue 296 — "as them" is no longer the only answer. A handler row carries an
// identity that is either the handler's own (the default) or a hand-typed name
// and address such as a shared mailbox, with its own reply-to. This resolver
// does not care which: it reads the identity the row holds. The one thing that
// changed here is what survives an offboarding — a typed identity outlives its
// handler, so lib/project-type-handlers.ts keeps that row and nulls only the
// assignee. See its header table.
//
// issue 246 step 2 — two changes, both about ending a fusion:
//
//   NO FLAG. This used to short-circuit on locations.split_senders_enabled
//   before looking at the table. That flag is retired: "no handler row for
//   this type" IS the off state, and it says it per type instead of per
//   location. Reading both meant a location could hold handler rows that
//   silently did nothing — which is precisely what loc_kc's four rows did on
//   the assignment side while the notify flag was off.
//
//   ONE MATCHING RULE. This used to do .eq('project_type', projectType) on the
//   RAW value: an exact, case-sensitive SQL comparison, while the assignment
//   path canonicalized case-insensitively with legacy aliases. Same table, same
//   question, two answers — so a lead could be assigned to Carol and still send
//   as the location default. The raw value is now canonicalized to a lookups
//   label first (lib/project-type-vocabulary.ts), and the handler lookup is by
//   that label. The sender and the assignee cannot disagree because they now
//   resolve through the same function.
//
// Still defensive and still never throws: any miss — no handler, unknown type,
// disabled handler, table absent, read error — returns null and the caller
// uses the location's base sender. A drip is NEVER dropped for want of a
// per-type sender. That silence is by design, which is why the routing is
// covered by tests rather than trusted to a code read.
type ProjectTypeSenderOverride = {
  sender_name: string | null
  sender_email: string | null
  sender_reply_to: string | null
}
async function resolveProjectTypeSenderOverride(
  locationId: string,
  projectType: string,
): Promise<ProjectTypeSenderOverride | null> {
  try {
    const handler = await resolveHandlerForRawType(locationId, projectType)
    if (!handler) return null
    return {
      sender_name: handler.name,
      sender_email: handler.email,
      sender_reply_to: handler.reply_to,
    }
  } catch {
    return null
  }
}

export async function sendEmailDirect(args: SendEmailDirectArgs): Promise<SendResult> {
  const { from, fromName, replyTo, to, bcc, cc, subject, html, text } = args

  // THE hook point for the outbound-mail notebook (migrations/
  // notification_log.sql). Logging lives here rather than in any one feature so
  // that invites, magic-links, drips AND lead notifications are all recorded by
  // construction — a future send rail gets logging for free by calling this.
  //
  // Half A records ACCEPTANCE only: 'accepted' means Resend took the message
  // and gave us an id, NOT that it landed in an inbox. Delivery is Half B (the
  // Resend webhook), which fills delivery_status by resend_message_id.
  const context: NotificationContext = {
    lead_id: args.lead_id,
    lead_name: args.lead_name,
    location_id: args.location_id,
    location_slug: args.location_slug,
    email_kind: args.email_kind,
  }
  // The notebook's grain covers EVERYONE the message reaches: To + CC + BCC. A
  // to-only view of a send would under-report it, hiding the global CC rail
  // entirely; a cc/bcc-omitting view would do the same.
  const bccList = (bcc || []).filter(Boolean)
  const ccList = (cc || []).filter(Boolean)
  const recipients = [...(Array.isArray(to) ? to : [to]), ...ccList, ...bccList].filter(Boolean)

  // BELT AND BRACES. logNotification already swallows everything, so this
  // .catch() should be dead code — but the success-path log call below sits
  // INSIDE the try/catch that converts a throw into { success: false }. Without
  // this guard, a writer that somehow rejected would silently downgrade a
  // genuinely sent email to a failure, and the caller would report a send that
  // actually happened as broken. The notebook must never be able to do that.
  // Pinned by lib/notification-log-fire-safety.test.ts.
  const safeLog = (base: Parameters<typeof logNotificationFanout>[1], addrs: (string | null)[] = recipients) =>
    logNotificationFanout(addrs as string[], base).catch(err =>
      console.warn('[notification-log] fanout rejected — send result unaffected:', err),
    )

  if (!from || !fromName || !replyTo || !to || !subject || !html) {
    const error = 'sendEmailDirect: missing required field (from, fromName, replyTo, to, subject, html)'
    console.error(error, {
      hasFrom: !!from,
      hasFromName: !!fromName,
      hasReplyTo: !!replyTo,
      hasTo: !!to,
      hasSubject: !!subject,
      hasHtml: !!html,
    })
    // A malformed send never reached Resend. Log it as failed against whatever
    // recipients we did get; if `to` itself was the missing field there is no
    // address to key on, so one recipient-less row still records the attempt
    // rather than letting it vanish.
    await safeLog(
      {
        ...context,
        channel: 'email',
        subject: subject || null,
        send_status: 'failed',
        error,
      },
      recipients.length ? recipients : [null],
    )
    return { success: false, error }
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: `${fromName} <${from}>`,
      replyTo,
      to,
      ...(ccList.length ? { cc: ccList } : {}),
      ...(bccList.length ? { bcc: bccList } : {}),
      subject,
      html,
      text,
    })

    if (error) {
      console.error('sendEmailDirect: Resend API error', error)
      const message = error.message || 'Resend API error'
      await safeLog({
        ...context,
        channel: 'email',
        subject,
        send_status: 'failed',
        error: message,
      })
      // Surface Resend's typed name + status so retry-aware callers can tell a
      // permanently-rejected message (e.g. name='validation_error' / 422 — an
      // invalid recipient) from a transient one (429 rate limit, 5xx). The
      // human message alone can't be classified reliably.
      return { success: false, error: message, errorName: error.name, errorStatus: error.statusCode }
    }

    if (!data?.id) {
      const msg = 'sendEmailDirect: Resend returned no id'
      console.error(msg, data)
      // No id means nothing for Half B to reconcile against — the row is
      // 'failed' even though Resend didn't report an error.
      await safeLog({
        ...context,
        channel: 'email',
        subject,
        send_status: 'failed',
        error: msg,
      })
      return { success: false, error: msg }
    }

    // ONE row per recipient, all sharing this message id (the notebook's grain
    // — see the migration). resend_message_id is indexed, not unique, precisely
    // so this fan-out is legal.
    await safeLog({
      ...context,
      channel: 'email',
      subject,
      send_status: 'accepted',
      resend_message_id: data.id,
    })
    return { success: true, id: data.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('sendEmailDirect: unexpected error', err)
    await safeLog({
      ...context,
      channel: 'email',
      subject,
      send_status: 'failed',
      error: message,
    })
    return { success: false, error: message }
  }
}
