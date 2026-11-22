// app/api/emails/test-send-partner/route.ts
//
// SEND ME A TEST, for a PARTNER email (Settings → Emails → Partner emails →
// Read → "Send me a test"). Partner emails, slice 3 (2026-11-22).
//
// POST { locationId, stepId }   a step of a partner sequence (a master, or this
//                               location's own copy of one)
//   → { ok, to } | { error, message }
//
// WHO IT GOES TO: the signed-in person's own login address, read from the
// session — never from the request — exactly like the client test send
// (app/api/emails/test-send, left as it was). Nothing here reads, or can
// reach, any partner's email address: the partner is a made-up sample.
//
// WHAT IT IS: the email a partner would get, built by the same pieces —
//   lib/partner-merge-tags   partnerRenderContext: the partner tags only, the
//                            sample partner "Taylor", location_owner_name from
//                            the location's primary owner
//   lib/resend               renderTemplate, then sendEmail (same From,
//                            reply-to and Resend call as a real send)
//   lib/email-signature-resolve   who signs, with NO assignee (a partner has
//                            none): the location's primary owner, else the
//                            location
//   lib/drip-email-layout    the location's style
//   lib/network/partner-footer   the unsubscribe footer — ALWAYS, with the
//                            company-wide MARKETING_POSTAL_ADDRESS
//
// THE UNSUBSCRIBE LINK in a test points at /unsubscribe/test-email: no one's
// key, so it opens "This link is no longer active" and records nothing. No
// partner_unsubscribe_links row is made, and no partner row is read or written.
// Its one write is the notification_log row sendEmail always makes (lead_id
// null, email_kind 'test').
//
// An email that would be HELD (no subject, a rate tag with no rate saved) is
// not sent; the answer says why.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { renderTemplate, sendEmail } from '@/lib/resend'
import { blockedOnMissingRate } from '@/lib/rate-guard'
import { extrasFromRow, locationEmailOptionsFromRow } from '@/lib/email-send-options'
import { bodyFormatOf } from '@/lib/email-body-html'
import { buildBrandedDripHtml, buildBrandedDripText, type BrandedEmailContext } from '@/lib/drip-email-layout'
import { hasSignatureTag } from '@/lib/email-signature'
import { resolveEmailSignature } from '@/lib/email-signature-resolve'
import { getPrimaryOwnerForLocation } from '@/lib/owner-resolution'
import { partnerRenderContext } from '@/lib/partner-merge-tags'
import { isPartnerPathKey } from '@/lib/partner-sequences'
import { buildPartnerFooter, TEST_UNSUBSCRIBE_PATH, TEST_SAMPLE_PARTNER } from '@/lib/network/partner-footer'

export const runtime = 'nodejs'

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
    .select('id, role, location_id')
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
  const stepId = typeof body.stepId === 'string' ? body.stepId : ''
  if (!locationId) return NextResponse.json({ error: 'location_required' }, { status: 400 })
  if (!stepId) return NextResponse.json({ error: 'email_required' }, { status: 400 })
  if (!isAdmin(hubUser.role) && hubUser.location_id !== locationId) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  const { data: loc } = await supabaseService.from('locations').select('*').eq('id', locationId).maybeSingle()
  if (!loc) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  const options = locationEmailOptionsFromRow(loc as Record<string, unknown>)

  const { data: step } = await supabaseService
    .from('drip_path_steps')
    .select('*, drip_paths!inner ( id, location_uuid, is_master, path_key )')
    .eq('id', stepId)
    .maybeSingle()
  const path = step ? (Array.isArray((step as any).drip_paths) ? (step as any).drip_paths[0] : (step as any).drip_paths) : null
  // A PARTNER sequence only — the location's own copy, or a master.
  if (!step || !path || !isPartnerPathKey(path.path_key) || !(path.is_master || path.location_uuid === locationId)) {
    return NextResponse.json({ error: 'email_not_found' }, { status: 404 })
  }
  const s = step as any
  const extras = extrasFromRow(s as Record<string, unknown>)
  const subject: string | null = s.subject ?? null
  const text0: string = s.body ?? ''
  const bodyFormat = bodyFormatOf(s as Record<string, unknown>)
  const guardBody = extras.buttonLink ? `${text0}\n${extras.buttonLink}` : text0

  const l = loc as any
  if (blockedOnMissingRate({ subject, body: guardBody }, l.rate_per_hour)) {
    return refuse('held', 'This email is waiting on your hourly rate, so no partner gets it yet. Add it under Your details.')
  }

  const owner = await getPrimaryOwnerForLocation(locationId)
  const ctx = partnerRenderContext({
    partner: TEST_SAMPLE_PARTNER,
    location: { name: l.name, phone: l.phone, city: l.city, state: l.state, rate_per_hour: l.rate_per_hour, reviews_link: l.reviews_link },
    locationOwnerName: owner?.full_name ?? null,
  })
  const rendered = renderTemplate({ subject, body: text0 }, ctx, { signatureMarker: true, bodyFormat })
  if (!rendered.subject.trim()) {
    return refuse('held', 'This email has no subject, so no partner gets it yet. Add one with Edit.')
  }
  const renderedButton = extras.buttonText && extras.buttonLink
    ? renderTemplate({ subject: extras.buttonText, body: extras.buttonLink }, ctx)
    : null
  // No assignee: a partner has no assigned person.
  const signature = hasSignatureTag(text0)
    ? await resolveEmailSignature({ locationId, locationName: l.name, assigneeUserId: null })
    : null

  const brandCtx: BrandedEmailContext = {
    location_name: l.name,
    location_phone: l.phone,
    reviews_link: l.reviews_link,
    signature,
    style: options.style,
    heading: rendered.subject,
    button: renderedButton ? { label: renderedButton.subject, href: renderedButton.body, align: extras.buttonAlign } : null,
    bodyFormat,
  }
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, '')
  const footer = buildPartnerFooter({
    unsubscribeUrl: `${base}${TEST_UNSUBSCRIBE_PATH}`,
    postalAddress: (process.env.MARKETING_POSTAL_ADDRESS || '').trim() || '(your postal address)',
  })

  const result = await sendEmail({
    locationId,
    to,
    subject: `[Test] ${rendered.subject}`,
    html: buildBrandedDripHtml(rendered.body, brandCtx, footer),
    text: buildBrandedDripText(rendered.body, brandCtx, footer),
    email_kind: 'test',
  })
  if (!result.success) {
    return NextResponse.json({ error: 'send_failed', message: result.error ?? 'The test could not be sent.' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, to })
}
