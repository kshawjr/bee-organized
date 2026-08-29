// @vitest-environment node
//
// THE TWO SMALL FIXES: the email offers the in-app door, and the
// unopened-reply alert is wired to the ops rail.
//
// Pinned, per the brief:
//   1. the new copy appears in BOTH emails (and the mailbox line is gone —
//      but returns as the fallback when there is no button to point at)
//   2. the alert fires at the 21-day threshold and not before
//   3. it does not fire twice for the same item — the stock fires once
//      (guarded by "alerted before"), a crossing fires in exactly one
//      window, and a standing already-alerted set stays silent
//   4. it reaches the ops rail (postSlackMessage — the lib/slack incoming
//      webhook), even on a run the brief itself suppresses as quiet
//   5. nothing that was silent before now sends mail — the cron path can't
//      even reach the email module, and the alert flow calls only Slack
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─── mocks for the cron route test ────────────────────────────────────
const slack = vi.hoisted(() => ({ fn: vi.fn(async () => ({ ok: true })) }))
const data = vi.hoisted(() => ({
  items: [] as any[],
  alertState: { lastBriefRunAt: null as string | null, unopenedAlertedBefore: false },
  briefRuns: [] as any[],
  unopenedRuns: [] as any[],
}))

vi.mock('@/lib/slack', () => ({ postSlackMessage: slack.fn }))
// The mail transport, mocked for two reasons: importing the email builder for
// the copy tests pulls it in (it builds a DB client at module load), and its
// spy is the direct instrument for "nothing here sends mail".
const mail = vi.hoisted(() => ({ fn: vi.fn(async () => ({ success: true, id: 'x' })) }))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: mail.fn }))
vi.mock('@/lib/feedback-brief-data', () => ({
  fetchFeedbackForBrief: vi.fn(async () => ({ items: data.items, ok: true, internalSupported: true })),
}))
vi.mock('@/lib/digest-runs', () => ({
  recordFeedbackBriefRun: vi.fn(async (brief: any, post: any) => { data.briefRuns.push({ brief, post }) }),
  fetchFeedbackAlertState: vi.fn(async () => data.alertState),
  recordFeedbackUnopenedRun: vi.fn(async (post: any, text: string) => { data.unopenedRuns.push({ post, text }) }),
}))

import { GET as cronGet } from '@/app/api/cron/feedback-brief/route'
import { decideUnopenedAlert } from '@/lib/feedback-unopened'
import { buildFeedbackReplyEmail } from '@/lib/feedback-reply-email'
import { UNOPENED_REPLY_DAYS } from '@/lib/feedback-nudge'

const DAY = 86_400_000
const NOW = Date.parse('2026-08-30T11:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const unopened = (daysAgo: number, over: any = {}) => ({
  id: `i${daysAgo}`, is_internal: false,
  admin_response: 'We wrote back.', admin_response_at: iso(daysAgo * DAY),
  reply_seen_at: null, ...over,
})

// ─── 1. the email copy ────────────────────────────────────────────────

describe('both emails offer the in-app door', () => {
  const LINK = 'https://hub.example.com/?feedback=1'

  it('the reply email points at the report, not the mailbox', () => {
    const built = buildFeedbackReplyEmail({
      recipientName: 'Lynette Ewy', itemTitle: 'A question', itemType: 'question',
      replyText: 'Here is the answer.', link: LINK,
    })
    expect(built.text).toContain('reply right on your report')
    expect(built.text).toContain('reaches the person working on it')
    expect(built.text).not.toContain('reply to this email')
    expect(built.html).toContain('reply right on your report')
  })

  it('the fixed announcement points at the report too', () => {
    const built = buildFeedbackReplyEmail({
      recipientName: 'Ankur Patel', itemTitle: 'A bug', itemType: 'bug',
      replyText: '', shipped: true, link: LINK,
    })
    expect(built.text).toContain('tell us right on your report')
    expect(built.text).not.toContain('reply to this email')
  })

  it('with NO button to point at, the mailbox copy returns — never a dangling reference', () => {
    const reply = buildFeedbackReplyEmail({ itemTitle: 't', replyText: 'words', link: '' })
    expect(reply.text).toContain('reply to this email')
    expect(reply.text).not.toContain('button above')
    const announce = buildFeedbackReplyEmail({ itemTitle: 't', replyText: '', shipped: true, link: '' })
    expect(announce.text).toContain('reply to this email')
  })
})

// ─── 2 + 3. the decision rules ────────────────────────────────────────

