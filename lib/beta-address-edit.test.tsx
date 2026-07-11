// @vitest-environment happy-dom
//
// Inline address editing — UI half (shared/AddressField, mounted on
// ClientProfile + EngagementPanel Key Facts). Under test:
//
//   * display normalization: the stored `address` string already carries
//     city/state/zip (import convention) — render it ONCE (Wendy Blanch
//     duplication bug); legacy street-only rows get the parts appended
//   * inline-edit standard composition: EditPencil in view mode, ✓/✗
//     beside the inputs, in-flight disables the pair, failed save keeps
//     the edit open with the draft
//   * save: ✓ → ONE PATCH { address (composed full string), city,
//     state, zip }; cancel (✗ / Esc) → zero writes
//   * autocomplete pick → parsed {street, city, state, zip} fill the
//     part fields; manual typing is a first-class fallback when Places
//     is down (or GOOGLE_PLACES_API_KEY is absent server-side)
//   * toast tells the whole truth from address_writeback:
//     updated/added → '· synced to Jobber'; failed → '· Jobber sync
//     failed — saved in Bee Hub only'; absent → plain
//   * propagation: leadColsToPersonFields maps the composed address col
//     onto the Person shape (city/state/zip deliberately dropped)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import AddressField from '@/components/hive/shared/AddressField'
import { leadColsToPersonFields } from '@/components/hive/shared/leadPatchMap'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const WENDY = {
  address: '29659 Calle Violeta, Temecula, California, 92592',
  city: 'Temecula',
  state: 'California',
  zip: '92592',
}

