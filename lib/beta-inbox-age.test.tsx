// @vitest-environment happy-dom
// Inbox row age slot — adaptive "date · relative" + the alignment fix.
// Covers:
//   - formatInboxAge tiers: <24h relative-only; 1–30d this year
//     "MMM D · Nd ago"; >30d this year date-led (no useless "74d ago");
//     prior year full date with year, no relative
//   - the parts split the row styles from (anchor --text-secondary,
//     hint --text-muted), one nowrap line
//   - alignment: the date/relative text and the action icons share ONE
//     align-items:center container — on New rows (3 icons) AND linked
//     Attempting rows (··· only)
//   - no behavior change from the restyle: tel: link + More menu still
//     work and still stopPropagation
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import { formatInboxAge, formatInboxAgeParts } from '@/components/hive/shared/engagementStatus'
import { TEXT_SECONDARY, TEXT_MUTED } from '@/components/ui/tokens'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Fixed local-time anchor: Jul 4, 2026 12:00 — both `now` and the test
// timestamps run through the same local-TZ Date math the helper uses.
const NOW = new Date(2026, 6, 4, 12, 0, 0).getTime()
const H = 3600000, D = 86400000

// ═══ formatInboxAge — the adaptive tiers ═══════════════════
describe('formatInboxAge', () => {
  it('under 24h → relative only, no redundant date', () => {
    expect(formatInboxAge(NOW - 3 * H, NOW)).toBe('3 hours ago')
    expect(formatInboxAge(NOW - 45 * 60000, NOW)).toBe('45 min ago')
    expect(formatInboxAge(NOW - 1 * H, NOW)).toBe('1 hour ago') // singular
    expect(formatInboxAge(NOW - 10000, NOW)).toBe('just now')
    // 23.6h must not round up into '24 hours ago'
    expect(formatInboxAge(NOW - 23.6 * H, NOW)).toBe('23 hours ago')
  })

  it('1–30 days, current year → "MMM D · Nd ago"', () => {
    expect(formatInboxAge(NOW - 29 * D, NOW)).toBe('Jun 5 · 29d ago')
    expect(formatInboxAge(NOW - 30 * D, NOW)).toBe('Jun 4 · 30d ago') // boundary keeps the hint
    expect(formatInboxAge(NOW - 1 * D, NOW)).toBe('Jul 3 · 1d ago')
  })

  it('over 30 days, current year → date leads, the useless "Nd ago" drops', () => {
    expect(formatInboxAge(NOW - 74 * D, NOW)).toBe('Apr 21')
    expect(formatInboxAge(NOW - 31 * D, NOW)).toBe('Jun 3') // first day past the hint window
    expect(formatInboxAge(NOW - 74 * D, NOW)).not.toContain('ago')
  })

  it('prior year → full date with year, no relative', () => {
    const ts = new Date(2025, 11, 12, 10, 0, 0).getTime() // Dec 12, 2025
    expect(formatInboxAge(ts, NOW)).toBe('Dec 12, 2025')
    expect(formatInboxAge(ts, NOW)).not.toContain('ago')
  })

  it('parts split: anchor vs hint (what the row colors separately)', () => {
    expect(formatInboxAgeParts(NOW - 29 * D, NOW)).toEqual({ anchor: 'Jun 5', hint: '29d ago' })
    expect(formatInboxAgeParts(NOW - 3 * H, NOW)).toEqual({ anchor: '3 hours ago', hint: null })
    expect(formatInboxAgeParts(NOW - 74 * D, NOW)).toEqual({ anchor: 'Apr 21', hint: null })
    expect(formatInboxAgeParts(null, NOW)).toEqual({ anchor: '—', hint: null })
  })
})

// ═══ the row — alignment + styling ═════════════════════════
const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * D).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  phoneNormalized: '5615550199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3),
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  outreachTimeline: [],
  ...over,
})
// Linked + recently reached → derived Attempting, Send hidden, no Log
// call (New-only) — the ··· is the whole cluster.
const attemptingLinked = (over: any = {}) => person({
  jobberRef: '12345',
  created: daysAgo(10),
  outreachTimeline: [{ id: 't1', type: 'reach_out', occurred_at: daysAgo(2) }],
  ...over,
})

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
const byLabel = (host: Element, label: string) =>
  host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null

