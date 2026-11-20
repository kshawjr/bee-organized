// @vitest-environment happy-dom
//
// Network & Nurture, slice 9: the Clients Nurturing band follows the Network
// gate (Kevin chose option 3, 2026-11-20). Whoever can open the new Nurturing
// tab (super admins, until the un-grey) gets a short note instead of the band;
// everyone else keeps the band exactly as it was. Pinned here:
//   · an owner's Client List renders byte for byte what it rendered before
//   · with the band moved, every OTHER band shows the same people, same counts
//   · with the band moved, Show more never runs (no 18,830-row fetch)
//   · the list file is the slice 7 file plus exactly these lines
//   · the default is "keep the band": a mount that is not told keeps it
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientGroupedList from '@/components/hive/ClientGroupedList'
import { completeLoadProps, completeLoadFingerprints } from '@/lib/client-list-fingerprint.test.harness'
import before from '@/lib/__fixtures__/client-list-complete.before.json'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const store = (() => { let m: Record<string, string> = {}; return { getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: string) => { m[k] = String(v) }, removeItem: (k: string) => { delete m[k] }, clear: () => { m = {} }, key: () => null, length: 0 } })()
Object.defineProperty(window, 'localStorage', { configurable: true, value: store })

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

let host: HTMLDivElement
let root: any
beforeEach(() => { window.localStorage.clear(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const mount = async (props: any) => { await act(async () => { root.render(React.createElement(ClientGroupedList as any, props)) }); await act(async () => { await Promise.resolve() }) }
const headers = () => Array.from(host.querySelectorAll('[aria-label$=" group"]')) as HTMLElement[]
const openAll = async () => { for (const h of Array.from(host.querySelectorAll('[role="button"][aria-expanded="false"]'))) await act(async () => { (h as HTMLElement).click() }) }
// band → its count and the ids of its rows, read off the screen
const bands = () => Object.fromEntries(headers().map((h) => {
  const label = h.getAttribute('aria-label')!.replace(/ group$/, '')
  const count = Number((h.textContent || '').split('·')[1].replace(/[^0-9]/g, ''))
  const rows = Array.from(h.parentElement!.querySelectorAll('.bee-grp-row p[title]')).map((p) => p.getAttribute('title'))
  return [label, { count, rows }]
}))

describe('an owner (the band stays): nothing changed', () => {
  it('a fully loaded location renders byte for byte what it did before Show more existed', async () => {
    const fp = await completeLoadFingerprints()
    expect({ collapsed: fp.collapsed, expanded: fp.expanded, rows: fp.rows }).toEqual({ collapsed: (before as any).collapsed, expanded: (before as any).expanded, rows: (before as any).rows })
  })
  it('saying nurturingMoved={false} out loud is the same as not saying it', async () => {
    await mount({ ...completeLoadProps(), nurturingMoved: false })
    const a = host.innerHTML
    await act(async () => root.unmount()); root = createRoot(host)
    await mount(completeLoadProps())
    expect(host.innerHTML).toBe(a)
    expect(host.querySelector('[data-testid="clients-nurturing-moved"]')).toBeNull()
  })
})

describe('a super admin (Nurturing has moved): everyone else is still there', () => {
  it('every other band shows the same people and the same count; only Nurturing is gone, and the note says where', async () => {
    await mount(completeLoadProps()); await openAll()
    const was = bands()
    await act(async () => root.unmount()); root = createRoot(host)
    await mount({ ...completeLoadProps(), nurturingMoved: true }); await openAll()
    const now = bands()
    expect(was.Nurturing.count).toBe(3)
    expect(now.Nurturing).toBeUndefined()
    const { Nurturing, ...wasOthers } = was
    expect(now).toEqual(wasOthers)
    const total = (b: any) => Object.values(b).reduce((s: number, x: any) => s + x.count, 0)
    expect(total(now)).toBe(total(was) - was.Nurturing.count)
    expect(host.querySelector('[data-testid="clients-nurturing-moved"]')!.textContent).toContain('Nurturing has moved.')
  })
  it('a search says how many matches are Nurturing, and where they are', async () => {
    await mount({ ...completeLoadProps(), nurturingMoved: true })
    const input = host.querySelector('input[aria-label="Search clients"]') as HTMLInputElement
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Nurture'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(host.querySelector('[data-testid="clients-nurturing-moved-matches"]')!.textContent).toBe('3 who match are there.')
  })
  it('the button opens Nurturing', async () => {
    const onOpenNurturing = vi.fn()
    await mount({ ...completeLoadProps(), nurturingMoved: true, onOpenNurturing })
    await act(async () => { (host.querySelector('[data-testid="clients-open-nurturing"]') as HTMLElement).click() })
    expect(onOpenNurturing).toHaveBeenCalledTimes(1)
  })
})

describe('Philadelphia Suburbs: the 18,830-row Show more path', () => {
  const CUT = '2025-01-06T15:31:01.000Z'
  const person = (id: string, name: string) => ({ id, name, email: `${id}@x.com`, phone: '610-555-0000', locationId: 'L', created: '2026-03-01T10:00:00Z', tagIds: [], outreachTimeline: [], importSource: 'jobber_initial' })
  const loaded = Array.from({ length: 4902 }, (_, i) => person(`L${i}`, `Client ${String(i).padStart(5, '0')}`))
  const props = { people: loaded, engagements: [], locFilter: 'L', locations: [], tags: [], searchLocationId: 'L', leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: 13928 } }
  it('an owner: the band says 18,830 and opening it starts Show more, exactly as before', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ people: [], next: null }) }))
    ;(globalThis as any).fetch = fetchSpy
    await mount(props)
    expect(Number((headers()[0].textContent || '').split('·')[1].replace(/[^0-9]/g, ''))).toBe(18830)
    await act(async () => { headers()[0].click() }); await act(async () => { await Promise.resolve() })
    expect(fetchSpy.mock.calls.map((c: any) => String(c[0])).some((u) => u.startsWith('/api/clients/browse'))).toBe(true)
  })
  it('a super admin: no band, no Show more, and not one browse request, even with the band remembered open', async () => {
    window.localStorage.setItem('bee_hive_clients_collapsed', JSON.stringify({ Nurturing: true }))
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ people: [], next: null }) }))
    ;(globalThis as any).fetch = fetchSpy
    await mount({ ...props, nurturingMoved: true })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(headers()).toHaveLength(0)
    expect(host.querySelector('[data-testid="clients-show-more"]')).toBeNull()
    expect(host.querySelector('[data-testid="clients-nurturing-unlisted"]')).toBeNull()
    expect(fetchSpy.mock.calls.map((c: any) => String(c[0])).filter((u) => u.startsWith('/api/clients/browse'))).toEqual([])
  })
})

