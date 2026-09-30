// @vitest-environment happy-dom
//
// An overlay closes ONLY by its X, the caller's own Close / Cancel, or
// (phone) a deliberate swipe down on the sheet handle — never by a stray
// click on the dimmed backdrop (Kevin, 2026-09-29: "I open a record,
// click somewhere else, and it closes"). That stray click used to unmount
// the record and drop whatever was half-typed in it.
//
// Pinned here, both ways:
//   · OverlayShell (desktop modal + phone sheet): backdrop → no close;
//     X → close; swipe down → close; Esc → the shell does nothing (each
//     caller owns Esc, unchanged — the cards use it to cancel inline edits)
//   · the client card and the engagement panel: backdrop → still open,
//     half-typed buzz note still there; X → close
//   · the close wizards (WizardShell): backdrop → no close; X and the
//     wizard's own Cancel → close
//   · the ··· menus inside the records (2026-09-30: nothing closes on an
//     outside click anywhere — see beta-no-outside-close): an outside
//     click leaves the menu AND the record open; the ··· again closes
//     the menu, never the record.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import OverlayShell from '@/components/hive/OverlayShell'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { WizardShell } from '@/components/hive/shared/CloseWizardKit'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

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
const escape = () => act(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
})
const typeIn = (el: Element, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const touch = (el: Element, type: 'touchstart' | 'touchend', clientY: number) => act(async () => {
  const ev: any = new Event(type, { bubbles: true, cancelable: true })
  const pts = [{ clientY }]
  Object.defineProperty(ev, 'touches', { value: type === 'touchstart' ? pts : [] })
  Object.defineProperty(ev, 'changedTouches', { value: pts })
  el.dispatchEvent(ev)
})
const btn = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const backdrop = (host: Element) => host.querySelector('[data-overlay-backdrop]')!
const closeX = (host: Element) => host.querySelector('[data-overlay-backdrop] button[aria-label="Close"]')!

// ── fetch stub for the two real records ────────────────────────
const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
const profileBody = {
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(400), source: 'Webform', paused: false, marketing_opt_out: false,
    snoozed_until: null, snoozed_note: null, assigned_to: null, assigned_to_name: null,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Denver',
  },
  referred_us: [], contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { lifetime_paid: 0, invoiced: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
}
const engBody = {
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual',
    created_at: daysAgo(30), stage_entered_at: daysAgo(30), location_uuid: 'loc-uuid-1',
    project_type: null, description: null, closed_at: null, closed_reason: null, closed_note: null,
    total_invoiced: 0, total_paid: 0, balance_owing: 0,
  },
  children: { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] },
  drip: null,
  client: {
    id: 'lead-9', name: 'Dana Client', location_name: 'Denver', email: 'dana@x.com', phone: null,
    address: null, city: null, state: null, zip: null, request_details: null, source: null,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0,
  },
}
beforeEach(() => {
  document.body.innerHTML = ''
  ;(globalThis as any).fetch = vi.fn(async (url: any) => {
    const u = String(url)
    if (u.includes('/api/lookups')) return jsonRes({ lookups: [], location: { id: 'loc-1', name: 'Denver' } })
    if (u.includes('/api/engagements/')) return jsonRes(engBody)
    if (u.includes('/profile')) return jsonRes(profileBody)
    return jsonRes({})
  })
})

// ═══ the shell itself ══════════════════════════════════════════
describe.each([
  ['desktop modal', false],
  ['phone sheet', true],
])('OverlayShell — %s', (_label, isMobile) => {
  it('a click on the backdrop does NOT close it', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<OverlayShell isMobile={isMobile} onClose={onClose}><p>body</p></OverlayShell>)
    await click(backdrop(host))
    expect(onClose).not.toHaveBeenCalled()
    await unmount()
  })

  it('the X closes it — exactly once', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<OverlayShell isMobile={isMobile} onClose={onClose}><p>body</p></OverlayShell>)
    await click(closeX(host))
    expect(onClose).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('Escape: the shell does nothing — each caller owns Esc, as before', async () => {
    const onClose = vi.fn()
    const { unmount } = await mount(<OverlayShell isMobile={isMobile} onClose={onClose}><p>body</p></OverlayShell>)
    await escape()
    expect(onClose).not.toHaveBeenCalled()
    await unmount()
  })
})

