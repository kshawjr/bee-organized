// Beta-surface chip regression: renders every beta screen server-side
// (the ACTUAL render path — deriveStatusChip → StatusChip → CHIP_STYLES)
// with realistic fixtures and fails if any StatusChip falls through to
// the gray fallback (unknown styleKey). Also prints every rendered chip
// label + background for visual auditing. Born from the 2026-07-03
// "uncolored title pills" hunt.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import EngagementBoard from '@/components/hive/EngagementBoard'
import EngagementList from '@/components/hive/EngagementList'
import EngagementPanel from '@/components/hive/EngagementPanel'
import ClientDirectory from '@/components/hive/ClientDirectory'
import InboxScreen from '@/components/hive/InboxScreen'
import { fmtTime, fmtShortTime } from '@/components/hive/shared/engagementStatus'

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()
// Future timestamp at an explicit LOCAL wall-clock time, stored as UTC ISO
// (mirrors prod scheduled_at) — proves fmtTime renders the local zone back.
const daysAheadAt = (n: number, h: number, m: number) => {
  const d = new Date(now + n * 86400000); d.setHours(h, m, 0, 0); return d.toISOString()
}

const eng = (over: any = {}) => ({
  id: `e-${Math.random().toString(36).slice(2, 8)}`,
  client_id: 'c1',
  client_name: 'Pat Tester',
  location_uuid: 'loc-uuid-1',
  title: 'Garage organization',
  stage: 'Request',
  created_at: daysAgo(3),
  stage_entered_at: daysAgo(3),
  nurture_started_at: null,
  total_invoiced: 0, total_paid: 0, balance_owing: 0,
  repeat_count: 1,
  quotes: [], jobs: [], invoices: [],
  ...over,
})

const ENGAGEMENTS = [
  eng({ stage: 'Request' }),
  eng({ stage: 'Request', assessments: [{ id: 'a1', scheduled_at: daysAheadAt(2, 19, 0), status: 'scheduled', completed_at: null }] }),
  eng({ stage: 'Request', created_at: daysAgo(25) }), // amber pre-nurture
  eng({ stage: 'Estimate', quotes: [{ id: 'q1', status: 'sent', total: 500, sent_at: daysAgo(2) }] }),
  eng({ stage: 'Estimate', quotes: [{ id: 'q2', status: 'approved', total: 900 }], repeat_count: 3, description: 'Kitchen + garage reorganization after the move — donation runs included.' }),
  eng({ stage: 'Job in Progress', jobs: [{ id: 'j1', status: 'upcoming', scheduled_start: new Date(now + 5 * 86400000).toISOString() }] }),
  eng({ stage: 'Final Processing', total_invoiced: 600, balance_owing: 620, invoices: [{ id: 'i1', status: 'sent', total: 620 }] }),
  eng({ stage: 'Final Processing', jobs: [{ id: 'j2', status: 'completed', completed_at: daysAgo(1) }] }), // never invoiced
]

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Ida Fixture',
  email: 'ida@x.com', phone: '555',
  locationId: 'loc-uuid-1',
  created: daysAgo(3),
  paidAmount: 0, paused: false,
  jobberRef: null, source: 'webform',
  outreachTimeline: [],
  ...over,
})

const PEOPLE = [
  person(), // New
  person({ outreachTimeline: [{ type: 'reach_out', occurred_at: daysAgo(2) }] }), // Attempting
  person({ created: daysAgo(200), paused: true }), // Nurturing
  person({ id: 'c1' }), // Active (open engagement)
  person({ paidAmount: 900, created: daysAgo(300) }), // Past
  person({ email: '', phone: '' }), // no_contact
]

function renderAll() {
  const html: string[] = []
  html.push(renderToString(<EngagementBoard engagements={ENGAGEMENTS as any} />))
  html.push(renderToString(<EngagementList engagements={ENGAGEMENTS as any} closedCount={5} />))
  html.push(renderToString(
    <EngagementPanel engagementId="e-x" seed={ENGAGEMENTS[4] as any} onClose={() => {}} />
  ))
  html.push(renderToString(<ClientDirectory people={PEOPLE as any} engagements={ENGAGEMENTS as any} />))
  html.push(renderToString(<InboxScreen people={PEOPLE as any} engagements={ENGAGEMENTS as any} />))
  return html.join('\n')
}

describe('beta chips', () => {
  it('no StatusChip falls through to the gray fallback on any surface', () => {
    const warns: any[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: any[]) => { warns.push(a) })
    const html = renderAll()
    spy.mockRestore()

    // Print every rendered pill (radius-10 span) label + background.
    const pills = [...html.matchAll(/<span style="[^"]*border-radius:10px[^"]*background:([^;"]+)[^"]*"[^>]*>(?:<[^>]+>)*([^<]*)/g)]
      .map(m => `${(m[2] || '?').trim().padEnd(28)} ${m[1]}`)
    // eslint-disable-next-line no-console
    console.log('rendered pills:\n' + [...new Set(pills)].join('\n'))

    const chipWarns = warns.filter(a => String(a[0]).includes('[StatusChip]'))
    expect(chipWarns, `unknown styleKeys: ${JSON.stringify(chipWarns)}`).toEqual([])

    // The assessment chip carries the LOCAL wall-clock time (fixture is
    // local 7pm stored as UTC ISO — a UTC-rendering bug would show a
    // shifted hour here and fail).
    expect(html).toContain(`Assessment · ${fmtShortTime(daysAheadAt(2, 19, 0))}`)
    expect(html).toContain(', 7pm')
  })

  it('fmtTime: compact local time, minutes only when non-zero, lowercase am/pm', () => {
    const at = (h: number, m: number) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.toISOString() }
    expect(fmtTime(at(19, 0))).toBe('7pm')
    expect(fmtTime(at(10, 30))).toBe('10:30am')
    expect(fmtTime(at(12, 5))).toBe('12:05pm')
    expect(fmtTime(at(0, 0))).toBe('12am')
    expect(fmtTime(null)).toBe(null)
  })
})
