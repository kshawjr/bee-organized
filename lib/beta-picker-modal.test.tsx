// @vitest-environment happy-dom
//
// PickerModal (tag system 2A) — the ONE reusable lookup picker: a
// centered modal over a scrim, corporate group first then the
// location's own, search across both, allowCreate minting
// location-owned rows only. Staged selection: nothing leaves the modal
// until Save hands the picked options to onSave.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import PickerModal from '@/components/hive/shared/PickerModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Call = { url: string, method: string, body: any }
let calls: Call[] = []
let lookupsBody: any
let createFails: string | null = null
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })

const ROWS = [
  { id: 'corp-1', label: 'VIP', category: 'client_tags', location_id: null, is_active: true },
  { id: 'corp-2', label: 'HOA community', category: 'client_tags', location_id: null, is_active: true },
  { id: 'own-1', label: 'Lake house', category: 'client_tags', location_id: 'loc-1', is_active: true },
]

const installFetch = () => {
  calls = []; createFails = null
  lookupsBody = { lookups: ROWS, location: { id: 'loc-1', name: 'Denver' } }
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (method === 'POST') {
      const body = opts.body ? JSON.parse(opts.body) : null
      calls.push({ url: u, method, body })
      if (createFails) return jsonRes({ error: createFails }, 409)
      return jsonRes({ ok: true, lookup: { id: 'own-new', category: body.category, label: body.label, location_id: body.location_id, is_active: true } })
    }
    calls.push({ url: u, method, body: null })
    return jsonRes(lookupsBody)
  })
}
beforeEach(installFetch)

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
const typeIn = (el: Element, value: string) => act(async () => {
  const proto = (globalThis as any).window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = (el: Element, k: string) => act(async () => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
})
const btn = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const btnContaining = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').includes(text))
const rows = (host: Element) => [...host.querySelectorAll('[role="checkbox"], [role="radio"]')]

const props = (over: any = {}) => ({
  category: 'client_tags', locationId: 'loc-1', selected: [], mode: 'multi' as const,
  allowCreate: true, title: 'Tags', subtitle: 'sub', onSave: () => {}, onClose: () => {}, ...over,
})

describe('PickerModal — anatomy and scoping', () => {
  it('fetches the scoped vocabulary (category + location_id) and renders corporate first, then the location group by name', async () => {
    const { host, unmount } = await mount(<PickerModal {...props()} />)
    expect(calls[0].url).toContain('/api/lookups?')
    expect(calls[0].url).toContain('category=client_tags')
    expect(calls[0].url).toContain('location_id=loc-1')
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const text = dialog.textContent || ''
    expect(text).toContain('Corporate standard')
    expect(text).toContain("Denver's own")
    // corporate group renders BEFORE the location group
    expect(text.indexOf('Corporate standard')).toBeLessThan(text.indexOf("Denver's own"))
    expect(rows(host).map(r => r.textContent!.trim())).toEqual(['VIP', 'HOA community', 'Lake house'])
    await unmount()
  })

  it('search filters BOTH groups at once', async () => {
    const { host, unmount } = await mount(<PickerModal {...props()} />)
    await typeIn(host.querySelector('input[aria-label="Search options"]')!, 'o')
    // 'o' hits HOA community + Lake house, drops VIP
    expect(rows(host).map(r => r.textContent!.trim())).toEqual(['HOA community', 'Lake house'])
    await unmount()
  })

  it('staged selection: toggles write nothing; Save hands picked options to onSave and closes', async () => {
    let saved: any = null
    const onClose = vi.fn()
    const { host, unmount } = await mount(<PickerModal {...props({ onSave: (p: any) => { saved = p }, onClose })} />)
    await click(btnContaining(host, 'VIP')!)
    await click(btnContaining(host, 'Lake house')!)
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)
    await click(btn(host, 'Save')!)
    expect(saved.map((o: any) => o.id)).toEqual(['corp-1', 'own-1'])
    expect(onClose).toHaveBeenCalled()
    await unmount()
  })

  it('single mode: picking a second option replaces the first; onSave gets ONE option', async () => {
    let saved: any = 'unset'
    const { host, unmount } = await mount(<PickerModal {...props({ mode: 'single', onSave: (p: any) => { saved = p } })} />)
    await click(btnContaining(host, 'VIP')!)
    await click(btnContaining(host, 'HOA community')!)
    expect(host.querySelectorAll('[aria-checked="true"]')).toHaveLength(1)
    await click(btn(host, 'Save')!)
    expect(saved.id).toBe('corp-2')
    await unmount()
  })

  it('onSave rejection keeps the modal open and shows the error', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <PickerModal {...props({ onSave: async () => { throw new Error('nope') }, onClose })} />
    )
    await click(btnContaining(host, 'VIP')!)
    await click(btn(host, 'Save')!)
    expect(onClose).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Save failed: nope')
    await unmount()
  })
})

