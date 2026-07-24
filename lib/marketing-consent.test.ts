// @vitest-environment node
//
// The marketing rail's two halves:
//   • lib/marketing-consent (PURE) — the send-time gate every future marketing
//     sender must call, and the CAN-SPAM footer. Pins: the gate refuses an
//     unsubscribed/opted-out/never-consented recipient and allows a consented
//     one; the footer carries the unsubscribe link + postal address in BOTH
//     html and text.
//   • lib/marketing-unsubscribe (rail) — ensureUnsubscribeToken is
//     first-mint-wins (.is(null) guard + re-read) and stable: an existing
//     token is returned untouched, never overwritten.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    queue: [] as Resp[],
    updates: [] as { arg: any; filters: Record<string, any> }[],
  }
  const reset = () => { state.queue = []; state.updates = [] }
  const enqueue = (data: any, error: any = null) => state.queue.push({ data, error })
  const makeBuilder = () => {
    const resp = state.queue.shift() ?? { data: null, error: null }
    const b: any = {}
    const rec: any = { arg: null, filters: {} }
    b.select = () => b
    b.eq = (col: string, val: any) => { rec.filters[col] = val; return b }
    b.is = (col: string, val: any) => { rec.filters[col] = val; return b }
    b.update = (arg: any) => { rec.arg = arg; state.updates.push(rec); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => h.makeBuilder() },
}))

import {
  marketingSendBlockReason,
  buildMarketingFooter,
  unsubscribePathFor,
} from '@/lib/marketing-consent'
import { ensureUnsubscribeToken } from '@/lib/marketing-unsubscribe'

beforeEach(() => { h.reset() })

describe('marketingSendBlockReason — the send-time gate', () => {
  const consented = new Date('2026-07-01T00:00:00Z').toISOString()

  it('REFUSES an unsubscribed recipient (opt_out set by the public page)', () => {
    expect(marketingSendBlockReason({
      marketing_opt_out: true,
      marketing_consented_at: consented,
      marketing_unsubscribed_at: new Date().toISOString(),
    })).toBe('opted_out')
  })

  it('REFUSES on marketing_unsubscribed_at alone — the gate holds even if some path reset opt_out without it', () => {
    expect(marketingSendBlockReason({
      marketing_opt_out: false,
      marketing_consented_at: consented,
      marketing_unsubscribed_at: new Date().toISOString(),
    })).toBe('unsubscribed')
  })

  it('REFUSES a recipient with no positive consent record — this list is consent-based', () => {
    expect(marketingSendBlockReason({
      marketing_opt_out: false,
      marketing_consented_at: null,
      marketing_unsubscribed_at: null,
    })).toBe('no_consent')
    // absent fields behave like nulls (pre-migration shapes must not slip through as sendable)
    expect(marketingSendBlockReason({})).toBe('no_consent')
  })

  it('allows a consented, not-withdrawn recipient', () => {
    expect(marketingSendBlockReason({
      marketing_opt_out: false,
      marketing_consented_at: consented,
      marketing_unsubscribed_at: null,
    })).toBeNull()
  })
})

describe('buildMarketingFooter — CAN-SPAM elements in both parts', () => {
  const url = 'https://app.example.com/unsubscribe/abc123'
  const postal = '123 Hive Lane, Suite 4, Omaha, NE 68102'

  it('carries the unsubscribe link and postal address in html AND text', () => {
    const { html, text } = buildMarketingFooter({ unsubscribeUrl: url, postalAddress: postal })
    expect(html).toContain(url)
    expect(html).toContain('Unsubscribe')
    expect(html).toContain(postal)
    expect(text).toContain(url)
    expect(text.toLowerCase()).toContain('unsubscribe')
    expect(text).toContain(postal)
  })

  it('omits the address line when unset (previews before configuration) — the sender must refuse instead', () => {
    const { html, text } = buildMarketingFooter({ unsubscribeUrl: url, postalAddress: null })
    expect(html).toContain(url)
    expect(text).toContain(url)
    expect(html).not.toContain('null')
    expect(text).not.toContain('null')
  })

  it('unsubscribePathFor is the single spelling of the public route', () => {
    expect(unsubscribePathFor('tok')).toBe('/unsubscribe/tok')
  })
})

describe('ensureUnsubscribeToken — first-mint-wins, stable forever', () => {
  it('returns an existing token untouched — never overwrites (links already in inboxes)', async () => {
    h.enqueue({ unsubscribe_token: 'existing-token' })
    const token = await ensureUnsubscribeToken('lead-1')
    expect(token).toBe('existing-token')
    expect(h.state.updates).toHaveLength(0)
  })

  it('mints 48 hex with the .is(null) guard, then RE-READS so a lost race returns the winner’s token', async () => {
    h.enqueue({ unsubscribe_token: null })            // initial read: none
    h.enqueue({}, null)                               // guarded mint write
    h.enqueue({ unsubscribe_token: 'winner-token' })  // re-read (what the row actually holds)

    const token = await ensureUnsubscribeToken('lead-1')
    expect(token).toBe('winner-token')

    const upd = h.state.updates[0]
    expect(upd.arg.unsubscribe_token).toMatch(/^[0-9a-f]{48}$/)
    expect(upd.filters.unsubscribe_token).toBeNull()  // WHERE unsubscribe_token IS NULL
    expect(upd.filters.id).toBe('lead-1')
  })

  it('returns null on a read failure (e.g. column missing pre-migration) — the caller must NOT send', async () => {
    h.enqueue(null, { message: 'column leads.unsubscribe_token does not exist', code: '42703' })
    const token = await ensureUnsubscribeToken('lead-1')
    expect(token).toBeNull()
    expect(h.state.updates).toHaveLength(0)
  })
})
