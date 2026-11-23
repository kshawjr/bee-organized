// lib/drip-send-shared.ts
//
// The parts of a sequence send that a CLIENT email (lib/drip-send.ts) and a
// PARTNER email (lib/network/partner-drip-send.ts, partner emails slice 4)
// share. Split out of lib/drip-send.ts on 2026-11-22 so the two senders run
// the SAME code for the same question, instead of a copy that drifts:
//
//   loadSequenceStep        the step and its linked template
//   loadSendLocation        the location row ('*', see below)
//   locationCanSend         the interface-active gate
//   stepContent             subject / body / body shape, step over template
//   guardBodyOf             the text the guards scan (body + button link)
//   renderStepButton        the button's text and link through the tags
//   emailLook               style + heading + button for the layout
//   planNextStep            which step is next, and when it goes
//   classifySendFailure     what a refused send means and whose fix it is
//   isTerminalSendFailure / isLocationSenderDomainFailure /
//   isLocationReplyToFailure  (moved here; lib/drip-send.ts re-exports them)
//
// Nothing here knows WHO the email is to or WHERE progress is tracked: each
// sender keeps its own recipient, its own tracking table and its own writes.
// The client sender's output is pinned byte for byte by
// lib/network/client-drip-send-bytes.test.ts.

import { supabaseService } from './supabase-service'
import { renderTemplate, type RenderContext } from './resend'
import { LOCATION_REPLY_TO_BROKEN, REPLY_TO_INVALID, isReplyToRejection } from './reply-to'
import {
  LOCATION_SENDER_NOT_SET_UP,
  SENDER_DOMAIN_PREFIX,
  SENDER_DOMAIN_UNVERIFIED,
  isSenderDomainRejection,
} from './sender-domain'
import { nextSendAt } from './drip-time'
import { bodyFormatOf, type BodyFormat } from './email-body-html'
import type { EmailExtras, LocationEmailOptions } from './email-send-options'

// TERMINAL vs TRANSIENT (#73). Terminal = Resend rejected the request itself
// and an identical retry yields the identical rejection forever. The only such
// failure the SYNCHRONOUS send path sees is name='validation_error' (422) — an
// invalid / malformed recipient, i.e. a client who mistyped their email. (True
// hard bounces to a valid-looking address are ACCEPTED by Resend at send time
// and bounce later via webhook — they never reach this path.) Everything else
// is treated as transient and keeps retrying: 429 rate limits, 5xx server
// errors, and — deliberately — auth/config errors (401/403) and un-typed
// network throws, because those are system-wide and self-heal, so they must
// never stop a single lead's drip.
//
// NOT the reply-to (Dallas, 2026-09). Resend refuses a bad reply-to with the
// SAME validation_error a bad recipient gets, but the reply-to is the
// LOCATION's setting: every lead there fails identically and every one of them
// has a fine address. lib/resend.ts re-labels those as REPLY_TO_INVALID; the
// message check here is the second lock, so a reply-to rejection can never be
// read as the client's fault even if the label is lost on the way.
//
// NOT the sender's domain either (Test Location, 2026-09-27): Resend refuses a
// From on an unverified domain ("The gmail.com domain is not verified…") as a
// validation error too. lib/resend.ts re-labels it SENDER_DOMAIN_UNVERIFIED;
// the message check is again the second lock.
export function isTerminalSendFailure(errorName?: string | null, message?: string | null): boolean {
  if (errorName === REPLY_TO_INVALID || isReplyToRejection(message)) return false
  if (isLocationSenderDomainFailure(errorName, message)) return false
  return errorName === 'validation_error'
}

// A send refused because the FROM address's domain isn't one we can send from.
export function isLocationSenderDomainFailure(errorName?: string | null, message?: string | null): boolean {
  return errorName === SENDER_DOMAIN_UNVERIFIED || isSenderDomainRejection(message)
}

// A send refused on the location's reply-to (see isTerminalSendFailure).
export function isLocationReplyToFailure(errorName?: string | null, message?: string | null): boolean {
  return errorName === REPLY_TO_INVALID || isReplyToRejection(message)
}

// What a refused send means, in the order the client sender has always asked:
//   sender_config_missing  the location's From / name / reply-to is not set up
//   reply_to               the location's reply-to is broken
//   sender_domain          the From address is on a domain we can't send from
//   terminal               Resend refused the recipient itself (bad address)
//   transient              anything else: retry
// ownerMessage is the sentence recorded for the owner; senderDomainMessage is
// set only for sender_domain.
export type SendFailureKind = 'sender_config_missing' | 'reply_to' | 'sender_domain' | 'terminal' | 'transient'
export function classifySendFailure(result: { error?: string | null; errorName?: string | null }): {
  kind: SendFailureKind
  ownerMessage: string
  senderDomainMessage: string | null
} {
  // sendEmail returns this exact error string when the location's sender
  // config (send_from_email/sender_name/reply_to_email) is NULL — that's a
  // setup gap, not a transient send failure.
  const senderConfigMissing = (result.error ?? '').includes('missing sender config')
  // The location's reply-to is broken (two addresses, a typo). Like a
  // missing sender config it is the LOCATION's setup, not this recipient.
  const replyToBroken = !senderConfigMissing && isLocationReplyToFailure(result.errorName, result.error)
  // The FROM address is on a domain we can't send from (a Gmail address as a
  // job type's sender). Same shape as the reply-to: the location's setting.
  // The message is sendEmail's owner wording, which names the address and
  // the Settings screen; if the label was lost on the way, say it plainly.
  const senderDomainBroken = !senderConfigMissing && !replyToBroken &&
    isLocationSenderDomainFailure(result.errorName, result.error)
  const senderDomainMessage = senderDomainBroken
    ? ((result.error ?? '').startsWith(SENDER_DOMAIN_PREFIX)
        ? result.error!
        : `${SENDER_DOMAIN_PREFIX} this location’s sender address — Bee Organized can’t send from its domain. Check Settings → Emails, under Who your emails come from. Emails resume on their own once it’s fixed.`)
    : null
  const ownerMessage = senderConfigMissing
    ? LOCATION_SENDER_NOT_SET_UP
    : replyToBroken
      ? LOCATION_REPLY_TO_BROKEN
      : senderDomainMessage ?? result.error ?? 'unknown send error'
  const kind: SendFailureKind = senderDomainMessage
    ? 'sender_domain'
    : replyToBroken
      ? 'reply_to'
      : senderConfigMissing
        ? 'sender_config_missing'
        : isTerminalSendFailure(result.errorName, result.error)
          ? 'terminal'
          : 'transient'
  return { kind, ownerMessage, senderDomainMessage }
}

