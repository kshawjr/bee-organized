// @vitest-environment happy-dom
//
// The own-custom template chip in Settings → Communications actually OPENS
// the editor when clicked.
//
// The unbound-identifier sweep found `tpl` in the chip's onClick:
//     setEditingTemplate({ master: tmpl, tpl })
// The binding in that map callback is `tmpl` — `tpl` was copy-pasted from the
// template-library call site (where the local IS named tpl) and resolved to
// nothing. Every click on an own-custom chip threw
// `ReferenceError: tpl is not defined`. A source pin can't catch that (the
// string is in the source), so this test performs the real click.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const LOC_UUID = 'dca50888-949f-436d-b24e-b6c8a4984905'

// One own-custom email template + one location drip path whose step points at
// it (template_legacy_id ↔ legacy_id is the join the UI uses).
;(globalThis as any).fetch = vi.fn(async (url: any) => {
  const u = String(url)
  if (u.includes('/api/templates')) {
    return { ok: true, status: 200, json: async () => ({ templates: [{
      id: 'db-tpl-1', legacy_id: 'tpl_custom_1', name: 'My Custom Welcome',
      type: 'email', tag: '', subject: 'Welcome from us', body: 'Hello there, thanks for reaching out to Bee Organized!',
      is_active: true, location_uuid: LOC_UUID, is_master: false, is_own_custom: true, cloned_from_id: null,
    }] }) }
  }
  if (u.includes('/drip-paths/masters')) {
    return { ok: true, status: 200, json: async () => ({ masters: [] }) }
  }
  if (u.includes('/drip-paths')) {
    return { ok: true, status: 200, json: async () => ({ paths: [{
      id: 'path-row-1', path_key: 'organizing-a', name: 'Path A', is_default: true, location_uuid: LOC_UUID,
      steps: [{
        id: 501, step_order: 1, channel: 'email', delay_days: 0,
        subject: 'Welcome from us', body: 'Hello there…',
        template_legacy_id: 'tpl_custom_1', master_template_id: null,
        template_name: 'My Custom Welcome',
      }],
    }] }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}) as any

import { SettingsScreen, CurrentLocationContext } from '@/components/BeeHub'

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

async function flush(n = 8) {
  for (let i = 0; i < n; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

async function clickByText(host: HTMLElement, text: string) {
  const nodes = Array.from(host.querySelectorAll('button, div, span, p')) as HTMLElement[]
  const exact = nodes.filter(n => (n.textContent || '').trim() === text).pop()
  const target = exact || nodes.filter(n => (n.textContent || '').includes(text)).pop()
  if (!target) throw new Error(`clickByText: "${text}" not found`)
  await act(async () => { target.click() })
  await flush(4)
}

describe('Settings → Communications own-custom template chip', () => {
  it('clicking the chip opens the template editor (was: ReferenceError tpl)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })

    await act(async () => {
      root.render(
        <CurrentLocationContext.Provider value={{ id: LOC_UUID, name: 'Kansas City' } as any}>
          <SettingsScreen initialSection="paths" franchiseRole="owner" />
        </CurrentLocationContext.Provider>
      )
    })
    await flush()

    // Open the Organizing sequence, then expand Path A's steps.
    await clickByText(host, 'Organizing projects')
    await clickByText(host, 'Reply to schedule · rate included')

    // The step row resolved its template (chip shows the template name).
    expect(host.textContent).toContain('My Custom Welcome')

    // THE regression click: own-custom chip → editor. Before the fix this
    // threw `ReferenceError: tpl is not defined` inside the onClick.
    await clickByText(host, 'My Custom Welcome')
    expect(host.textContent).toContain('Template Name')
  })
})
