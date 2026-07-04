// @vitest-environment happy-dom
// Unified activity timeline (components/hive/shared/Timeline.jsx):
//   — ONE shared component embedded on all three lead-detail surfaces,
//     §8.5-clean (no BeeHub/PartnersContext/useContext imports)
//   — merge: past touchpoints/notes/Jobber/closes + future drips/snooze/
//     scheduled stage emails/welcome/assessments, one descending time
//     axis (future above the Now divider, past below)
//   — EMPTY-FUTURE: no upcoming → no Upcoming rows AND no Now divider
//   — PAST-DRIP DEDUP: a real kind='drip' touchpoint beats the
//     outreach-timeline endpoint's back-estimated 'sent' entry
//   — inline actions ONLY where a real write path exists: cancel a
//     scheduled stage email (PATCH /api/scheduled-stage-emails/:id,
//     optimistic + revert-on-fail), un-snooze (PATCH /api/leads/:id).
//     Future drips + assessments are display-only (no per-send drip
//     record; assessments are Jobber-owned).
//   — stage PATCH writes a kind='stage_change' touchpoint (source guard)
//   — dates ride the formatInboxAge tiers + the new future mirror
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import Timeline, { buildTimelineItems } from '@/components/hive/shared/Timeline'
import { formatInboxAge, formatInboxFuture } from '@/components/hive/shared/engagementStatus'
import { leadColsToPersonFields } from '@/components/hive/shared/leadPatchMap'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.now()
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString()
const daysAhead = (n: number) => new Date(NOW + n * 86400000).toISOString()

// ── fixtures ───────────────────────────────────────────────
const aggPayload = (over: any = {}) => ({
  lead: {
    id: 'lead-9',
    snoozed_until: null, snoozed_note: null,
    welcome_email_scheduled_at: null, welcome_email_sent_at: null,
    ...(over.lead || {}),
  },
  touchpoints: over.touchpoints ?? [],
  notes: over.notes ?? [],
  engagements: over.engagements ?? [],
  service_requests: over.service_requests ?? [],
  quotes: over.quotes ?? [],
  jobs: over.jobs ?? [],
  invoices: over.invoices ?? [],
  assessments: over.assessments ?? [],
  scheduled_stage_emails: over.scheduled_stage_emails ?? [],
})
const dripsPayload = (items: any[] = []) => ({
  items, drip_progress_id: 'prog-1', drip_path_name: 'Nurture', paused: false,
  stopped: false, completed: false, completed_at: null, stopped_at: null,
})

// ── fetch mock ─────────────────────────────────────────────
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let calls: Array<{ url: string, method: string, body: any }> = []
let seCancelFail = false
let leadPatchFail = false
let mockAgg: any = aggPayload()
let mockDrips: any = dripsPayload()
const installFetch = () => {
  calls = []
  seCancelFail = false
  leadPatchFail = false
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (u.includes('/outreach-timeline')) return jsonRes(mockDrips)
    if (u.includes('/api/leads/') && u.includes('/timeline')) return jsonRes(mockAgg)
    if (u.includes('/api/scheduled-stage-emails/') && method === 'PATCH') {
      if (seCancelFail) return jsonRes({ error: 'boom' }, 500)
      calls.push({ url: u, method, body: JSON.parse(opts.body) })
      return jsonRes({ id: 'se-1', cancelled: JSON.parse(opts.body).cancelled })
    }
    if (u.includes('/api/leads/') && method === 'PATCH') {
      if (leadPatchFail) return jsonRes({ error: 'boom' }, 500)
      calls.push({ url: u, method, body: JSON.parse(opts.body) })
      return jsonRes({ ok: true })
    }
    return jsonRes({})
  })
  ;(globalThis as any).fetch = mock
  return mock
}

// ── DOM helpers ────────────────────────────────────────────
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const rowButton = (host: Element, summary: string) =>
  [...host.querySelectorAll('button')].find(b =>
    (b.getAttribute('aria-label') || '').includes('timeline item') && (b.textContent || '').includes(summary))