describe('OverlayShell — phone sheet swipe', () => {
  const handleRow = (host: Element) => closeX(host).parentElement!

  it('a deliberate swipe DOWN on the handle still closes it', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<OverlayShell isMobile onClose={onClose}><p>body</p></OverlayShell>)
    await touch(handleRow(host), 'touchstart', 100)
    await touch(handleRow(host), 'touchend', 200)
    expect(onClose).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('a short nudge on the handle does not', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<OverlayShell isMobile onClose={onClose}><p>body</p></OverlayShell>)
    await touch(handleRow(host), 'touchstart', 100)
    await touch(handleRow(host), 'touchend', 130)
    expect(onClose).not.toHaveBeenCalled()
    await unmount()
  })
})

// ═══ Kevin's case: the client card and the engagement panel ═══
describe('client card (ClientProfile)', () => {
  it('a click outside leaves it open, with a half-typed buzz note intact; X closes it', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <ClientProfile clientId="lead-9" people={[]} onClose={onClose} setToast={() => {}} />
    )
    expect(host.textContent).toContain('Dana Client')
    await click(btn(host, 'Add a note about this client')!)
    const note = () => host.querySelector('input[aria-label="Add buzz note"]') as HTMLInputElement | null
    await typeIn(note()!, 'Gate code is 4471')

    await click(backdrop(host))
    expect(onClose).not.toHaveBeenCalled()
    expect(note()?.value).toBe('Gate code is 4471')

    await escape()
    expect(onClose).not.toHaveBeenCalled() // Esc never closed the card; still doesn't

    await click(closeX(host))
    expect(onClose).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('the card ··· menu stays open on an outside click; the ··· again closes it — the card stays open throughout', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <ClientProfile clientId="lead-9" people={[]} onClose={onClose} setToast={() => {}} />
    )
    const menuBtn = host.querySelector('button[aria-label="More"]')
    expect(menuBtn, 'card ··· menu trigger').toBeTruthy()
    const menuOpen = () => menuBtn!.parentElement!.children.length > 1
    await click(menuBtn!)
    expect(menuOpen(), 'card ··· menu should be open').toBe(true)
    await click(backdrop(host))
    expect(menuOpen()).toBe(true)
    await click(menuBtn!)
    expect(menuOpen()).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    await unmount()
  })
})

describe('engagement panel (EngagementPanel)', () => {
  it('a click outside leaves it open; X closes it', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={onClose} setToast={() => {}} />
    )
    expect(host.textContent).toContain('Kitchen + Pantry')
    await click(backdrop(host))
    expect(onClose).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Kitchen + Pantry')
    await click(closeX(host))
    expect(onClose).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('its ··· menu stays open on an outside click; the ··· again closes it — the panel stays open throughout', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={onClose} setToast={() => {}} />
    )
    const trigger = host.querySelector('button[aria-label="Engagement actions"]')
    expect(trigger, 'engagement ··· menu trigger').toBeTruthy()
    await click(trigger!)
    expect(document.querySelector('[data-bee-record-menu]')).toBeTruthy()
    await click(backdrop(host))
    expect(document.querySelector('[data-bee-record-menu]')).toBeTruthy()
    await click(trigger!)
    expect(document.querySelector('[data-bee-record-menu]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await unmount()
  })
})

// ═══ the close wizards ═════════════════════════════════════════
describe('close wizards (WizardShell)', () => {
  it('backdrop does not close; X and the wizard\'s own Cancel do', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <WizardShell isMobile={false} onClose={onClose} title="Close as lost"
        footer={<button onClick={onClose}>Cancel</button>}>
        <p>step body</p>
      </WizardShell>
    )
    await click(backdrop(host))
    expect(onClose).not.toHaveBeenCalled()
    await click(btn(host, 'Cancel')!)
    expect(onClose).toHaveBeenCalledTimes(1)
    await click(closeX(host))
    expect(onClose).toHaveBeenCalledTimes(2)
    await unmount()
  })
})
