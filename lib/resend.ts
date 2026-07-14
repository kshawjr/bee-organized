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

let _resend: import('resend').Resend | null = null
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

type SendSuccess = { success: true; id: string }
type SendFailure = { success: false; error: string }
export type SendResult = SendSuccess | SendFailure

interface SendEmailArgs {
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

interface SendEmailDirectArgs {
  from: string
  fromName: string
  replyTo: string
  to: string | string[]
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
  })
}

// Resolve a location's assigned sender for a project type (B-split routing).
// Defensive and forward-compatible: gated on locations.split_senders_enabled,
// then the location_project_type_senders row. If the split is off, the type is
// unassigned, OR the column/table doesn't exist yet (migration not run —
// PostgREST returns a "does not exist" error), we swallow it and return null so
// the caller uses the base sender. Never throws.
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
    // Master toggle first — the common single-sender location short-circuits
    // here without touching the assignments table.
    const { data: loc, error: locErr } = await supabaseService
      .from('locations')
      .select('split_senders_enabled')
      .eq('id', locationId)
      .single()
    if (locErr || loc?.split_senders_enabled !== true) return null

    const { data, error } = await supabaseService
      .from('location_project_type_senders')
      .select('sender_name, sender_email, sender_reply_to')
      .eq('location_id', locationId)
      .eq('project_type', projectType)
      .maybeSingle()
    if (error || !data) return null
    return data as ProjectTypeSenderOverride
  } catch {
    return null
  }
}

export async function sendEmailDirect(args: SendEmailDirectArgs): Promise<SendResult> {
  const { from, fromName, replyTo, to, subject, html, text } = args

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
    return { success: false, error }
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: `${fromName} <${from}>`,
      replyTo,
      to,
      subject,
      html,
      text,
    })

    if (error) {
      console.error('sendEmailDirect: Resend API error', error)
      return { success: false, error: error.message || 'Resend API error' }
    }

    if (!data?.id) {
      const msg = 'sendEmailDirect: Resend returned no id'
      console.error(msg, data)
      return { success: false, error: msg }
    }

    return { success: true, id: data.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('sendEmailDirect: unexpected error', err)
    return { success: false, error: message }
  }
}