beforeEach(() => installFetch())

// ═══ shared-component + §8.5 guards ════════════════════════
describe('one shared Timeline, §8.5-clean', () => {
  it('all three surfaces embed the SAME shared component', () => {
    for (const f of ['components/hive/PersonCard.jsx', 'components/hive/ClientProfile.jsx', 'components/hive/EngagementPanel.jsx']) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toContain("from './shared/Timeline'")
      expect(src, f).toContain('<Timeline')
    }
    // and only ONE definition exists — the shared file
    const shared = readFileSync('components/hive/shared/Timeline.jsx', 'utf8')
    expect(shared).toContain('export default function Timeline')
  })

  it('§8.5: no BeeHub/PartnersContext imports, no useContext — data via props/fetch only', () => {
    const src = readFileSync('components/hive/shared/Timeline.jsx', 'utf8')
    const importLines = src.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n')
    expect(importLines).not.toContain('PartnersContext')
    expect(importLines).not.toContain('BeeHub')
    expect(src).not.toContain('useContext')
  })
})

// ═══ the merge (pure) ══════════════════════════════════════
describe('buildTimelineItems — merge + ordering', () => {
  const agg = aggPayload({
    lead: { snoozed_until: daysAhead(10).slice(0, 10), snoozed_note: 'call after vacation', welcome_email_scheduled_at: daysAhead(1) },
    touchpoints: [
      { id: 't1', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: daysAgo(1), engagement_id: null },
      { id: 't2', kind: 'drip', method: 'email', label: 'Welcome Email', status: 'sent', occurred_at: daysAgo(3), engagement_id: null },
      { id: 't3', kind: 'stage_change', label: 'Stage: Request → Estimate', occurred_at: daysAgo(2), engagement_id: 'eng-1' },
    ],
    notes: [{ id: 'n1', kind: 'job', text: 'Measured the garage', created_at: daysAgo(4), engagement_id: null }],
    engagements: [{ id: 'eng-1', stage: 'Closed Won', title: 'Garage', closed_at: daysAgo(5), closed_reason: 'won', closed_note: null }],
    quotes: [{ id: 'q1', total: 1200, status: 'approved', sent_at: daysAgo(8), approved_at: daysAgo(7), engagement_id: 'eng-1' }],
    jobs: [{ id: 'j1', title: 'Garage build', total: 1200, status: 'complete', scheduled_start: daysAgo(7), completed_at: daysAgo(6), engagement_id: 'eng-1' }],
    invoices: [{ id: 'i1', total: 1200, status: 'paid', issued_at: daysAgo(6), paid_at: daysAgo(5), engagement_id: 'eng-1' }],
    service_requests: [{ id: 'sr1', requested_at: daysAgo(9), engagement_id: 'eng-1', source: 'jobber' }],
    assessments: [{ id: 'a1', scheduled_at: daysAhead(2), status: 'scheduled', engagement_id: 'eng-1' }],
    scheduled_stage_emails: [{ id: 'se-1', stage_email_key: 'opp_closed_job_3mo', send_at: daysAhead(3), template_name: '3-month check-in', subject: 'How is the garage?' }],
  })
  const drips = dripsPayload([
    { id: 'drip-step-2-prog-1', type: 'drip', step_order: 2, template_name: 'Nurture Day 5', subject: 'Still thinking it over?', channel: 'email', status: 'scheduled', fired_at: null, scheduled_at: daysAhead(5), drip_progress_id: 'prog-1', paused: false },
  ])

  it('every source shows up, future above now (desc), past below (desc)', () => {
    const { future, past } = buildTimelineItems(agg, drips, { nowMs: NOW })
    // FUTURE: snooze(+10) > drip(+5) > stage email(+3) > assessment(+2) > welcome(+1)
    expect(future.map(i => i.type)).toEqual(['snooze', 'drip', 'stage_email', 'assessment', 'welcome'])
    for (const i of future) expect(i.ts).toBeGreaterThan(NOW)
    // strictly descending
    for (let k = 1; k < future.length; k++) expect(future[k - 1].ts).toBeGreaterThanOrEqual(future[k].ts)
    // PAST: call(-1) > stage_change(-2) > drip touchpoint(-3) > note(-4) > close(-5) > invoice(-6) > job(-6) > quote(-8) > request(-9)
    expect(past[0].type).toBe('call')
    expect(past.map(i => i.type)).toContain('note')
    expect(past.map(i => i.type)).toContain('close')
    expect(past.map(i => i.type)).toContain('quote')
    expect(past.map(i => i.type)).toContain('job')
    expect(past.map(i => i.type)).toContain('invoice')
    expect(past.map(i => i.type)).toContain('request')
    expect(past.map(i => i.type)).toContain('stage_change')
    for (const i of past) expect(i.ts).toBeLessThanOrEqual(NOW)
    for (let k = 1; k < past.length; k++) expect(past[k - 1].ts).toBeGreaterThanOrEqual(past[k].ts)
  })

  it('only real write paths get actions: stage email + snooze YES; drips, welcome, assessments display-only', () => {
    const { future } = buildTimelineItems(agg, drips, { nowMs: NOW })
    const byType = Object.fromEntries(future.map(i => [i.type, i]))
    expect(byType.stage_email.action).toBe('cancel_stage_email')
    expect(byType.snooze.action).toBe('unsnooze')
    expect(byType.drip.action).toBeUndefined()     // no per-send drip record exists
    expect(byType.welcome.action).toBeUndefined()  // cron-owned
    expect(byType.assessment.action).toBeUndefined() // Jobber-import-owned
  })

  it('engagementId scopes engagement-TAGGED rows; lead-level rows always pass', () => {
    const { future, past } = buildTimelineItems(agg, drips, { engagementId: 'eng-2', nowMs: NOW })
    // eng-1-tagged rows (stage_change, quote/job/invoice/request, close, assessment) drop out
    expect(past.map(i => i.type)).not.toContain('stage_change')
    expect(past.map(i => i.type)).not.toContain('quote')
    expect(future.map(i => i.type)).not.toContain('assessment')
    // lead-level survives
    expect(past.map(i => i.type)).toContain('call')
    expect(future.map(i => i.type)).toContain('snooze')
  })

  it('EMPTY-FUTURE: nothing upcoming → future is empty, history intact', () => {
    const bare = aggPayload({ touchpoints: [{ id: 't1', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: daysAgo(1) }] })
    const { future, past } = buildTimelineItems(bare, dripsPayload(), { nowMs: NOW })
    expect(future).toEqual([])
    expect(past).toHaveLength(1)
  })
})

