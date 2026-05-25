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

const resend = new Resend(process.env.RESEND_API_KEY)

type SendSuccess = { success: true; id: string }
type SendFailure = { success: false; error: string }
export type SendResult = SendSuccess | SendFailure

interface SendEmailArgs {
  locationId: string
  to: string | string[]
  subject: string
  html: string
  text?: string
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
  const { locationId, to, subject, html, text } = args

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

  return sendEmailDirect({
    from: send_from_email,
    fromName: sender_name,
    replyTo: reply_to_email,
    to,
    subject,
    html,
    text,
  })
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
    const { data, error } = await resend.emails.send({
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
