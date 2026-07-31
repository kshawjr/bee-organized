// @vitest-environment node
//
// After-Send engagement poll (issue 155) — the pure logic behind the card
// leaving the Inbox once Send to Jobber has founded its engagement.
//
// THE GAP: a card leaves the Inbox only when the engagements set carries a
// non-terminal engagement whose client_id === lead.id. Send founds that row
// server-side via the Jobber webhook ~11s later (p90 22s); realtime is
// UPDATE-only and the focus sweep's reconcile drops unknown rows, so nothing
// client-side surfaces it. HiveShell polls ?open=1 until it appears and
// injects it into sessionEngagements. These pins cover:
//   · reconcileSentPolls — a match injects the founded row AND leaves pending
//     (the loop stops on match); no match past the cap settles (a calm state,
//     NOT an error) and leaves pending (the loop stops at the cap); a pending
//     send with no match yet keeps polling.
//   · pollDelayForElapsed — tight cadence early, relaxed in the tail.
//   · the SAME injected row, fed through the shared derivations, drops the
//     lead from the Inbox list AND the nav badge (both correct from one
//     injection), and is a real board row (so the board renders it).
import { describe, it, expect } from 'vitest'
import {
  reconcileSentPolls,
  pollDelayForElapsed,
  SEND_POLL_CAP_MS,
} from '@/components/hive/shared/jobberSendPoll'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import { isInboxCountable } from '@/components/hive/shared/inboxCountable'

// A board-shape open engagement row, as ?open=1 returns it.
const ENG = (over: any = {}) => ({
  id: 'e1', client_id: 'c1', stage: 'Request', client_name: 'Acme',
  quotes: [], jobs: [], invoices: [], assessments: [], service_requests: [],
  ...over,
})

// A mapped Inbox person — reachable (so not no_contact), recently created (so
// it would derive 'New' with no engagement).
const PERSON = (over: any = {}) => ({
  id: 'c1', name: 'Acme', phone: '555-0100', email: '',
  created: new Date().toISOString(), outreachTimeline: [], atLocOther: false,
  ...over,
})

describe('reconcileSentPolls', () => {
  it('injects the founded engagement on a match and drops it from pending (loop stops on match)', () => {
    const pending = [{ clientId: 'c1', startedAt: 1_000 }]
    const open = [ENG({ id: 'e1', client_id: 'c1' })]
    const { injects, stillPending, settled } = reconcileSentPolls(pending, open, 5_000)
    expect(injects.map(r => r.id)).toEqual(['e1'])
    expect(stillPending).toEqual([])   // no longer polled
    expect(settled).toEqual([])        // and never treated as a failure
  })

  it('keeps polling a pending send whose engagement has not appeared yet', () => {
    const pending = [{ clientId: 'c1', startedAt: 1_000 }]
    // open set carries OTHER clients' engagements, not c1's
    const open = [ENG({ id: 'eX', client_id: 'cX' })]
    const { injects, stillPending, settled } = reconcileSentPolls(pending, open, 5_000)
    expect(injects).toEqual([])
    expect(stillPending).toEqual([{ clientId: 'c1', startedAt: 1_000 }])
    expect(settled).toEqual([])
  })

  it('settles to a calm state (never an error) at the cap and stops polling', () => {
    const pending = [{ clientId: 'c1', startedAt: 0 }]
    const now = SEND_POLL_CAP_MS + 1   // past the cap, still no match
    const { injects, stillPending, settled } = reconcileSentPolls(pending, [], now)
    expect(injects).toEqual([])
    expect(stillPending).toEqual([])   // no longer polled
    expect(settled).toEqual(['c1'])    // shows the calm close, not an error
  })

  it('injects a match even at the cap boundary — landing beats giving up', () => {
    const pending = [{ clientId: 'c1', startedAt: 0 }]
    const open = [ENG({ id: 'e1', client_id: 'c1' })]
    const { injects, settled } = reconcileSentPolls(pending, open, SEND_POLL_CAP_MS + 1)
    expect(injects.map(r => r.id)).toEqual(['e1'])
    expect(settled).toEqual([])
  })

  it('resolves each of several pending sends independently in one tick', () => {
    const pending = [
      { clientId: 'c1', startedAt: 0 },                    // matches
      { clientId: 'c2', startedAt: SEND_POLL_CAP_MS + 5 }, // still fresh (startedAt in the future is a no-op)
      { clientId: 'c3', startedAt: 0 },                    // caps out
    ]
    const open = [ENG({ id: 'e1', client_id: 'c1' })]
    const now = SEND_POLL_CAP_MS + 10
    const { injects, stillPending, settled } = reconcileSentPolls(pending, open, now)
    expect(injects.map(r => r.client_id)).toEqual(['c1'])
    expect(stillPending.map(p => p.clientId)).toEqual(['c2'])
    expect(settled).toEqual(['c3'])
  })

  it('tolerates a failed fetch (no rows) without settling before the cap', () => {
    const pending = [{ clientId: 'c1', startedAt: 1_000 }]
    const { injects, stillPending, settled } = reconcileSentPolls(pending, undefined as any, 2_000)
    expect(injects).toEqual([])
    expect(stillPending).toEqual([{ clientId: 'c1', startedAt: 1_000 }])
    expect(settled).toEqual([])
  })
})

describe('pollDelayForElapsed', () => {
  it('polls tight (3s) through the first 30s — where p90 lands', () => {
    expect(pollDelayForElapsed(0)).toBe(3_000)
    expect(pollDelayForElapsed(22_000)).toBe(3_000)
    expect(pollDelayForElapsed(29_999)).toBe(3_000)
  })
  it('relaxes (9s) in the long tail past 30s', () => {
    expect(pollDelayForElapsed(30_000)).toBe(9_000)
    expect(pollDelayForElapsed(80_000)).toBe(9_000)
  })
})

describe('the injection corrects the Inbox list AND the badge (same row, both surfaces)', () => {
  it('a lead with no engagement is a live Inbox item; the injected engagement removes it from both', () => {
    const person = PERSON({ id: 'c1' })

    // BEFORE the send lands: no open engagement → New, and countable for the badge.
    const noOpen = new Set<string>()
    expect(deriveClientStatus(person, noOpen)).toBe('New')
    expect(isInboxCountable(person, noOpen, null)).toBe(true)

    // The poll injects the founded engagement; openClientIds now carries it —
    // the SAME set both the list derivation and the badge derive through.
    const { injects } = reconcileSentPolls(
      [{ clientId: 'c1', startedAt: 0 }],
      [ENG({ id: 'e1', client_id: 'c1' })],
      5_000,
    )
    const injected = injects[0]
    // A real board row — so the board renders it in the same pass.
    expect(injected.id).toBe('e1')
    expect(injected.stage).toBe('Request')

    const openClientIds = new Set(injects.map(r => r.client_id))
    // List: the lead now derives Active → out of New/Attempting → leaves the Inbox.
    expect(deriveClientStatus(person, openClientIds)).toBe('Active')
    // Badge: the shared countable rule agrees → the count drops with the row.
    expect(isInboxCountable(person, openClientIds, null)).toBe(false)
  })
})