// ═══ past-drip dedup ═══════════════════════════════════════
describe('past-drip dedup — real touchpoint beats the back-estimate', () => {
  it('a drip with BOTH a touchpoint row and an endpoint sent-entry appears once, on the touchpoint date', () => {
    const realTs = daysAgo(3)
    const estimatedTs = daysAgo(4) // the endpoint's cadence back-estimate is off by a day
    const agg = aggPayload({
      touchpoints: [{ id: 't2', kind: 'drip', method: 'email', label: 'Nurture Day 3', status: 'sent', occurred_at: realTs }],
    })
    const drips = dripsPayload([
      { id: 'drip-step-1-prog-1', type: 'drip', step_order: 1, template_name: 'Nurture Day 3', subject: 's', channel: 'email', status: 'sent', fired_at: estimatedTs, scheduled_at: null, drip_progress_id: 'prog-1', paused: false },
    ])
    const { past } = buildTimelineItems(agg, drips, { nowMs: NOW })
    const dripItems = past.filter(i => (i.summary || '').includes('Nurture Day 3'))
    expect(dripItems).toHaveLength(1)
    expect(dripItems[0].ts).toBe(new Date(realTs).getTime())
    expect(dripItems[0].detail.estimated).toBeUndefined()
  })

  it('an endpoint-only sent step (no touchpoint — per-step sends write none) is KEPT, flagged estimated', () => {
    const drips = dripsPayload([
      { id: 'drip-step-1-prog-1', type: 'drip', step_order: 1, template_name: 'Nurture Day 3', subject: 's', channel: 'email', status: 'sent', fired_at: daysAgo(4), scheduled_at: null, drip_progress_id: 'prog-1', paused: false },
    ])
    const { past } = buildTimelineItems(aggPayload(), drips, { nowMs: NOW })
    expect(past).toHaveLength(1)
    expect(past[0].detail.estimated).toBe(true)
  })
})

