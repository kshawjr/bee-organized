// app/api/emails/test-send/route.ts
//
// SEND ME A TEST (Settings → Emails → Read → "Send me a test", 2026-10-30).
// Before this, the only way an owner could see what her clients receive was to
// fill in her own enquiry form.
//
// POST { locationId, stepId }        a drip email (drip_path_steps.id)
// POST { locationId, templateKey }   'welcome' or a stage email key
//   → { ok, to } | { error, message }
//
// WHO IT GOES TO: the signed-in person's own login address, read from the
// session — never from the request. There is no way to point it anywhere else.
//
// WHAT IT IS: the same email a client would get, built by the same pieces the
// real senders use, in the same order —
//   lib/email-send-options  applyEmailSwitches (rates / links off)
//   lib/rate-guard + lib/booking-link  the hold guards
//   lib/resend              renderTemplate, then sendEmail (same From,
//                           reply-to and Resend call as a real send)
//   lib/email-signature-resolve  who signs
//   lib/drip-email-layout   the location's style; the welcome and job
//                           follow-ups through their own render functions
// with the location's real rate, links, phone, reviews link and style. The
// client is the signed-in person ("Hi Kevin"), and they are the assignee, so
// their own signature and booking link are used.
//
// WHAT IT DOES NOT DO: touch any lead. No drip progress, no lead status, no
// touchpoint, no unsubscribe token. Its one write is the notification_log row
// sendEmail always makes, with lead_id null and email_kind 'test' — outside
// every 'drip' query and the failure alerts' kinds.
//
// A COMMERCIAL email (the welcome, the job follow-ups) needs its unsubscribe
// footer; with no client there is no token, so the footer's link points at a
// placeholder address (it does nothing if clicked) — the footer still shows,
// so the owner sees the email as sent.
//
// An email that would be HELD or SKIPPED at this location is not sent; the
// answer says why, in the owner's words.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { renderTemplate, sendEmail, type RenderContext } from '@/lib/resend'
import { blockedOnMissingRate } from '@/lib/rate-guard'
import { blockedOnMissingBookingLink, resolveOwnerBookingLink } from '@/lib/booking-link'
import { applyEmailSwitches, extrasFromRow, locationEmailOptionsFromRow } from '@/lib/email-send-options'
import { buildBrandedDripHtml, buildBrandedDripText, type BrandedEmailContext } from '@/lib/drip-email-layout'
import { hasSignatureTag } from '@/lib/email-signature'
import { resolveEmailSignature } from '@/lib/email-signature-resolve'
import { getPrimaryOwnerForLocation } from '@/lib/owner-resolution'
import { resolveLocationTemplateFork } from '@/lib/template-fork'
import { renderWelcomeEmailContent } from '@/lib/welcome-email'
import { renderStageEmailContent } from '@/lib/stage-emails'
import { buildMarketingFooter } from '@/lib/marketing-consent'

export const runtime = 'nodejs'

const TEST_EMAIL_KIND = 'test'
const COMMERCIAL_TEMPLATE_KEYS = new Set(['welcome', 'opp_closed_job_3mo', 'opp_closed_job_12mo'])

type Source = {
  subject: string | null
  body: string
  buttonText: string | null
  buttonLink: string | null
  alwaysSends: boolean
  render: 'drip' | 'welcome' | 'stage'
  templateKey: string | null
}