describe('PickerModal — allowCreate', () => {
  it('unmatched text offers the create row IN the location group; create POSTs with location_id and selects the new option', async () => {
    const { host, unmount } = await mount(<PickerModal {...props()} />)
    await typeIn(host.querySelector('input[aria-label="Search options"]')!, 'Snowbird')
    const createBtn = btnContaining(host, 'Create "Snowbird"')!
    expect(createBtn).toBeTruthy()
    await click(createBtn)
    const post = calls.find(c => c.method === 'POST')!
    expect(post.url).toContain('/api/lookups')
    expect(post.body).toEqual({ category: 'client_tags', label: 'Snowbird', location_id: 'loc-1' })
    // new option lands selected in the location group; search clears
    const checked = [...host.querySelectorAll('[aria-checked="true"]')]
    expect(checked.map(c => c.textContent!.trim())).toEqual(['Snowbird'])
    await unmount()
  })

  it('an exact label match (case-insensitive) hides the create row — no duplicate minting', async () => {
    const { host, unmount } = await mount(<PickerModal {...props()} />)
    await typeIn(host.querySelector('input[aria-label="Search options"]')!, 'vip')
    expect(btnContaining(host, 'Create')).toBeUndefined()
    await unmount()
  })

  it('Enter in the search field fires the create when the create row is showing', async () => {
    const { host, unmount } = await mount(<PickerModal {...props()} />)
    const input = host.querySelector('input[aria-label="Search options"]')!
    await typeIn(input, 'Snowbird')
    await key(input, 'Enter')
    expect(calls.find(c => c.method === 'POST')).toBeTruthy()
    await unmount()
  })

  it('a rejected create (409 duplicate) surfaces the error and mints nothing', async () => {
    createFails = 'label_already_exists'
    const { host, unmount } = await mount(<PickerModal {...props()} />)
    await typeIn(host.querySelector('input[aria-label="Search options"]')!, 'Snowbird')
    await click(btnContaining(host, 'Create "Snowbird"')!)
    expect(host.textContent).toContain('Create failed')
    expect(rows(host).map(r => r.textContent!.trim())).not.toContain('Snowbird')
    await unmount()
  })

  it('allowCreate=false never offers the row', async () => {
    const { host, unmount } = await mount(<PickerModal {...props({ allowCreate: false })} />)
    await typeIn(host.querySelector('input[aria-label="Search options"]')!, 'Snowbird')
    expect(btnContaining(host, 'Create')).toBeUndefined()
    await unmount()
  })
})

describe('PickerModal — maxSelected (the 8-specialty cap, told BEFORE save)', () => {
  it('the toggle past the cap is blocked with a message; Save passes only the capped set', async () => {
    let saved: any = null
    const { host, unmount } = await mount(<PickerModal {...props({ maxSelected: 2, onSave: (p: any) => { saved = p } })} />)
    await click(btnContaining(host, 'VIP')!)
    await click(btnContaining(host, 'HOA community')!)
    await click(btnContaining(host, 'Lake house')!) // third — blocked
    expect(host.textContent).toContain('Up to 2 can be selected')
    expect(host.querySelectorAll('[aria-checked="true"]')).toHaveLength(2)
    await click(btn(host, 'Save')!)
    expect(saved.map((o: any) => o.id)).toEqual(['corp-1', 'corp-2'])
    await unmount()
  })

  it('deselecting frees a slot again', async () => {
    const { host, unmount } = await mount(<PickerModal {...props({ maxSelected: 1 })} />)
    await click(btnContaining(host, 'VIP')!)
    await click(btnContaining(host, 'HOA community')!) // blocked
    expect(host.querySelectorAll('[aria-checked="true"]')).toHaveLength(1)
    await click(btnContaining(host, 'VIP')!)           // deselect
    await click(btnContaining(host, 'HOA community')!) // now fits
    const checked = [...host.querySelectorAll('[aria-checked="true"]')]
    expect(checked.map(c => c.textContent!.trim())).toEqual(['HOA community'])
    await unmount()
  })
})

describe('PickerModal — attrs.key selected values (partner tier/specialties storage)', () => {
  it('an incoming attrs.key slug checks its option and saves as that option object', async () => {
    lookupsBody = {
      lookups: [
        { id: 'uuid-re', label: 'Realtor', category: 'partner_specialties', location_id: null, is_active: true, attrs: { key: 'real-estate' } },
        { id: 'uuid-sl', label: 'Senior Living', category: 'partner_specialties', location_id: null, is_active: true, attrs: { key: 'senior-living' } },
      ],
      location: { id: 'loc-1', name: 'Denver' },
    }
    let saved: any = null
    const { host, unmount } = await mount(
      <PickerModal {...props({ category: 'partner_specialties', selected: ['real-estate'], onSave: (p: any) => { saved = p } })} />
    )
    const checked = [...host.querySelectorAll('[aria-checked="true"]')]
    expect(checked.map(c => c.textContent!.trim())).toEqual(['Realtor'])
    await click(btn(host, 'Save')!)
    expect(saved.map((o: any) => o.attrs.key)).toEqual(['real-estate'])
    await unmount()
  })
})

describe('PickerModal — keyboard + focus', () => {
  it('focus lands in the search field on open', async () => {
    const { host, unmount } = await mount(<PickerModal {...props()} />)
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="Search options"]'))
    await unmount()
  })

  it('Esc closes', async () => {
    const onClose = vi.fn()
    const { unmount } = await mount(<PickerModal {...props({ onClose })} />)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalled()
    await unmount()
  })
})