// ═══ rendered stream ═══════════════════════════════════════
describe('Timeline rendering', () => {
  it('empty-future collapses the Upcoming section AND the Now divider', async () => {
    mockAgg = aggPayload({ touchpoints: [{ id: 't1', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: daysAgo(1) }] })
    mockDrips = dripsPayload()
    const { host, unmount } = await mount(<Timeline leadId="lead-9" nowMs={NOW} />)
    expect(host.querySelector('[aria-label="Now"]')).toBeFalsy()
    expect(host.textContent).toContain('Call')
    await unmount()
  })

  it('with upcoming items the Now divider renders between future and past', async () => {
    mockAgg = aggPayload({
      touchpoints: [{ id: 't1', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: daysAgo(1) }],
      scheduled_stage_emails: [{ id: 'se-1', stage_email_key: 'k', send_at: daysAhead(3), template_name: '3-month check-in', subject: 'Hi' }],
    })
    mockDrips = dripsPayload()
    const { host, unmount } = await mount(<Timeline leadId="lead-9" nowMs={NOW} />)
    expect(host.querySelector('[aria-label="Now"]')).toBeTruthy()
    expect(host.textContent).toContain('3-month check-in')
    await unmount()
  })

  it('dates ride the shared inbox tiers — past via formatInboxAge, future via the future mirror', async () => {
    const pastTs = daysAgo(5)
    const futTs = daysAhead(3)
    mockAgg = aggPayload({
      touchpoints: [{ id: 't1', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: pastTs }],
      scheduled_stage_emails: [{ id: 'se-1', stage_email_key: 'k', send_at: futTs, template_name: 'Check-in', subject: null }],
    })
    mockDrips = dripsPayload()
    const { host, unmount } = await mount(<Timeline leadId="lead-9" nowMs={NOW} />)
    expect(host.textContent).toContain(formatInboxAge(pastTs, NOW))
    expect(host.textContent).toContain(formatInboxFuture(futTs, NOW))
    await unmount()
  })
})

