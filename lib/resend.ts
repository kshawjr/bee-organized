// lib/resend.ts
// Email sending via Resend, with per-location sender resolution.
// sendEmail() looks up the location's send_from_email/sender_name/reply_to_email
// from the DB. sendEmailDirect() is for callers that already have sender details
// (system emails, password resets, etc.).

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