describe('the alert fires at the threshold and never twice', () => {
  it('20 days is silence; 21 days fires (the stock rule, first ever run)', () => {
    const under = decideUnopenedAlert({
      items: [unopened(UNOPENED_REPLY_DAYS - 1)], lastCheckedAt: null, alertedBefore: false, now: NOW,
    })
    expect(under.event).toBeNull()

    const at = decideUnopenedAlert({
      items: [unopened(UNOPENED_REPLY_DAYS)], lastCheckedAt: null, alertedBefore: false, now: NOW,
    })
    expect(at.event).toMatchObject({ kind: 'unopened-reply', count: 1, oldestDays: UNOPENED_REPLY_DAYS })
  })

  it('the stock fires exactly once — alertedBefore silences a standing set', () => {
    const items = [unopened(49), unopened(30)]
    const first = decideUnopenedAlert({ items, lastCheckedAt: null, alertedBefore: false, now: NOW })
    expect(first.event).toMatchObject({ count: 2, oldestDays: 49 })
    // Next morning: same set, nothing newly crossed → nothing posts.
    const next = decideUnopenedAlert({
      items, lastCheckedAt: iso(DAY), alertedBefore: true, now: NOW,
    })
    expect(next.event).toBeNull()
    expect(next.reason).toContain('already alerted')
  })

  it('a NEW crossing fires once, in exactly one window, and not in the next', () => {
    // Reply written 21 days + 2 hours ago → its crossing moment was 2h ago.
    const justCrossed = unopened(0, { admin_response_at: iso(UNOPENED_REPLY_DAYS * DAY + 2 * 3600_000) })
    const fires = decideUnopenedAlert({
      items: [justCrossed], lastCheckedAt: iso(DAY), alertedBefore: true, now: NOW,
    })
    expect(fires.event).toMatchObject({ count: 1 })
    expect(fires.crossedCount).toBe(1)
    // Tomorrow's window starts NOW — the same crossing moment is behind it.
    const tomorrow = decideUnopenedAlert({
      items: [justCrossed], lastCheckedAt: new Date(NOW).toISOString(), alertedBefore: true, now: NOW + DAY,
    })
    expect(tomorrow.event).toBeNull()
  })

  it('seen replies, internal items, and empty replies never count', () => {
    const d = decideUnopenedAlert({
      items: [
        unopened(40, { reply_seen_at: iso(30 * DAY) }),        // opened after the reply
        unopened(40, { is_internal: true }),                   // nobody on the other end
        unopened(40, { admin_response: '   ' }),               // no words
      ],
      lastCheckedAt: null, alertedBefore: false, now: NOW,
    })
    expect(d.event).toBeNull()
    expect(d.count).toBe(0)
  })

  it('a SECOND reply on a once-read item counts as unread again', () => {
    const d = decideUnopenedAlert({
      items: [unopened(25, { reply_seen_at: iso(40 * DAY) })], // saw an older reply, not this one
      lastCheckedAt: null, alertedBefore: false, now: NOW,
    })
    expect(d.event).toMatchObject({ count: 1 })
  })
})

// ─── 4 + 5. the wired route ───────────────────────────────────────────

const req = () => ({
  headers: { get: (k: string) => (k === 'authorization' ? 'Bearer test-secret' : null) },
  nextUrl: { searchParams: new URLSearchParams() },
}) as any

beforeEach(() => {
  slack.fn.mockClear()
  slack.fn.mockImplementation(async () => ({ ok: true }))
  data.items = []
  data.alertState = { lastBriefRunAt: null, unopenedAlertedBefore: false }
  data.briefRuns = []
  data.unopenedRuns = []
  process.env.CRON_SECRET = 'test-secret'
})

describe('the cron posts the alert to the ops rail', () => {
  it('fires even on a quiet day the brief suppresses — old unread answers ARE the quiet-day news', async () => {
    // One stale unread answer, nothing new, nothing newly stale → the brief
    // suppresses, and before this wiring the run said nothing at all.
    data.items = [unopened(30, { status: 'shipped', created_at: iso(60 * DAY), updated_at: iso(30 * DAY) })]
    const res = await cronGet(req())
    expect(res.status).toBe(200)
    const alertCalls = slack.fn.mock.calls.filter(c => String(c[0]).includes('answers nobody has read'))
    expect(alertCalls).toHaveLength(1)
    expect(String(alertCalls[0][1]?.[0]?.text)).toContain('never been opened')
    // …and the attempt is recorded, which is what makes it fire-once.
    expect(data.unopenedRuns).toHaveLength(1)
    expect(data.unopenedRuns[0].post.ok).toBe(true)
    // The whole run touched Slack only — zero mail left the building.
    expect(mail.fn).not.toHaveBeenCalled()
  })

  it('stays silent when the standing set was already alerted', async () => {
    data.items = [unopened(30)]
    data.alertState = { lastBriefRunAt: iso(DAY), unopenedAlertedBefore: true }
    await cronGet(req())
    expect(slack.fn.mock.calls.filter(c => String(c[0]).includes('answers nobody'))).toHaveLength(0)
    expect(data.unopenedRuns).toHaveLength(0)
  })

  it('sends no email from any of this — the cron cannot even reach the mail module', () => {
    // The strongest guarantee is structural: neither the route nor the
    // decision lib imports the resend transport or the email builder.
    for (const p of ['app/api/cron/feedback-brief/route.ts', 'lib/feedback-unopened.ts']) {
      const src = readFileSync(join(process.cwd(), p), 'utf8')
      expect(src).not.toContain("from '@/lib/resend'")
      expect(src).not.toContain('feedback-reply-email')
      expect(src).not.toContain('sendEmailDirect')
    }
  })
})