describe('by construction, not by remembering', () => {
  const HUB = read('components/BeeHub.jsx')
  it('the band follows the very same value that opens Network, for the role being acted as', () => {
    expect(HUB).toContain('const networkOpen = maySeeNewNetwork(role)')
    expect(HUB).toContain('nurturingMoved={networkOpen}')
    expect(HUB.match(/nurturingMoved=\{/g)).toHaveLength(2) // the App's Clients mount, and HiveScreen handing it on
  })
  it('every layer defaults to keeping the band: a mount not told otherwise keeps it', () => {
    expect(HUB).toContain("onReportProblem=()=>{}, nurturingMoved=false, onOpenNurturing=null }) {")
    expect(read('components/hive/HiveShell.jsx')).toContain('  nurturingMoved = false,\n')
    expect(read('components/hive/ClientGroupedList.jsx')).toMatch(/nurturingMoved = false, onOpenNurturing = null \}\) \{/)
  })
})

describe('the list file is the slice 7 file plus exactly these lines', () => {
  it('undoing slice 9 gives back ClientGroupedList.jsx byte for byte as it was at 8fd6ba7', () => {
    const steps: [string, string][] = [
      [`// NURTURING HAS MOVED (Network & Nurture slice 9, Kevin 2026-11-20): when
// \`nurturingMoved\` is true the Nurturing band is not drawn and Show more never
// runs; a short note points to Network & Nurture › Nurturing clients instead.
// The host passes it from THE SAME gate that opens Network (lib/network/
// access.ts, for the role being acted as), so the band disappears for exactly
// whoever can see the new tab. It defaults to false: anywhere that is not
// told otherwise keeps the band, so no owner can lose it by accident.
`, ''],
      [', nurturingMoved = false, onOpenNurturing = null }) {', ' }) {'],
      ['  const canBrowse = !nurturingMoved && !!leadsTruncated', '  const canBrowse = !!leadsTruncated'],
      [`  // The Nurturing people this list holds but does not draw when Nurturing has moved.
  const movedCount = nurturingMoved ? (groups.get(BROWSE_BAND) || []).length : 0
  const totalShown = visible.length - movedCount
`, '  const totalShown = visible.length\n'],
      ['  const notListed = !nurturingMoved && leadsTruncated', '  const notListed = leadsTruncated'],
    ]
    let s = read('components/hive/ClientGroupedList.jsx')
    for (const [now, was] of steps) { expect(s.split(now).length - 1, now.slice(0, 50)).toBe(1); s = s.replace(now, was) }
    const a = s.indexOf('        if (nurturingMoved && statusKey === BROWSE_BAND) {')
    const b = s.indexOf('        const listed = groups.get(statusKey) || []')
    expect(a).toBeGreaterThan(0)
    s = s.slice(0, a) + s.slice(b)
    expect(sha(s)).toBe('1fc2b08317a73fbd5ed9c7e27c8905597e3d863de8b972694963d5db20904aae')
  })
})
