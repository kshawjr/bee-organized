// @vitest-environment happy-dom
//
// TransferLeadModal — corp/admin routes a loc_other lead to a real location.
// Pins:
//   · announces itself as a Transfer dialog (OverlayShell + role=dialog + Esc)
//   · loads destination locations from /api/locations/transfer-targets and
//     lists them; loc_other is never among them (the endpoint excludes it)
//   · search filters the list
//   · NEVER a silent no-op: an ACTIVE destination note says it starts the
//     drip; a NON-active destination shows the amber "isn't live yet" warning.
//     Transfer stays allowed either way.
//   · confirm POSTs { destination_location_id } and hands the destination up
//   · error (success:false) → banner, no onDone
//   · compact footer buttons; fully tokenized (the hive sweep would fail a
//     literal); it composes OverlayShell, not a hand-rolled popup
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import TransferLeadModal from '@/components/hive/TransferLeadModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const TARGETS = [
  { id: 'dest-active', name: 'Boulder', slug: 'boulder-01', lifecycle_status: 'active', owner_name: 'Dana Lee' },
  { id: 'dest-onboarding', name: 'Denver', slug: 'denver-01', lifecycle_status: 'onboarding', owner_name: 'Sam Rio' },
]

describe('TransferLeadModal', () => {
  let host: HTMLDivElement
  let root: Root
  let posts: any[] = []
  let transferOk = true
  let transferResponse: any = { success: true, to: { name: 'Boulder' } }

  const mount = async (props: any = {}) => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(
        <TransferLeadModal
          person={{ id: 'p1', name: 'Sarah Mitchell' }}
          subline="Austin, TX 78701 · Garage · from global form"
          onDone={() => {}}
          onClose={() => {}}
          {...props}
        />,
      )
    })
    await flush()
  }

  const flush = async () => {
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
  }

  beforeEach(() => {
    posts = []
    transferOk = true
    transferResponse = { success: true, to: { name: 'Boulder' } }
    global.fetch = vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url)
      if (u.includes('/api/locations/transfer-targets')) {
        return { ok: true, status: 200, json: async () => ({ targets: TARGETS }) } as any
      }
      if (u.includes('/transfer') && opts.method === 'POST') {
        posts.push(JSON.parse(opts.body))
        return { ok: transferOk, status: transferOk ? 200 : 500, json: async () => transferResponse } as any
      }
      return { ok: true, status: 200, json: async () => ({}) } as any
    }) as any
  })

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    if (host) host.remove()
    vi.restoreAllMocks()
  })

  const buttons = () => Array.from(host.querySelectorAll('button'))
  const options = () => Array.from(host.querySelectorAll('[role="option"]')) as HTMLElement[]
  const optByName = (name: string) => options().find(o => (o.textContent || '').includes(name))!
  const contains = (t: string) => buttons().find(b => (b.textContent || '').includes(t))
  const setInput = async (el: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('announces itself as a Transfer dialog and shows the person·origin subline', async () => {
    await mount()
    const dlg = host.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg).toBeTruthy()
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-label')).toBe('Transfer lead')
    expect(host.textContent).toContain('Sarah Mitchell')
    expect(host.textContent).toContain('from global form')
  })

  it('loads and lists destination locations with their live-state', async () => {
    await mount()
    expect(options()).toHaveLength(2)
    expect(optByName('Boulder').textContent).toContain('Live')
    expect(optByName('Denver').textContent).toContain('Not live yet')
  })

  it('search filters the destination list', async () => {
    await mount()
    await setInput(host.querySelector('input[aria-label="Search locations"]') as HTMLInputElement, 'denver')
    expect(options()).toHaveLength(1)
    expect(optByName('Denver')).toBeTruthy()
  })

  it('ACTIVE destination note says it starts the drip (never a silent no-op)', async () => {
    await mount()
    await act(async () => { optByName('Boulder').click() })
    expect(host.textContent).toContain("starts Boulder's drip")
    expect(host.textContent).toContain('Dana Lee')
    // primary button reflects the choice
    expect(contains('Transfer to Boulder')).toBeTruthy()
  })

  it('NON-active destination shows the amber "isn\'t live yet" warning, still allows transfer', async () => {
    await mount()
    await act(async () => { optByName('Denver').click() })
    expect(host.textContent).toContain("Denver isn't live yet")
    expect(host.textContent).toContain("won't start until they activate")
    const confirm = contains('Transfer to Denver') as HTMLButtonElement
    expect(confirm).toBeTruthy()
    expect(confirm.disabled).toBe(false)
  })

  it('confirm is disabled until a destination is picked', async () => {
    await mount()
    const confirm = contains('Transfer') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await act(async () => { optByName('Boulder').click() })
    expect((contains('Transfer to Boulder') as HTMLButtonElement).disabled).toBe(false)
  })

  it('confirm POSTs { destination_location_id } and hands the destination up', async () => {
    const onDone = vi.fn()
    await mount({ onDone })
    await act(async () => { optByName('Boulder').click() })
    await act(async () => { contains('Transfer to Boulder')!.click() })
    await flush()
    expect(posts).toEqual([{ destination_location_id: 'dest-active' }])
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][0]).toMatchObject({ id: 'dest-active', name: 'Boulder' })
  })

  it('error (success:false) shows the banner and does NOT hand up', async () => {
    transferResponse = { success: false, error: 'destination_has_linked_duplicate' }
    const onDone = vi.fn()
    await mount({ onDone })
    await act(async () => { optByName('Boulder').click() })
    await act(async () => { contains('Transfer to Boulder')!.click() })
    await flush()
    expect(onDone).not.toHaveBeenCalled()
    expect(host.textContent).toContain("Couldn't transfer")
    expect(host.textContent).toContain('destination_has_linked_duplicate')
  })

  it('Esc closes it (OverlayShell owns the backdrop + X, not this)', async () => {
    const onClose = vi.fn()
    await mount({ onClose })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('footer buttons are compact (8px 15px / 13px), not full-width slabs', async () => {
    await mount()
    const cancel = contains('Cancel')!
    expect(cancel.style.padding).toBe('8px 15px')
    expect(cancel.style.fontSize).toBe('13px')
    expect(cancel.style.width).toBe('')
  })

  it('composes OverlayShell and is fully tokenized (no raw hex/rgba)', () => {
    const src = readFileSync('components/hive/TransferLeadModal.jsx', 'utf8')
    expect(src).toContain("import OverlayShell from './OverlayShell'")
    expect(src).toContain('maxWidth={MODAL_WIDTH}')
    expect(/#[0-9a-fA-F]{3,8}\b/.test(src)).toBe(false)
    expect(/rgba?\(/.test(src)).toBe(false)
  })
})