// ── DOM helpers (the beta-inline-edit-standard idiom) ───────────
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
const mousedown = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
})
const type = (el: Element, value: string) => act(async () => {
  const proto = (globalThis as any).window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = (el: Element, k: string) => act(async () => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
})
const sleep = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

const saveBtn = (host: Element) => host.querySelector('button[aria-label="Save"]') as HTMLButtonElement | null
const cancelBtn = (host: Element) => host.querySelector('button[aria-label="Cancel"]') as HTMLButtonElement | null
const pencil = (host: Element) => host.querySelector('.bee-edit-pencil') as HTMLElement | null
const input = (host: Element, label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null
const streetInput = (host: Element) => host.querySelector('input[placeholder="Start typing a street address…"]') as HTMLInputElement | null

let leadPatches: any[]
let toasts: any[]
let savedCols: any[]

const installFetch = ({
  patchJson = {} as any,
  patchOk = true,
  placesFail = false,
  predictions = [] as any[],
  details = null as any,
} = {}) => {
  leadPatches = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/leads/') && opts.method === 'PATCH') {
      leadPatches.push(JSON.parse(opts.body))
      return { ok: patchOk, status: patchOk ? 200 : 500, json: async () => (patchOk ? { lead: {}, ...patchJson } : { error: 'nope' }) }
    }
    if (u.includes('/api/places/autocomplete')) {
      if (placesFail) return { ok: false, status: 500, json: async () => ({ error: 'Places API not configured' }) }
      return { ok: true, status: 200, json: async () => ({ predictions }) }
    }
    if (u.includes('/api/places/details')) {
      if (!details) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => details }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

const mountField = (value: any = WENDY) => {
  toasts = []
  savedCols = []
  return mount(
    <AddressField leadId="lead-1" value={value}
      onSaved={(cols: any, j: any) => savedCols.push({ cols, j })}
      setToast={(t: any) => toasts.push(t)} />
  )
}

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

// ── display normalization ───────────────────────────────────────
describe('AddressField view mode — normalized display', () => {
  it('full stored string renders ONCE (Wendy Blanch: no duplicated city/state/zip)', async () => {
    installFetch()
    const { host, unmount } = await mountField()
    expect(host.textContent).toContain('29659 Calle Violeta, Temecula, California, 92592')
    // the duplication shape: "…, 92592, Temecula…" must be gone
    expect(host.textContent).not.toMatch(/92592.*Temecula/)
    expect((host.textContent!.match(/Temecula/g) || []).length).toBe(1)
    await unmount()
  })

  it('legacy street-only row appends the part columns', async () => {
    installFetch()
    const { host, unmount } = await mountField({ address: '123 Main St', city: 'Denver', state: 'CO', zip: '80202' })
    expect(host.textContent).toContain('123 Main St, Denver, CO 80202')
    await unmount()
  })

  it('wears the standard pencil; empty state offers the dashed add slot', async () => {
    installFetch()
    const a = await mountField()
    expect(pencil(a.host)).toBeTruthy()
    await a.unmount()
    const b = await mountField({ address: null, city: null, state: null, zip: null })
    expect(b.host.textContent).toContain('add address')
    await b.unmount()
  })
})

// ── edit / save / cancel ────────────────────────────────────────
describe('AddressField edit mode — save and cancel', () => {
  it('open prefills street (derived) + parts; ✓ saves ONE PATCH with the composed address', async () => {
    installFetch()
    const { host, unmount } = await mountField()
    await click(host.querySelector('p')!)
    expect(streetInput(host)!.value).toBe('29659 Calle Violeta')
    expect(input(host, 'City')!.value).toBe('Temecula')
    await type(streetInput(host)!, '500 Oak Ave')
    await type(input(host, 'City')!, 'Austin')
    await type(input(host, 'State')!, 'TX')
    await type(input(host, 'ZIP')!, '78701')
    await click(saveBtn(host)!)
    expect(leadPatches).toEqual([{
      address: '500 Oak Ave, Austin, TX, 78701',
      city: 'Austin', state: 'TX', zip: '78701',
    }])
    expect(streetInput(host)).toBeNull() // closed
    expect(savedCols).toHaveLength(1)
    expect(savedCols[0].cols.address).toBe('500 Oak Ave, Austin, TX, 78701')
    await unmount()
  })

  it('✗ cancels with ZERO writes; Esc cancels too', async () => {
    installFetch()
    const { host, unmount } = await mountField()
    await click(host.querySelector('p')!)
    await type(streetInput(host)!, 'abandoned')
    await click(cancelBtn(host)!)
    expect(leadPatches).toEqual([])
    expect(host.textContent).toContain('29659 Calle Violeta')
    await click(host.querySelector('p')!)
    await key(input(host, 'City')!, 'Escape')
    expect(streetInput(host)).toBeNull()
    expect(leadPatches).toEqual([])
    await unmount()
  })

  it('no-change save closes silently (normalized compare — zero writes)', async () => {
    installFetch()
    const { host, unmount } = await mountField()
    await click(host.querySelector('p')!)
    await click(saveBtn(host)!)
    expect(leadPatches).toEqual([])
    expect(streetInput(host)).toBeNull()
    expect(toasts).toEqual([])
    await unmount()
  })

  it('parts without a street → quiet inline error, no junk PATCH', async () => {
    installFetch()
    const { host, unmount } = await mountField({ address: null, city: null, state: null, zip: null })
    await click(host.querySelector('p')!)
    await type(input(host, 'City')!, 'Austin')
    await click(saveBtn(host)!)
    expect(host.textContent).toContain('Enter a street address')
    expect(leadPatches).toEqual([])
    await unmount()
  })

  it('clearing everything saves nulls (Address removed, Bee Hub only)', async () => {
    installFetch()
    const { host, unmount } = await mountField()
    await click(host.querySelector('p')!)
    await type(streetInput(host)!, '')
    await type(input(host, 'City')!, '')
    await type(input(host, 'State')!, '')
    await type(input(host, 'ZIP')!, '')
    await click(saveBtn(host)!)
    expect(leadPatches).toEqual([{ address: null, city: null, state: null, zip: null }])
    expect(toasts[0].msg).toBe('Address removed')
    await unmount()
  })

  it('failed PATCH keeps the edit open with the inline error, draft intact', async () => {
    installFetch({ patchOk: false })
    const { host, unmount } = await mountField()
    await click(host.querySelector('p')!)
    await type(streetInput(host)!, '500 Oak Ave')
    await click(saveBtn(host)!)
    expect(streetInput(host)).toBeTruthy()
    expect(streetInput(host)!.value).toBe('500 Oak Ave')
    expect(host.textContent).toContain('Save failed: nope')
    await unmount()
  })
})

// ── autocomplete + manual fallback ──────────────────────────────
describe('AddressField — Places autocomplete and the manual fallback', () => {
  it('pick a prediction → /details parse fills street/city/state/zip; save carries the parsed fields', async () => {
    installFetch({
      predictions: [{ place_id: 'p1', description: '500 Oak Ave, Austin, TX, USA' }],
      details: { formatted: '500 Oak Ave, Austin, TX 78701, USA', street: '500 Oak Ave', apt: '', city: 'Austin', state: 'TX', zip: '78701' },
    })
    const { host, unmount } = await mountField({ address: null, city: null, state: null, zip: null })
    await click(host.querySelector('p')!)
    await type(streetInput(host)!, '500 Oak')
    await sleep(250) // debounce → /autocomplete
    const suggestion = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('500 Oak Ave'))!
    expect(suggestion).toBeTruthy()
    await mousedown(suggestion) // AddressAutofill picks on mousedown
    expect(streetInput(host)!.value).toBe('500 Oak Ave')
    expect(input(host, 'City')!.value).toBe('Austin')
    expect(input(host, 'State')!.value).toBe('TX')
    expect(input(host, 'ZIP')!.value).toBe('78701')
    await click(saveBtn(host)!)
    expect(leadPatches).toEqual([{
      address: '500 Oak Ave, Austin, TX, 78701',
      city: 'Austin', state: 'TX', zip: '78701',
    }])
    await unmount()
  })

  it('Places down (e.g. no GOOGLE_PLACES_API_KEY) → manual typing still saves', async () => {
    installFetch({ placesFail: true })
    const { host, unmount } = await mountField({ address: null, city: null, state: null, zip: null })
    await click(host.querySelector('p')!)
    await type(streetInput(host)!, '742 Evergreen Terrace')
    await sleep(250) // the failed autocomplete must not break anything
    await type(input(host, 'City')!, 'Springfield')
    await key(input(host, 'City')!, 'Enter') // Enter saves
    expect(leadPatches).toEqual([{
      address: '742 Evergreen Terrace, Springfield',
      city: 'Springfield', state: null, zip: null,
    }])
    expect(toasts[0].msg).toBe('Address added')
    await unmount()
  })
})

// ── toast truths ────────────────────────────────────────────────
describe('AddressField — the toast tells the whole truth', () => {
  const editAndSave = async (host: Element) => {
    await click(host.querySelector('p')!)
    await type(streetInput(host)!, '500 Oak Ave')
    await type(input(host, 'City')!, 'Austin')
    await type(input(host, 'State')!, 'TX')
    await type(input(host, 'ZIP')!, '78701')
    await click(saveBtn(host)!)
  }

  it("address_writeback updated → 'Address updated · synced to Jobber'", async () => {
    installFetch({ patchJson: { address_writeback: 'updated' } })
    const { host, unmount } = await mountField()
    await editAndSave(host)
    expect(toasts[0]).toEqual({ kind: 'success', msg: 'Address updated · synced to Jobber' })
    await unmount()
  })

  it("added outcome on a previously-empty lead → 'Address added · synced to Jobber'", async () => {
    installFetch({ patchJson: { address_writeback: 'added' } })
    const { host, unmount } = await mountField({ address: null, city: null, state: null, zip: null })
    await editAndSave(host)
    expect(toasts[0]).toEqual({ kind: 'success', msg: 'Address added · synced to Jobber' })
    await unmount()
  })

  it("failed → 'Jobber sync failed — saved in Bee Hub only'", async () => {
    installFetch({ patchJson: { address_writeback: 'failed' } })
    const { host, unmount } = await mountField()
    await editAndSave(host)
    expect(toasts[0].msg).toBe('Address updated · Jobber sync failed — saved in Bee Hub only')
    await unmount()
  })

  it('no writeback (unlinked / unchanged in Jobber) → plain truth, no Jobber claim', async () => {
    installFetch()
    const { host, unmount } = await mountField()
    await editAndSave(host)
    expect(toasts[0].msg).toBe('Address updated')
    await unmount()
  })
})

// ── propagation ─────────────────────────────────────────────────
describe('propagation — leadColsToPersonFields', () => {
  it('maps the composed address col onto Person.address; city/state/zip deliberately dropped', () => {
    const out = leadColsToPersonFields({
      address: '500 Oak Ave, Austin, TX, 78701', city: 'Austin', state: 'TX', zip: '78701',
    })
    expect(out).toEqual({ address: '500 Oak Ave, Austin, TX, 78701' })
  })
})
