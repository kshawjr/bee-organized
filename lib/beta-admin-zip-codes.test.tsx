// @vitest-environment happy-dom
//
// Admin → Zip codes screen (components/admin/AdminZipCodesScreen.jsx),
// mounted for real with fetch stubbed:
//   • renders the counts and the conflicts card first
//   • resolve → POST /resolve with the kept location
//   • add → POST with zip + location
//   • edit → PATCH (moving a zip's location from the find box)
//   • remove → DELETE ?id=
//   • it is in the admin sidebar, behind the corporate gate
//   • tokens only — no color literal of its own
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import AdminZipCodesScreen from '@/components/admin/AdminZipCodesScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SCREEN_SRC = readFileSync('components/admin/AdminZipCodesScreen.jsx', 'utf8')
const BEEHUB_SRC = readFileSync('components/BeeHub.jsx', 'utf8')

const LOCS = [
  { id: 'L-central', name: 'Central Denver', location_id: 'loc_centraldenver', lifecycle_status: 'onboarding' },
  { id: 'L-denver', name: 'Denver', location_id: 'loc_denver', lifecycle_status: 'onboarding' },
  { id: 'L-omaha', name: 'Omaha', location_id: 'loc_omaha', lifecycle_status: 'active' },
]
const ZIPS = [
  { id: 'z-a', zip: '80203', location_uuid: 'L-denver' },
  { id: 'z-b', zip: '80203', location_uuid: 'L-central' },
  { id: 'z-c', zip: '68007', location_uuid: 'L-omaha' },
]

let calls: { method: string; url: string; body: any }[] = []
const stub = () => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    const method = init.method || 'GET'
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null })
    if (method === 'GET') return { ok: true, json: async () => ({ zips: ZIPS, locations: LOCS }) }
    return { ok: true, json: async () => ({ conflict: false }) }
  }))
}

const mount = async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<AdminZipCodesScreen />) })
  await act(async () => {})
  return host
}
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }) }
const setValue = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const buttonByText = (host: Element, text: string) =>
  Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text)!
const writes = () => calls.filter(c => c.method !== 'GET')

beforeEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  stub()
  vi.stubGlobal('confirm', () => true)
})

describe('view', () => {
  it('shows the counts and lists the conflict first', async () => {
    const host = await mount()
    expect(host.textContent).toContain('2 zips · 3 locations · 1 in conflict')
    const conflicts = host.querySelector('[data-testid="zip-conflicts"]')!
    expect(conflicts.textContent).toContain('80203')
    expect(conflicts.textContent).toContain('Denver vs Central Denver')
  })
})

describe('resolve', () => {
  it('“Give to Central Denver” → POST /resolve keeping that location', async () => {
    const host = await mount()
    await click(buttonByText(host, 'Give to Central Denver'))
    expect(writes()).toEqual([
      { method: 'POST', url: '/api/admin/location-zips/resolve', body: { zip: '80203', location_uuid: 'L-central' } },
    ])
  })

  it('cancelling the confirm sends nothing', async () => {
    vi.stubGlobal('confirm', () => false)
    const host = await mount()
    await click(buttonByText(host, 'Give to Denver'))
    expect(writes()).toEqual([])
  })
})

describe('add', () => {
  it('zip + location → POST', async () => {
    const host = await mount()
    await setValue(host.querySelector('input[aria-label="Zip code"]') as HTMLInputElement, '68010')
    await setValue(host.querySelector('select[aria-label="Location"]') as HTMLSelectElement, 'L-omaha')
    await click(buttonByText(host, 'Add'))
    expect(writes()).toEqual([
      { method: 'POST', url: '/api/admin/location-zips', body: { zip: '68010', location_uuid: 'L-omaha' } },
    ])
  })
})

describe('edit and remove (find by zip)', () => {
  it('changing a zip’s location → PATCH that row', async () => {
    const host = await mount()
    await setValue(host.querySelector('input[aria-label="Find a zip or location"]') as HTMLInputElement, '680')
    const sel = host.querySelector('select[aria-label="Location for 68007"]') as HTMLSelectElement
    expect(sel).toBeTruthy()
    await setValue(sel, 'L-denver')
    expect(writes()).toEqual([
      { method: 'PATCH', url: '/api/admin/location-zips', body: { id: 'z-c', location_uuid: 'L-denver' } },
    ])
  })

  it('Remove → DELETE ?id=', async () => {
    const host = await mount()
    await setValue(host.querySelector('input[aria-label="Find a zip or location"]') as HTMLInputElement, '68007')
    const hits = host.querySelector('[data-testid="zip-hits"]')!
    await click(buttonByText(hits, 'Remove'))
    expect(writes()).toEqual([{ method: 'DELETE', url: '/api/admin/location-zips?id=z-c', body: null }])
  })

  it('a zip nobody holds says it goes to Other', async () => {
    const host = await mount()
    await setValue(host.querySelector('input[aria-label="Find a zip or location"]') as HTMLInputElement, '999')
    expect(host.textContent).toContain('No location holds a zip starting 999')
  })
})

describe('wiring', () => {
  it('is in the admin sidebar behind the corporate gate (showFeedback: super_admin | corporate | admin)', () => {
    expect(BEEHUB_SRC).toContain('import AdminZipCodesScreen from "@/components/admin/AdminZipCodesScreen"')
    expect(BEEHUB_SRC).toMatch(/\.\.\.\(showFeedback \? \[\{ key:'zips', label:'Zip codes'/)
    expect(BEEHUB_SRC).toMatch(/case 'zips':[\s\S]{0,300}showFeedback \? <AdminZipCodesScreen \/>/)
  })

  it('tokens only — no hex/rgba literal in the screen', () => {
    expect(/#[0-9a-fA-F]{3,8}\b/.test(SCREEN_SRC)).toBe(false)
    expect(/rgba?\(/.test(SCREEN_SRC)).toBe(false)
  })
})