// The step and its linked template, by sequence row and step number.
export async function loadSequenceStep(dripPathId: string, stepOrder: number) {
  return supabaseService
    .from('drip_path_steps')
    .select(
      `
      *,
      templates:master_template_id ( * )
      `,
    )
    .eq('drip_path_id', dripPathId)
    .eq('step_order', stepOrder)
    .maybeSingle()
}

// The location (sender context + tz for scheduling the next step). '*', not a
// column list: the Settings → Emails columns (email_style and the two new
// booking links) arrive in migrations run after this ships, and a named
// missing column would fail the whole read. Missing → today's behaviour
// (lib/email-send-options).
export async function loadSendLocation(locationId: string) {
  return supabaseService
    .from('locations')
    .select('*')
    .eq('id', locationId)
    .maybeSingle()
}

// SAFETY GATE (interface-active): never SEND for a location that isn't ACTIVE
// on the interface — the interface is the only place a sequence can be
// stopped, so an uncontrollable email must never leave the building.
export function locationCanSend(loc: { lifecycle_status?: string | null }): boolean {
  return loc.lifecycle_status === 'active'
}

// Subject/body: step override > linked template. The shape of the body is a
// fact about the ROW IT CAME FROM (body_format, lib/email-body-html.ts): the
// step's own wording, or the linked template's. The join reads the template
// with '*' so the column rides along once its migration has run and is simply
// absent — plain — before.
export function stepContent(stepRow: Record<string, unknown>): {
  subjectSource: string | null
  bodySource: string | null
  bodyFormat: BodyFormat
} {
  const step = stepRow as any
  const linkedTpl = (Array.isArray(step.templates) ? step.templates[0] : step.templates) as { subject: string | null; body: string } | null
  return {
    subjectSource: step.subject ?? linkedTpl?.subject ?? null,
    bodySource: step.body ?? linkedTpl?.body ?? null,
    bodyFormat: bodyFormatOf((step.body != null ? step : linkedTpl) as Record<string, unknown> | null),
  }
}

// The button's link is checked by the same guards as the wording: a button
// pointing at a blank link holds the email like the sentence would.
export function guardBodyOf(bodySource: string, buttonLink: string | null): string {
  return buttonLink ? `${bodySource}\n${buttonLink}` : bodySource
}

// The button's text and link, through the same tags as the wording.
export function renderStepButton(extras: EmailExtras, ctx: RenderContext): { subject: string; body: string } | null {
  return extras.buttonText && extras.buttonLink
    ? renderTemplate({ subject: extras.buttonText, body: extras.buttonLink }, ctx)
    : null
}

// The location's style, the subject as the heading, and the button
// (2026-10-30 layout).
export function emailLook(
  emailOptions: LocationEmailOptions,
  rendered: { subject: string },
  renderedButton: { subject: string; body: string } | null,
  extras: EmailExtras,
) {
  return {
    style: emailOptions.style,
    heading: rendered.subject,
    button: renderedButton ? { label: renderedButton.subject, href: renderedButton.body, align: extras.buttonAlign } : null,
  }
}

// Which step comes after this one, and when it goes. `tz` is the location
// timezone (null is fine — the helper falls back to UTC). step.delay_days is
// absolute-from-start; the *gap* to the next send is the diff vs the current
// step's delay_days. Reads only; the caller writes its own tracking row.
export type NextStepPlan =
  | { kind: 'lookup_failed'; error: unknown }
  | { kind: 'last' }
  | { kind: 'next'; stepOrder: number; sendAt: Date }
export async function planNextStep(dripPathId: string, currentStepOrder: number, tz: string | null): Promise<NextStepPlan> {
  const { data: nextStep, error: nextErr } = await supabaseService
    .from('drip_path_steps')
    .select('step_order, delay_days')
    .eq('drip_path_id', dripPathId)
    .eq('step_order', currentStepOrder + 1)
    .maybeSingle()

  if (nextErr) return { kind: 'lookup_failed', error: nextErr }
  if (!nextStep) return { kind: 'last' }

  const { data: currentStep } = await supabaseService
    .from('drip_path_steps')
    .select('delay_days')
    .eq('drip_path_id', dripPathId)
    .eq('step_order', currentStepOrder)
    .maybeSingle()

  const currentDelay = currentStep?.delay_days ?? 0
  const gap = Math.max(0, (nextStep.delay_days ?? 0) - currentDelay)

  return { kind: 'next', stepOrder: nextStep.step_order, sendAt: nextSendAt({ from: new Date(), tz: tz ?? 'UTC', delayDays: gap }) }
}
