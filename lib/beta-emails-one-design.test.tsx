// @vitest-environment happy-dom
//
// ONE DESIGN, NOT TWO (2026-10-30 follow-up). The Emails screen was the
// export where the export drew something and Bee Hub's older look wherever
// it didn't. Pinned here:
//
//   • a location's own templates group under that location's real name —
//     the library never needs a list from whoever mounts it
//   • the follow-ups box is amber when off, and not when on
//   • switching follow-ups off asks before it acts
//   • the Moving choice is two radio cards; the Organizing / Moving view is a
//     separate control, not pills inside the setting
//   • merging a split still asks first
//   • the corporate section starts collapsed
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => {
  const tables: Record<string, any> = {}
  const calls: string[] = []
  const builder = (t: string) => {
    calls.push(t)
    const b: any = {}
    for (const m of ['select', 'eq', 'or', 'is', 'in', 'not', 'order', 'limit']) b[m] = () => b
    b.single = () => Promise.resolve({ data: tables[t] ?? null, error: null })
    b.then = (res: any, rej: any) => Promise.resolve({ data: tables[t] ?? [], error: null }).then(res, rej)
    return b
  }
  return { tables, calls, builder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.builder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-kevin' } } }) },
    // A super_admin: role admin-tier, location_id NULL (the known trap).
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'u-kevin', role: 'super_admin', location_id: null } }) }) }) }),
  }),
}))

import { GET as templatesGET } from '@/app/api/templates/route'
import * as BeeHub from '@/components/BeeHub'
import { ET } from '@/components/settings/EmailsScreen'
const { MasterTemplatesEditor, FollowupsSwitch, EmailsList, SettingsScreen } = BeeHub as any

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const KC = '0b1c2d3e-0000-4000-8000-00000000c0c0'
const SEA = '0b1c2d3e-0000-4000-8000-00000000c0de'
const TEMPLATES = [
  { id: 'm1', name: 'First hello', type: 'email', subject: 'Hello', body: 'b', location_uuid: null, is_master: true, is_active: true },
  { id: 'c1', name: 'KC hello', type: 'email', subject: 'Hi KC', body: 'b', location_uuid: KC, is_master: false, is_active: true },
  { id: 'c2', name: 'KC nudge', type: 'email', subject: 'Nudge', body: 'b', location_uuid: KC, is_master: false, is_active: true },
  { id: 'c3', name: 'Seattle hello', type: 'email', subject: 'Hi', body: 'b', location_uuid: SEA, is_master: false, is_active: true },
]

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.calls.length = 0
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const flush = async () => { await act(async () => {}); await act(async () => {}) }
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === label) as HTMLButtonElement

// ─── 1 · location names ────────────────────────────────────────────────
describe('a location’s own templates group under its real name', () => {
  it('the route sends each location template with its location’s name', async () => {
    h.tables.templates = TEMPLATES.map(t => ({ ...t }))
    h.tables.locations = [{ id: KC, name: 'Kansas City' }, { id: SEA, name: 'Seattle' }]
    const res = await templatesGET()
    const { templates } = await res.json()
    const by = Object.fromEntries(templates.map((t: any) => [t.id, t.location_name]))
    expect(by).toEqual({ m1: undefined, c1: 'Kansas City', c2: 'Kansas City', c3: 'Seattle' })
  })

  it('the library on Settings → Emails — mounted with NO location list — names every group', async () => {
    const rows = TEMPLATES.map(t => ({ ...t, location_name: t.location_uuid === KC ? 'Kansas City' : t.location_uuid === SEA ? 'Seattle' : undefined }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ templates: rows }) })))
    await act(async () => { root.render(<MasterTemplatesEditor design />) })
    await flush()
    const text = container.textContent || ''
    expect(text).not.toContain('Unknown location')
    expect(text).toContain('Kansas City')
    expect(text).toContain('Seattle')
    // Both KC templates sit under the one Kansas City heading.
    const kcRows = ['c1', 'c2'].map(id => container.querySelector(`[data-template-row="${id}"]`)!.textContent)
    for (const t of kcRows) expect(t).toContain('Kansas City')
  })
})

// ─── 2 · 3 · the follow-ups box ────────────────────────────────────────
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const isColour = (v: string, hex: string) => v.toLowerCase() === hex.toLowerCase() || v.replace(/\s/g, '') === rgb(hex).replace(/\s/g, '')

