// @vitest-environment happy-dom
// Inbox soft row actions — Mark as junk / Snooze / Dismiss (the ···
// overflow). Covers:
//   - junk: PATCH is_junk=true, instant row removal, the junkedIds Set
//     HOLDS across a simulated Realtime re-insert, undo restores
//   - snooze: PATCH future snoozed_until (date-only string), NO stage
//     write (Classic's snooze→Nurturing coupling must not trip),
//     future-snoozed rows skipped from props, undo clears
//   - dismiss: PATCH inbox_dismissed_at, system touchpoint logged,
//     row leaves the Inbox BUT the person still reads as their real
//     derived status in the Client Directory (inbox-scoped, truthful),
//     undo clears
//   - the junk-stops-drips / dismiss-keeps-drips asymmetry (source
//     guard: drip-lifecycle knows is_junk, never inbox_dismissed_at)
//   - mapper + PATCHABLE_FIELDS wiring for inbox_dismissed_at
//   - row-click still opens the PersonCard; ··· does not
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import ClientDirectory from '@/components/hive/ClientDirectory'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import { mapLeadToPerson } from '@/lib/people-mapper'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()
const daysAhead = (n: number) => new Date(now + n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
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
const jsonRes = (body: any, status = 200) => ({
  ok: status < 400, status,
  json: async () => body,
})
let patches: Array<{ id: string; body: any }> = []
let touchpointPosts: any[] = []
const installFetch = () => {
  patches = []
  touchpointPosts = []
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (/\/api\/leads\/[^/]+$/.test(u) && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body)
      patches.push({ id: u.split('/').pop()!, body })
      return jsonRes({ lead: { id: u.split('/').pop(), ...body } })
    }
    if (u.includes('/api/touchpoints') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      touchpointPosts.push(body)
      return jsonRes({ touchpoint: { id: 'tp-1', ...body } }, 201)
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
  return {
    host,
    rerender: async (next: React.ReactElement) => { await act(async () => { root.render(next) }) },
    unmount: async () => { await act(async () => root.unmount()); host.remove() },
  }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)

// The undo toast's msg is a React node: <span>text · <button onClick={undo}>Undo</button></span>.
// It renders in BeeHub scope; here we invoke the handler off the element.
const clickUndo = async (toast: any) => {
  const kids = React.Children.toArray(toast.msg.props.children) as any[]
  const btn = kids.find(k => k?.type === 'button')
  expect(btn, 'undo toast should carry an Undo button').toBeTruthy()
  await act(async () => { await btn.props.onClick() })
}

let lastToast: any = null
const setToast = (t: any) => { lastToast = t }

const inbox = (people: any[], over: any = {}) => (
  <InboxScreen people={people} engagements={[]} locFilter="all" setToast={setToast} {...over} />
)

const openMenuAnd = async (host: Element, label: string) => {
  await click(buttonByText(host, '···')!)
  await click(buttonByText(host, label)!)
}

beforeEach(() => {
  installFetch()
  lastToast = null
  ;(globalThis as any).window?.localStorage?.clear?.()
})

// ═══ junk ══════════════════════════════════════════════════
describe('Mark as junk', () => {
  it('PATCHes is_junk=true, removes the row instantly, undo restores', async () => {
    const p = person()
    const m = await mount(inbox([p]))
    expect(m.host.textContent).toContain('Sarah Mitchell')

    await openMenuAnd(m.host, 'Mark as junk')

    expect(patches).toEqual([{ id: p.id, body: { is_junk: true } }])
    expect(m.host.textContent).not.toContain('Sarah Mitchell')

    await clickUndo(lastToast)
    expect(patches[1]).toEqual({ id: p.id, body: { is_junk: false } })
    expect(m.host.textContent).toContain('Sarah Mitchell')
    await m.unmount()
  })

  it('junkedIds HOLDS across a simulated Realtime re-insert (stale isJunk:false row)', async () => {
    const p = person()
    const m = await mount(inbox([p]))
    await openMenuAnd(m.host, 'Mark as junk')
    expect(m.host.textContent).not.toContain('Sarah Mitchell')

    // Realtime refetch re-inserts a FRESH person object for the same id —
    // worst case it races the PATCH and still says isJunk:false. The
    // session Set must keep the row out regardless.
    await m.rerender(inbox([{ ...person(), id: p.id, isJunk: false }]))
    expect(m.host.textContent).not.toContain('Sarah Mitchell')
    await m.unmount()
  })

  it('rows arriving already junked are skipped without any session state', async () => {
    const m = await mount(inbox([person({ isJunk: true })]))
    expect(m.host.textContent).not.toContain('Sarah Mitchell')
    await m.unmount()
  })
})

// ═══ snooze ════════════════════════════════════════════════
describe('Snooze', () => {
  it('PATCHes a future date-only snoozed_until with NO stage write, undo clears', async () => {
    const p = person()
    const m = await mount(inbox([p]))

    await openMenuAnd(m.host, 'Snooze until tomorrow')

    expect(patches).toHaveLength(1)
    const body = patches[0].body
    expect(Object.keys(body)).toEqual(['snoozed_until']) // no stage, no note — Classic's coupling untouched
    expect(body.snoozed_until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(new Date(body.snoozed_until).getTime()).toBeGreaterThan(now)
    expect(m.host.textContent).not.toContain('Sarah Mitchell')

    await clickUndo(lastToast)
    expect(patches[1]).toEqual({ id: p.id, body: { snoozed_until: null } })
    expect(m.host.textContent).toContain('Sarah Mitchell')
    await m.unmount()
  })

  it('"Snooze until next week" lands ~7 days out', async () => {
    const m = await mount(inbox([person()]))
    await openMenuAnd(m.host, 'Snooze until next week')
    const t = new Date(patches[0].body.snoozed_until).getTime()
    expect(t).toBeGreaterThan(now + 5 * 86400000)
    expect(t).toBeLessThan(now + 9 * 86400000)
    await m.unmount()
  })

  it('future-snoozed rows from props are skipped; past snoozes surface again', async () => {
    const future = person({ name: 'Future Snooze', snoozeUntil: daysAhead(3).slice(0, 10) })
    const past = person({ name: 'Woken Up', snoozeUntil: daysAgo(3).slice(0, 10) })
    const m = await mount(inbox([future, past]))
    expect(m.host.textContent).not.toContain('Future Snooze')
    expect(m.host.textContent).toContain('Woken Up')
    await m.unmount()
  })
})

// ═══ dismiss ═══════════════════════════════════════════════
describe('Dismiss', () => {
  it('PATCHes inbox_dismissed_at, logs a system touchpoint, undo clears', async () => {
    const p = person()
    const m = await mount(inbox([p]))

    await openMenuAnd(m.host, 'Dismiss')

    expect(patches).toHaveLength(1)
    const iso = patches[0].body.inbox_dismissed_at
    expect(Math.abs(new Date(iso).getTime() - Date.now())).toBeLessThan(60000)
    expect(m.host.textContent).not.toContain('Sarah Mitchell')

    // Audit trail — mirrors the resurrection log shape.
    expect(touchpointPosts).toHaveLength(1)
    expect(touchpointPosts[0]).toMatchObject({
      lead_id: p.id, kind: 'system', method: 'system',
    })
    expect(touchpointPosts[0].label).toContain('Dismissed from Inbox')

    await clickUndo(lastToast)
    expect(patches[1]).toEqual({ id: p.id, body: { inbox_dismissed_at: null } })
    expect(m.host.textContent).toContain('Sarah Mitchell')
    await m.unmount()
  })

  it('dismissed rows leave the Inbox but STILL appear in the Client Directory as their real status', async () => {
    const p = person({ inboxDismissedAt: daysAgo(1) })

    const inboxMount = await mount(inbox([p]))
    expect(inboxMount.host.textContent).not.toContain('Sarah Mitchell')
    await inboxMount.unmount()

    // Directory is blind to the column — the person reads as derived New.
    expect(deriveClientStatus(p, new Set(), now)).toBe('New')
    const dir = await mount(
      <ClientDirectory people={[p]} engagements={[]} locFilter="all" />
    )
    expect(dir.host.textContent).toContain('Sarah Mitchell')
    await dir.unmount()
  })

  it('restore semantics: a dismissed lead past 30d derives Nurturing, not New (no Inbox promise)', () => {
    // Dismissed day 25, restored day 35 — clearing inbox_dismissed_at
    // does NOT re-enter the Inbox; the derived status decides.
    const aged = person({ created: daysAgo(35), inboxDismissedAt: null })
    expect(deriveClientStatus(aged, new Set(), now)).toBe('Nurturing')
  })
})

// ═══ wiring + asymmetry guards ═════════════════════════════
describe('wiring', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('mapper: inbox_dismissed_at → person.inboxDismissedAt (null when absent)', () => {
    const base = { id: 'l1', location_id: 'kc', addresses: [] }
    expect(mapLeadToPerson({ ...base, inbox_dismissed_at: '2026-07-01T00:00:00Z' } as any).inboxDismissedAt)
      .toBe('2026-07-01T00:00:00Z')
    expect(mapLeadToPerson(base as any).inboxDismissedAt).toBeNull()
  })

  it('PATCHABLE_FIELDS carries inbox_dismissed_at', () => {
    expect(src('app/api/leads/[id]/route.ts')).toMatch(/'inbox_dismissed_at'/)
  })

  it('asymmetry: drip lifecycle stops on junk and NEVER learns the dismiss column', () => {
    const drip = src('lib/drip-lifecycle.ts')
    expect(drip).toMatch(/is_junk/)          // junk → stop drips (existing branch)
    expect(drip).not.toMatch(/inbox_dismissed/) // dismiss keeps nurturing
  })

  it('deriveClientStatus stays blind to all three soft-removal signals', () => {
    const cs = src('components/hive/shared/clientStatus.js')
    expect(cs).not.toMatch(/inboxDismissed|snoozeUntil|isJunk/)
  })
})

// ═══ interaction idioms ════════════════════════════════════
describe('row interaction', () => {
  it('row click still opens the PersonCard; ··· does not', async () => {
    const p = person()
    const onOpenPerson = vi.fn()
    const m = await mount(inbox([p], { onOpenPerson }))

    await click(buttonByText(m.host, '···')!)
    expect(onOpenPerson).not.toHaveBeenCalled()

    await click(m.host.querySelector('.bee-inbox-row')!)
    expect(onOpenPerson).toHaveBeenCalledWith(p)
    await m.unmount()
  })

  it('menu actions never bubble into onOpenPerson', async () => {
    const onOpenPerson = vi.fn()
    const m = await mount(inbox([person()], { onOpenPerson }))
    await openMenuAnd(m.host, 'Dismiss')
    expect(onOpenPerson).not.toHaveBeenCalled()
    await m.unmount()
  })
})