function refuse(error: string, message: string, status = 409) {
  return NextResponse.json({ error, message }, { status })
}

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const to = (user.email ?? '').trim()
  if (!to) return refuse('no_login_email', 'Your login has no email address to send the test to.', 400)

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id, full_name, first_name')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }
  const locationId = typeof body.locationId === 'string' ? body.locationId : ''
  if (!locationId) return NextResponse.json({ error: 'location_required' }, { status: 400 })
  if (!isAdmin(hubUser.role) && hubUser.location_id !== locationId) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  const { data: loc } = await supabaseService.from('locations').select('*').eq('id', locationId).maybeSingle()
  if (!loc) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  const options = locationEmailOptionsFromRow(loc as Record<string, unknown>)

  // ── which email ────────────────────────────────────────────────────────
  let source: Source | null = null
  if (typeof body.stepId === 'string' && body.stepId) {
    const { data: step } = await supabaseService
      .from('drip_path_steps')
      .select('*, templates:master_template_id ( subject, body ), drip_paths!inner ( id, location_uuid, is_master )')
      .eq('id', body.stepId)
      .maybeSingle()
    const path = step ? (Array.isArray((step as any).drip_paths) ? (step as any).drip_paths[0] : (step as any).drip_paths) : null
    // The location's own copy, or a corporate master it is still using.
    if (!step || !path || !(path.is_master || path.location_uuid === locationId)) {
      return NextResponse.json({ error: 'email_not_found' }, { status: 404 })
    }
    const tpl = (Array.isArray((step as any).templates) ? (step as any).templates[0] : (step as any).templates) as { subject: string | null; body: string } | null
    const extras = extrasFromRow(step as Record<string, unknown>)
    source = {
      subject: (step as any).subject ?? tpl?.subject ?? null,
      body: (step as any).body ?? tpl?.body ?? '',
      buttonText: extras.buttonText,
      buttonLink: extras.buttonLink,
      alwaysSends: (step as any).step_order <= 1,
      render: 'drip',
      templateKey: null,
    }
  } else if (typeof body.templateKey === 'string' && body.templateKey) {
    const key = body.templateKey
    const { data: master } = await supabaseService
      .from('templates')
      .select('*')
      .eq('legacy_id', key)
      .is('location_uuid', null)
      .maybeSingle()
    if (!master) return NextResponse.json({ error: 'email_not_found' }, { status: 404 })
    const fork = await resolveLocationTemplateFork((master as any).id, locationId)
    const extras = extrasFromRow((fork ?? master) as Record<string, unknown>)
    source = {
      subject: fork?.subject ?? (master as any).subject ?? null,
      body: fork?.body ?? (master as any).body ?? '',
      buttonText: extras.buttonText,
      buttonLink: extras.buttonLink,
      alwaysSends: key === 'welcome',
      render: key === 'welcome' ? 'welcome' : 'stage',
      templateKey: key,
    }
  }
  if (!source) return NextResponse.json({ error: 'email_required' }, { status: 400 })

  // ── the owner's switches (same rule as the real senders) ───────────────
  const switched = applyEmailSwitches({
    alwaysSends: source.alwaysSends,
    options,
    subject: source.subject,
    body: source.body,
    buttonLink: source.buttonLink,
  })
  if (switched.action === 'skip') {
    return refuse('skipped', switched.reason === 'rate_not_shown'
      ? 'This email is skipped at your location because you don’t show an hourly rate, so no client gets it.'
      : 'This email is skipped at your location because clients don’t book through a link, so no client gets it.')
  }
  const guardBody = switched.buttonLink ? `${switched.body}\n${switched.buttonLink}` : switched.body

  // ── who it's from, who signs, what the links resolve to ────────────────
  const owner = await getPrimaryOwnerForLocation(locationId)
  const ownerBookingLink = await resolveOwnerBookingLink({
    assignedToUserId: hubUser.id,
    locationOwnerUserId: owner?.id ?? null,
    locationCalendarLink: (loc as any).calendar_link,
  })

  if (blockedOnMissingRate({ subject: switched.subject, body: guardBody }, (loc as any).rate_per_hour)) {
    return refuse('held', 'This email is waiting on your hourly rate, so no client gets it yet. Add it under Your details.')
  }
  if (blockedOnMissingBookingLink({ subject: switched.subject, body: guardBody }, {
    ownerBookingLink,
    locationCalendarLink: (loc as any).calendar_link,
    discoveryBookingLink: options.discoveryBookingLink,
    virtualBookingLink: options.virtualBookingLink,
  })) {
    return refuse('held', 'This email is waiting on a booking link, so no client gets it yet. Add it under Your details.')
  }

  const fullName = (hubUser.full_name ?? '').trim()
  const firstName = (hubUser.first_name ?? '').trim() || fullName.split(/\s+/)[0] || null
  const l = loc as any
  const ctx: RenderContext = {
    first_name: firstName,
    organizer_name: l.sender_name,
    location_name: l.name,
    phone: l.phone ?? owner?.phone ?? null,
    booking_link: l.calendar_link,
    service_area: l.city && l.state ? `${l.city}, ${l.state}` : l.city || l.state || null,
    owner_name: fullName || owner?.full_name || null,
    owner_first_name: firstName,
    owner_booking_link: ownerBookingLink,
    location_owner_name: owner?.full_name ?? null,
    rate_per_hour: l.rate_per_hour,
    location_phone: l.phone,
    book_assessment_link: l.calendar_link,
    reviews_link: l.reviews_link,
    discovery_booking_link: options.discoveryBookingLink,
    virtual_booking_link: options.virtualBookingLink,
  }

  const rendered = renderTemplate({ subject: switched.subject, body: switched.body }, ctx, { signatureMarker: true })
  if (!rendered.subject.trim()) {
    return refuse('held', 'This email has no subject, so no client gets it yet. Add one with Edit.')
  }
  const renderedButton = source.buttonText && switched.buttonLink
    ? renderTemplate({ subject: source.buttonText, body: switched.buttonLink }, ctx)
    : null
  const signature = hasSignatureTag(switched.body)
    ? await resolveEmailSignature({ locationId, locationName: l.name, assigneeUserId: hubUser.id })
    : null

  const brandCtx: BrandedEmailContext = {
    location_name: l.name,
    location_phone: l.phone,
    reviews_link: l.reviews_link,
    signature,
    style: options.style,
    heading: rendered.subject,
    button: renderedButton ? { label: renderedButton.subject, href: renderedButton.body } : null,
  }

  let html: string
  let text: string
  if (source.render === 'drip') {
    html = buildBrandedDripHtml(rendered.body, brandCtx)
    text = buildBrandedDripText(rendered.body, brandCtx)
  } else {
    const commercial = COMMERCIAL_TEMPLATE_KEYS.has(source.templateKey ?? '')
    const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, '')
    const footer = commercial
      ? buildMarketingFooter({
          unsubscribeUrl: `${base}/unsubscribe/test-email`,
          postalAddress: (process.env.MARKETING_POSTAL_ADDRESS || '').trim() || '(your postal address)',
          audience: source.render === 'welcome' ? 'inquiry' : 'client',
        })
      : null
    const out = source.render === 'welcome'
      ? renderWelcomeEmailContent(rendered.body, brandCtx, footer)
      : renderStageEmailContent(source.templateKey ?? '', rendered.body, brandCtx, footer)
    html = out.html
    text = out.text
  }

  const result = await sendEmail({
    locationId,
    to,
    subject: `[Test] ${rendered.subject}`,
    html,
    text,
    email_kind: TEST_EMAIL_KIND,
  })
  if (!result.success) {
    return NextResponse.json({ error: 'send_failed', message: result.error ?? 'The test could not be sent.' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, to })
}
