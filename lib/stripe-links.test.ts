// @vitest-environment node
//
// Payment-link URL building — pins the click-time contract: the stored
// per-tier link is location-agnostic, and Bee Hub appends
// client_reference_id (+ prefilled_email) when rendering the Pay button.

import { describe, expect, it } from 'vitest'
import {
  buildStripePayUrl,
  isValidPaymentLinkUrl,
  isCanonicalStripeHost,
} from './stripe-links'

const LOC = '6f9619ff-8b86-4d01-b42d-00c04fc964ff'

describe('buildStripePayUrl', () => {
  it('appends client_reference_id and prefilled_email', () => {
    const url = buildStripePayUrl('https://buy.stripe.com/abc123', LOC, 'owner@example.com')
    const u = new URL(url!)
    expect(u.searchParams.get('client_reference_id')).toBe(LOC)
    expect(u.searchParams.get('prefilled_email')).toBe('owner@example.com')
  })

  it('preserves existing query params on the stored link', () => {
    const url = buildStripePayUrl('https://buy.stripe.com/abc123?locale=en', LOC)
    const u = new URL(url!)
    expect(u.searchParams.get('locale')).toBe('en')
    expect(u.searchParams.get('client_reference_id')).toBe(LOC)
  })

  it('omits prefilled_email when absent or not an email', () => {
    const u1 = new URL(buildStripePayUrl('https://buy.stripe.com/abc', LOC)!)
    expect(u1.searchParams.has('prefilled_email')).toBe(false)
    const u2 = new URL(buildStripePayUrl('https://buy.stripe.com/abc', LOC, 'nope')!)
    expect(u2.searchParams.has('prefilled_email')).toBe(false)
  })

  it('returns null for missing/invalid links or missing location (record-only fallback)', () => {
    expect(buildStripePayUrl(null, LOC)).toBeNull()
    expect(buildStripePayUrl(undefined, LOC)).toBeNull()
    expect(buildStripePayUrl('', LOC)).toBeNull()
    expect(buildStripePayUrl('http://buy.stripe.com/abc', LOC)).toBeNull() // https only
    expect(buildStripePayUrl('not a url', LOC)).toBeNull()
    expect(buildStripePayUrl('https://buy.stripe.com/abc', '')).toBeNull()
  })
})

describe('isValidPaymentLinkUrl', () => {
  it('requires https', () => {
    expect(isValidPaymentLinkUrl('https://buy.stripe.com/abc')).toBe(true)
    expect(isValidPaymentLinkUrl('https://pay.custom-domain.com/abc')).toBe(true)
    expect(isValidPaymentLinkUrl('http://buy.stripe.com/abc')).toBe(false)
    expect(isValidPaymentLinkUrl('  ')).toBe(false)
    expect(isValidPaymentLinkUrl(null)).toBe(false)
  })
})

describe('isCanonicalStripeHost', () => {
  it('flags non-buy.stripe.com hosts for the admin-UI warning', () => {
    expect(isCanonicalStripeHost('https://buy.stripe.com/abc')).toBe(true)
    expect(isCanonicalStripeHost('https://evil.example.com/abc')).toBe(false)
  })
})