describe('the follow-ups box', () => {
  const mount = async (off: boolean) => {
    const onSetOff = vi.fn(async () => undefined)
    await act(async () => { root.render(<FollowupsSwitch state={{ off, inFlight: 3, busy: false, err: '' }} onSetOff={onSetOff} />) })
    return { onSetOff, box: container.querySelector('[data-followups-box]') as HTMLElement }
  }

  it('is amber when off', async () => {
    const { box } = await mount(true)
    expect(box.textContent).toContain('Follow-up emails: off')
    expect(isColour(box.style.backgroundColor || box.style.background, ET.warningSoft), box.style.background).toBe(true)
    expect(box.style.border).not.toContain(ET.border)
  })

  it('is not amber when on', async () => {
    const { box } = await mount(false)
    expect(box.textContent).toContain('Follow-up emails: on')
    expect(isColour(box.style.backgroundColor || box.style.background, ET.warningSoft)).toBe(false)
    expect(isColour(box.style.backgroundColor || box.style.background, ET.card)).toBe(true)
  })

  it('switching off asks first — "Keep sending" does nothing, "Switch them off" acts', async () => {
    const { onSetOff } = await mount(false)
    await act(async () => { button('Switch off follow-ups').click() })
    expect(onSetOff).not.toHaveBeenCalled()
    const ask = container.querySelector('[role="alertdialog"]') as HTMLElement
    expect(ask.textContent).toContain('Stop all follow-ups?')
    await act(async () => { button('Keep sending').click() })
    expect(onSetOff).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    await act(async () => { button('Switch off follow-ups').click() })
    await act(async () => { button('Switch them off').click() })
    expect(onSetOff).toHaveBeenCalledWith(true)
  })

  it('switching back on is the primary button and needs no confirm', async () => {
    const { onSetOff } = await mount(true)
    await act(async () => { button('Switch follow-ups back on').click() })
    expect(onSetOff).toHaveBeenCalledWith(false)
  })
})

// ─── 4 · 5 · the Moving choice ─────────────────────────────────────────
const steps = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `db_${i + 1}`, dbId: `st-${i + 1}`, order: i + 1, type: 'email', delay_days: i * 5, subject: `S${i + 1}`, body: 'b', isActive: true,
}))
const mountList = async (same: boolean) => {
  const onChoose = vi.fn(async () => null)
  await act(async () => {
    root.render(<EmailsList pathSteps={{ 'organizing-a': steps(2), 'moving-c': steps(2) }} masterSteps={{}} templates={[]}
      generalDefault="organizing-a" moveDefault="moving-c" moving={{ same, onChoose }} />)
  })
  return onChoose
}

describe('the Moving choice', () => {
  it('is two radio option cards, not view pills', async () => {
    await mountList(false)
    const box = container.querySelector('[data-moving-choice]') as HTMLElement
    const cards = Array.from(box.querySelectorAll('[role="radio"]')) as HTMLElement[]
    expect(cards.map(c => c.textContent)).toEqual(['Get the same emails as organizing clients', 'Get their own set of emails'])
    for (const c of cards) {
      expect(c.style.borderRadius).toBe('10px')
      expect(c.querySelector('span[aria-hidden]')).toBeTruthy()          // the dot
    }
    expect(cards[1].getAttribute('aria-checked')).toBe('true')
    expect(cards[1].style.borderColor ? isColour(cards[1].style.borderColor, ET.primary) : cards[1].style.border.toLowerCase().includes(ET.primary.toLowerCase())).toBe(true)
    // The view is its own control, outside the setting, and not pills.
    expect(box.querySelector('[role="tablist"]')).toBeNull()
    const view = container.querySelector('[data-email-view] [role="tablist"]') as HTMLElement
    expect(Array.from(view.querySelectorAll('[role="tab"]')).map(t => t.textContent)).toEqual(['Organizing', 'Moving'])
    for (const t of Array.from(view.querySelectorAll('[role="tab"]')) as HTMLElement[]) expect(t.style.borderRadius).not.toBe('999px')
  })

  it('merging a split asks first — nothing is written until "Yes, use the same"', async () => {
    const onChoose = await mountList(false)
    const same = container.querySelector('[data-moving-choice] [role="radio"]') as HTMLElement
    await act(async () => { same.click() })
    expect(onChoose).not.toHaveBeenCalled()
    expect((container.querySelector('[data-moving-choice] [role="alertdialog"]') as HTMLElement).textContent).toContain('Replace the moving emails?')
    await act(async () => { button('Keep them separate').click() })
    expect(onChoose).not.toHaveBeenCalled()
    await act(async () => { same.click() })
    await act(async () => { button('Yes, use the same').click() })
    expect(onChoose).toHaveBeenCalledWith(true)
  })
})

// ─── 6 · the corporate section ─────────────────────────────────────────
describe('the corporate section', () => {
  it('starts collapsed — its 26 templates are not on the page until asked for', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) === '/api/templates') return { ok: true, status: 200, json: async () => ({ templates: TEMPLATES }) }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const loc = { id: KC, name: 'Kansas City', address: '1 Main', phone: '', bookingLink: '', reviewsLink: '', ratePerHour: '$95', serviceRadius: '', timezone: 'America/Chicago',
      assessmentType: 'in-person', smsEnabled: false, jobberConnected: false, jobberAccountId: null, crmStatus: 'active', sendFromName: 'KC', sendFromEmail: 'kc@x.com', replyToEmail: 'kc@x.com' }
    await act(async () => { root.render(<SettingsScreen selectedLoc={loc} initialSection="emails" isSuperAdmin />) })
    await flush()
    const section = container.querySelector('#masters') as HTMLElement
    expect(section).toBeTruthy()
    expect(section.getAttribute('data-section-open')).toBe('false')
    expect(section.querySelector('[data-template-row]')).toBeNull()
    expect(section.textContent).not.toContain('KC hello')
    const show = Array.from(section.querySelectorAll('button')).find(b => b.getAttribute('aria-expanded') === 'false') as HTMLElement
    await act(async () => { show.click() })
    await flush()
    expect(section.getAttribute('data-section-open')).toBe('true')
    expect(section.querySelector('[data-template-row="c1"]')).toBeTruthy()
  })
})
