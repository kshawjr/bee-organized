// lib/network/partner-email.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 3 fixes (2026-11-22) — THE ONE PATH that turns a
// partner email's rendered body into the finished email: body + signature +
// the location's layout + the CAN-SPAM unsubscribe footer. Pure.
//
// Used by every place a partner email is shown or sent: the editor's Preview
// and the Read window (components/settings/EmailsScreen.jsx previewEmailHtml),
// "Send me a test" (app/api/emails/test-send-partner), and slice 4's real
// send. None of them builds the layout or the footer itself, so none can
// forget the footer: there is no way to call this without one.
// ─────────────────────────────────────────────────────────────

import { buildBrandedDripHtml, buildBrandedDripText, type BrandedEmailContext } from '@/lib/drip-email-layout'
import { buildPartnerFooter } from './partner-footer'

export function buildPartnerEmail(args: {
  /** The body with its tags already filled in (and the signature marker where {{signature}} was). */
  renderedBody: string
  /** The layout context: location, style, heading, button, signature, body format. */
  brand: BrandedEmailContext
  /** Where the unsubscribe link goes (a real partner key, or the test/preview placeholder). */
  unsubscribeUrl: string
  /** MARKETING_POSTAL_ADDRESS — the company-wide postal address. */
  postalAddress: string | null
}): { html: string; text: string } {
  const footer = { footer: buildPartnerFooter({ unsubscribeUrl: args.unsubscribeUrl, postalAddress: args.postalAddress }) }
  return {
    html: buildBrandedDripHtml(args.renderedBody, args.brand, footer),
    text: buildBrandedDripText(args.renderedBody, args.brand, footer),
  }
}

// A partner email's button may only be None or Custom (Kevin, 2026-11-22): the
// booking links are a client's (book a job, a call, a video assessment). The
// editor offers only those two; this is the send side's check, so a step that
// somehow carries a booking-link button is held, never sent with a button
// whose link a partner email has no value for.
export const CLIENT_BOOKING_LINK_TAGS = ['{{discovery_booking_link}}', '{{book_assessment_link}}', '{{booking_link}}', '{{virtual_booking_link}}', '{{owner_booking_link}}']
export function partnerButtonIsClientBooking(buttonLink: string | null | undefined): boolean {
  const l = String(buttonLink ?? '')
  return CLIENT_BOOKING_LINK_TAGS.some(t => l.includes(t))
}