const inbox = (people: any[], over: any = {}) => (
  <InboxScreen people={people} engagements={[]} locFilter="all" setToast={() => {}} {...over} />
)

beforeEach(() => {
  ;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  ;(globalThis as any).window?.localStorage?.clear?.()
})

describe('age/icon alignment — one center line', () => {
  const expectAligned = (host: Element, presentLabels: string[], absentLabels: string[]) => {
    const age = host.querySelector('.bee-inbox-age') as HTMLElement
    expect(age, 'exactly one age element per row').toBeTruthy()
    expect(host.querySelectorAll('.bee-inbox-age')).toHaveLength(1)
    const cluster = age.parentElement as HTMLElement
    expect(cluster.style.display).toBe('flex')
    expect(cluster.style.alignItems).toBe('center')
    for (const label of presentLabels) {
      const btn = byLabel(host, label)
      expect(btn, `${label} icon present`).toBeTruthy()
      expect(cluster.contains(btn!), `${label} shares the age's center-aligned cluster`).toBe(true)
    }
    for (const label of absentLabels) expect(byLabel(host, label)).toBeFalsy()
  }

  it('New row: age + all 3 icons in one align-items:center container', async () => {
    const m = await mount(inbox([person()]))
    expectAligned(m.host, ['Log call', 'Send to Jobber', 'More'], [])
    await m.unmount()
  })

  it('Attempting (linked) row: age aligns to the lone ···', async () => {
    const m = await mount(inbox([attemptingLinked()]))
    expect(m.host.textContent).toContain('Attempting')
    expectAligned(m.host, ['More'], ['Log call', 'Send to Jobber'])
    await m.unmount()
  })

  it('anchor rides --text-secondary, the "· relative" hint rides --text-muted, nowrap', () => {
    const html = renderToString(inbox([person({ created: daysAgo(29) })]))
    const age = html.match(/class="bee-inbox-age"[^>]*style="([^"]*)"/)
    expect(age).toBeTruthy()
    expect(age![1]).toContain(`var(--text-secondary, ${TEXT_SECONDARY})`)
    expect(age![1]).toContain('white-space:nowrap')
    // the hint span nested inside the age element (SSR may interleave
    // comment nodes between text segments — match loosely)
    const hint = html.match(/class="bee-inbox-age"[^>]*>.*?<span style="([^"]*)"[^>]*>.*?29d ago/)
    expect(hint, 'hint span must carry the muted token').toBeTruthy()
    expect(hint![1]).toContain(`var(--text-muted, ${TEXT_MUTED})`)
  })
})

// ═══ no behavior change ════════════════════════════════════
describe('restyle behavior intact', () => {
  it('tel: link still dials without opening the PersonCard; row click still opens it', async () => {
    const p = person()
    const onOpenPerson = vi.fn()
    const m = await mount(inbox([p], { onOpenPerson }))
    await click(m.host.querySelector('a[href="tel:5615550199"]')!)
    expect(onOpenPerson).not.toHaveBeenCalled()
    await click(m.host.querySelector('.bee-inbox-row')!)
    expect(onOpenPerson).toHaveBeenCalledWith(p)
    await m.unmount()
  })

  it('··· still opens the untouched overflow without bubbling to the row', async () => {
    const onOpenPerson = vi.fn()
    const m = await mount(inbox([person()], { onOpenPerson }))
    await click(byLabel(m.host, 'More')!)
    for (const label of ['Snooze until tomorrow', 'Snooze until next week', 'Dismiss', 'Mark as junk']) {
      expect([...m.host.querySelectorAll('button')].some(b => (b.textContent || '').trim() === label)).toBe(true)
    }
    expect(onOpenPerson).not.toHaveBeenCalled()
    await m.unmount()
  })
})