// ═══ inline actions ════════════════════════════════════════
describe('inline actions', () => {
  const withActionable = () => {
    mockAgg = aggPayload({
      lead: { snoozed_until: daysAhead(10).slice(0, 10), snoozed_note: 'later' },
      scheduled_stage_emails: [{ id: 'se-1', stage_email_key: 'opp_closed_job_3mo', send_at: daysAhead(3), template_name: '3-month check-in', subject: 'Hi' }],
      assessments: [{ id: 'a1', scheduled_at: daysAhead(2), status: 'scheduled', engagement_id: null }],
    })
    mockDrips = dripsPayload([
      { id: 'drip-step-2-prog-1', type: 'drip', step_order: 2, template_name: 'Nurture Day 5', subject: 's', channel: 'email', status: 'scheduled', fired_at: null, scheduled_at: daysAhead(5), drip_progress_id: 'prog-1', paused: false },
    ])
  }

  it('cancel a scheduled stage email: optimistic removal + PATCH cancelled:true', async () => {
    withActionable()
    const toasts: any[] = []
    const { host, unmount } = await mount(<Timeline leadId="lead-9" nowMs={NOW} setToast={t => toasts.push(t)} />)
    await click(rowButton(host, '3-month check-in')!)
    const btn = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Cancel scheduled email')!
    expect(btn).toBeTruthy()
    await click(btn)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/scheduled-stage-emails/se-1'), method: 'PATCH', body: { cancelled: true } }])
    expect(host.textContent).not.toContain('3-month check-in') // removed from the stream
    expect(toasts.at(-1)?.kind).toBe('success')
    await unmount()
  })

  it('cancel failure REVERTS the optimistic removal', async () => {
    withActionable()
    seCancelFail = true
    const toasts: any[] = []
    const { host, unmount } = await mount(<Timeline leadId="lead-9" nowMs={NOW} setToast={t => toasts.push(t)} />)
    await click(rowButton(host, '3-month check-in')!)
    await click([...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Cancel scheduled email')!)
    expect(host.textContent).toContain('3-month check-in') // reverted
    expect(toasts.at(-1)?.kind).toBe('error')
    await unmount()
  })

  it('un-snooze reuses the snooze-clear PATCH and propagates via onLeadPatched', async () => {
    withActionable()
    const patched: any[] = []
    const { host, unmount } = await mount(
      <Timeline leadId="lead-9" nowMs={NOW} onLeadPatched={(id: string, cols: any) => patched.push([id, cols])} />,
    )
    await click(rowButton(host, 'Snoozed until')!)
    await click([...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Un-snooze')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), method: 'PATCH', body: { snoozed_until: null } }])
    expect(patched).toEqual([['lead-9', { snoozed_until: null }]])
    expect(host.textContent).not.toContain('Snoozed until')
    // and the translator carries it to the Person shape for the Inbox
    expect(leadColsToPersonFields({ snoozed_until: null })).toEqual({ snoozeUntil: null })
    await unmount()
  })

  it('display-only rows (future drip, assessment) expose NO action button', async () => {
    withActionable()
    const { host, unmount } = await mount(<Timeline leadId="lead-9" nowMs={NOW} />)
    for (const summary of ['Nurture Day 5', 'Assessment']) {
      await click(rowButton(host, summary)!)
      expect([...host.querySelectorAll('button')].filter(b =>
        ['Cancel scheduled email', 'Un-snooze'].includes(b.getAttribute('aria-label') || ''))).toHaveLength(0)
      await click(rowButton(host, summary)!) // collapse again
    }
    await unmount()
  })
})

// ═══ write-path source guards ══════════════════════════════
describe('write paths', () => {
  it("engagement stage PATCH writes a kind='stage_change' touchpoint — going forward only, no backfill", () => {
    const src = readFileSync('app/api/engagements/[id]/route.ts', 'utf8')
    expect(src).toContain("kind: 'stage_change'")
    expect(src).toContain('if (stageChanged)')
    expect(src.toLowerCase()).toContain('never backfill') // the limitation is documented
  })

  it('the per-row stage-email cancel route exists and guards sent rows', () => {
    const src = readFileSync('app/api/scheduled-stage-emails/[id]/route.ts', 'utf8')
    expect(src).toContain("cancelled_reason: 'manual'")
    expect(src).toContain('already_sent')
    expect(src).toContain("is('sent_at', null)")
  })
})

// ═══ future date tiers (mirror of the locked inbox tiers) ══
describe('formatInboxFuture', () => {
  it('< 24h ahead → relative only', () => {
    expect(formatInboxFuture(NOW + 45 * 60000, NOW)).toBe('in 45 min')
    expect(formatInboxFuture(NOW + 3 * 3600000, NOW)).toBe('in 3 hours')
    expect(formatInboxFuture(NOW + 20000, NOW)).toBe('now')
  })
  it('1–30d → date · in Nd; beyond → date only', () => {
    const five = formatInboxFuture(NOW + 5 * 86400000, NOW)
    expect(five).toMatch(/^[A-Z][a-z]{2} \d{1,2} · in 5d$/)
    const far = formatInboxFuture(NOW + 45 * 86400000, NOW)
    // > 30d: no relative hint (year appears only when it differs)
    expect(far).not.toContain('· in')
  })
})
