// @vitest-environment happy-dom
// Inbox row modernization — ghost icon actions (direction C) + the
// tappable phone number on the compact secondary line (layout B).
// Covers:
//   - the action cluster is borderless ghost ICON buttons (Log call /
//     Send to Jobber / More), each with aria-label + title tooltip —
//     the bordered text pills are gone
//   - behavior preserved: Log call still POSTs the reach_out touchpoint,
//     Send still hands the person to onSendToJobber, More still opens
//     the existing overflow (Junk / Snooze / Dismiss intact)
//   - phone line: tel: link with DIGITS-ONLY href (phone_normalized
//     first, client-side strip as fallback) displaying the FORMATTED
//     phone; tapping it never opens the PersonCard
//   - phoneless lead: no tel: element at all, row still valid
//   - row-click still opens the PersonCard (icons + tel all stop
//     propagation)
//   - mapper: phone_normalized → person.phoneNormalized (read-only)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import { mapLeadToPerson } from '@/lib/people-mapper'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  phoneNormalized: '5615550199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3), // < 30d, no outreach → derived New
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  outreachTimeline: [],
  ...over,
})

// ── fetch mock ─────────────────────────────────────────────
let touchpointPosts: any[] = []
const installFetch = () => {
  touchpointPosts = []
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    if (String(url).includes('/api/touchpoints') && opts.method === 'POST') {
      touchpointPosts.push(JSON.parse(opts.body))
      return { ok: true, status: 201, json: async () => ({ touchpoint: { id: 'tp-1' } }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
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
const byLabel = (host: Element, label: string) =>
  host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null

const inbox = (people: any[], over: any = {}) => (
  <InboxScreen people={people} engagements={[]} locFilter="all" setToast={() => {}} {...over} />
)

beforeEach(() => {
  installFetch()
  ;(globalThis as any).window?.localStorage?.clear?.()
})

// ═══ ghost icon cluster ════════════════════════════════════
describe('ghost icon actions', () => {
  it('renders borderless icon buttons with aria-label + title — the text pills are gone', () => {
    const html = renderToString(inbox([person()]))
    for (const label of ['Log call', 'Send to Jobber', 'More']) {
      const btn = html.match(new RegExp(`aria-label="${label}" title="${label}"[^>]*style="([^"]*)"`))
      expect(btn, `${label} must be an icon button with a tooltip`).toBeTruthy()
      expect(btn![1]).toContain('border:none')
      expect(btn![1]).toContain('background:transparent')
      expect(btn![1]).toContain('var(--text-muted')
    }
    // No bordered pills / button captions left in the cluster.
    expect(html).not.toContain('>Log call</button>')
    expect(html).not.toContain('>Send to Jobber</button>')
    expect(html).not.toContain('···')
  })

  it('Log call opens the shared composer (prefilled call) and never opens the PersonCard', async () => {
    // The row action used to fire a hardcoded one-click write. It opens the
    // unified TouchpointModal now — same reach_out on commit, but the notes
    // and the outcome are reachable, and the method is a choice.
    const p = person()
    const onOpenPerson = vi.fn()
    const m = await mount(inbox([p], { onOpenPerson }))
    await click(byLabel(m.host, 'Log call')!)
    expect(touchpointPosts, 'opening the composer must not write').toHaveLength(0)

    const commit = Array.from(m.host.querySelectorAll('button'))
      .find(b => (b.textContent || '').trim() === 'Log call')
    expect(commit, 'the modal footer restates the prefilled method').toBeTruthy()
    await click(commit!)
    await act(async () => { await Promise.resolve() })

    expect(touchpointPosts).toHaveLength(1)
    expect(touchpointPosts[0]).toMatchObject({ lead_id: p.id, kind: 'reach_out', method: 'call' })
    expect(onOpenPerson).not.toHaveBeenCalled()
    await m.unmount()
  })

  it('Send still hands the person to onSendToJobber; hidden when jobber-linked', async () => {
    const p = person()
    const onSendToJobber = vi.fn()
    const m = await mount(inbox([p], { onSendToJobber }))
    await click(byLabel(m.host, 'Send to Jobber')!)
    expect(onSendToJobber).toHaveBeenCalledWith(p)
    await m.unmount()

    const linked = await mount(inbox([person({ jobberRef: '12345' })]))
    expect(byLabel(linked.host, 'Send to Jobber')).toBeFalsy()
    await linked.unmount()
  })

  it('More opens the existing overflow — Junk / Snooze / Dismiss intact (portaled past the card clip)', async () => {
    const m = await mount(inbox([person()]))
    await click(byLabel(m.host, 'More')!)
    const menu = document.querySelector('[data-bee-row-menu]')
    expect(menu, 'menu rides the portal to <body>').toBeTruthy()
    for (const label of ['Snooze until tomorrow', 'Snooze until next week', 'Dismiss', 'Mark as junk']) {
      expect([...menu!.querySelectorAll('button')].some(b => (b.textContent || '').trim() === label),
        `overflow must still offer "${label}"`).toBe(true)
    }
    await m.unmount()
  })
})

// ═══ phone line ════════════════════════════════════════════
describe('secondary-line phone', () => {
  it('renders a tel: link — digits-only href off phoneNormalized, formatted phone as the label', async () => {
    const m = await mount(inbox([person()]))
    const tel = m.host.querySelector('a[href="tel:5615550199"]')
    expect(tel, 'tel: href must be the digits-only phone_normalized value').toBeTruthy()
    expect(tel!.textContent).toContain('(561) 555-0199')
    await m.unmount()
  })

  it('falls back to a client-side digit strip when phoneNormalized is absent', async () => {
    const m = await mount(inbox([person({ phoneNormalized: null, phone: '(303) 555-0182' })]))
    expect(m.host.querySelector('a[href="tel:3035550182"]')).toBeTruthy()
    await m.unmount()
  })

  it('tapping the number dials — it does NOT open the PersonCard', async () => {
    const onOpenPerson = vi.fn()
    const m = await mount(inbox([person()], { onOpenPerson }))
    await click(m.host.querySelector('a[href^="tel:"]')!)
    expect(onOpenPerson).not.toHaveBeenCalled()
    await m.unmount()
  })

  it('phoneless lead: no tel: element at all, row still valid with chip + age', async () => {
    const m = await mount(inbox([person({ phone: '', phoneNormalized: null })]))
    expect(m.host.querySelector('a[href^="tel:"]')).toBeFalsy()
    expect(m.host.textContent).toContain('Sarah Mitchell')
    expect(m.host.textContent).toContain('New') // status chip
    expect(m.host.textContent).toMatch(/· 3d ago/) // adaptive age, still present
    await m.unmount()
  })
})

// ═══ row interaction ═══════════════════════════════════════
describe('row interaction', () => {
  it('row click still opens the PersonCard', async () => {
    const p = person()
    const onOpenPerson = vi.fn()
    const m = await mount(inbox([p], { onOpenPerson }))
    await click(m.host.querySelector('.bee-inbox-row')!)
    expect(onOpenPerson).toHaveBeenCalledWith(p)
    await m.unmount()
  })
})

// ═══ mapper wiring ═════════════════════════════════════════
describe('people-mapper', () => {
  it('phone_normalized → person.phoneNormalized (null when absent; display phone untouched)', () => {
    const base = { id: 'l1', location_id: 'kc', addresses: [] }
    const mapped = mapLeadToPerson({ ...base, phone: '(561) 555-0199', phone_normalized: '5615550199' } as any)
    expect(mapped.phoneNormalized).toBe('5615550199')
    expect(mapped.phone).toBe('(561) 555-0199')
    expect(mapLeadToPerson(base as any).phoneNormalized).toBeNull()
  })
})
