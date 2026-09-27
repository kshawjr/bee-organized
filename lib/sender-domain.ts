// lib/sender-domain.ts
// ─────────────────────────────────────────────────────────────
// ONE rule for "can Bee Organized send FROM this address?" — the sibling of
// lib/reply-to.ts, and for the same reason.
//
// Why it exists (Test Location, 2026-09-27): "Home or Office Organizing" was
// set to send AS its handler, whose own address is kshawjr@gmail.com. Resend
// only sends from domains we have verified with it, so it refused every send:
// "The gmail.com domain is not verified. Please, add and verify your domain on
// https://resend.com/domains". The drip engine read that as the CLIENT's
// fault — stopped the lead's drip for good as 'invalid_recipient' and told the
// owner "the client's email address looks invalid … contact support". The
// client's address was fine. It is the reply-to bug (lib/reply-to.ts, Dallas)
// in a different field.
//
// Two places a sending address comes from, and the owner message names which:
//   · the location's Send From Email (Settings → Emails)
//   · a job type's sender (Settings → New leads → Who handles what) — either
//     the handler's own sign-in address ("person" mode) or a typed shared
//     mailbox.
//
// WHICH DOMAINS ARE SENDABLE is not hard-coded here. The list is passed in —
// lib/sendable-domains.ts gets it from Resend itself (or an env override), and
// when it can't be known the domain check is skipped rather than guessed.
//
// Pure and import-free apart from lib/reply-to (also pure): BeeHub.jsx and the
// client card import it as well as the server.
// ─────────────────────────────────────────────────────────────

import { LOCATION_REPLY_TO_BROKEN } from './reply-to'

// SendResult.errorName for a send refused because the FROM address's domain
// isn't one we can send from. Like REPLY_TO_INVALID, distinct from Resend's
// 'validation_error' on purpose: that means a bad RECIPIENT and stops the
// lead's drip; this is the location's setting and must never touch the lead.
export const SENDER_DOMAIN_UNVERIFIED = 'sender_domain_unverified'

// Every owner-facing message for this cause starts with this, so the card,
// the classic panel and the Timeline can recognise it without parsing.
export const SENDER_DOMAIN_PREFIX = 'Emails can’t send from'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function domainOf(address: string | null | undefined): string {
  const v = String(address ?? '').trim().toLowerCase()
  const at = v.lastIndexOf('@')
  return at >= 0 ? v.slice(at + 1) : ''
}

// An exact domain match, case-insensitive. Resend verifies domains one by one
// (a subdomain is its own verification), so no suffix matching.
export function isSendableDomain(address: string, sendable: readonly string[]): boolean {
  const d = domainOf(address)
  return !!d && sendable.some((s) => s.trim().toLowerCase() === d)
}

function domainList(sendable: readonly string[]): string {
  const names = sendable.map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (names.length === 0) return 'a domain Bee Organized has verified'
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

// null when the value is ONE usable sending address; otherwise the reason, in
// owner words. `sendable` null = the verified list isn't known right now, so
// only the shape is checked (never guess a domain rule).
export function senderAddressProblem(
  value: string | null | undefined,
  sendable: readonly string[] | null,
  opts: { required?: boolean; what?: string } = {},
): string | null {
  const what = opts.what ?? 'send-from address'
  const v = String(value ?? '').trim()
  if (!v) return opts.required === false ? null : `A ${what} is required — without one, no emails can send.`
  const count = (v.match(/@/g) || []).length
  if (count > 1 || /[,;\s]/.test(v)) {
    return `Only one ${what} is allowed${count > 1 ? ` — this has ${count}` : ''}.`
  }
  if (!EMAIL_RE.test(v)) return `That ${what} is not valid. Enter one address, like hello@beeorganized.com.`
  if (sendable && !isSendableDomain(v, sendable)) {
    return `Bee Organized can’t send email from ${domainOf(v)} addresses. Use an address on ${domainList(sendable)}.`
  }
  return null
}

// Resend's refusal ("The gmail.com domain is not verified. Please, add and
// verify your domain …"), or our own re-labelled message. Narrow on purpose.
export function isSenderDomainRejection(message: string | null | undefined): boolean {
  const m = String(message ?? '')
  return /domain is not verified/i.test(m) || m.startsWith(SENDER_DOMAIN_PREFIX)
}

// ── What the owner is told ────────────────────────────────────────────────
// Names the address, says it is the LOCATION's setting, and says exactly
// where to change it. Never the client's address, never "contact support".
export function locationSenderDomainMessage(address: string): string {
  return `${SENDER_DOMAIN_PREFIX} ${address} — Bee Organized can’t send from ${domainOf(address) || 'that'} addresses. Change your location’s Send From Email in Settings → Emails. Emails resume on their own once it’s fixed.`
}

export function projectTypeSenderDomainMessage(projectType: string, address: string): string {
  return `${SENDER_DOMAIN_PREFIX} ${address} — Bee Organized can’t send from ${domainOf(address) || 'that'} addresses, and ${projectType} emails are set to send as it. Change who sends ${projectType} in Settings → New leads → Who handles what. Emails resume on their own once it’s fixed.`
}

// The sender-config-missing message drip-send records (kept here so the card
// and the classic panel recognise all three location-setting holds by one
// function).
export const LOCATION_SENDER_NOT_SET_UP =
  'Your location’s sender email isn’t set up — check Settings (send-from address, sender name and reply-to).'

// Is this recorded drip error a LOCATION setting that holds sends (not the
// client, not transient)? Reply-to, sender domain, or sender not set up.
export function isLocationSendSettingProblem(message: string | null | undefined): boolean {
  const m = String(message ?? '')
  if (!m) return false
  return (
    m.startsWith(LOCATION_REPLY_TO_BROKEN) ||
    m.startsWith(SENDER_DOMAIN_PREFIX) ||
    m.startsWith(LOCATION_SENDER_NOT_SET_UP)
  )
}
