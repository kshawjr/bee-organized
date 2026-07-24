// @vitest-environment happy-dom
//
// Settings → Templates — the Master Templates list groups the Gen 2 rows into
// their own labeled sections.
//
// The tab renders three sub-groups under "📚 Master Templates":
//   💛 Welcome Email        → legacy_id 'welcome'
//   📈 Opportunity Stages   → legacy_id 'opp_*'
//   📨 Other Templates      → everything else (the legacy t1–t9 / ta–td rows)
//
// The filters read the MAPPED row, and /api/templates rows are mapped to
// camelCase on fetch (`legacyId: r.legacy_id`) — there is no `legacy_id` key
// on the object. Reading the snake_case name left both Gen 2 groups
// permanently empty and dumped all 7 of Kevin's masters into the generic
// Other bucket alongside the prototype rows.
//
// Pins the grouping, not the source: mount the tab and assert each Gen 2 row
// lands under its own heading.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'

const selectedLoc = {
  id: LOC_UUID, name: 'Testville', address: '', phone: '', bookingLink: '',
  reviewsLink: '', ratePerHour: '', serviceRadius: '', timezone: 'America/Chicago',
  assessmentType: 'in-person', smsEnabled: false, jobberConnected: false,
  jobberAccountId: null, crmStatus: 'active', sendFromName: 'Bee',
  sendFromEmail: 'a@b.c', replyToEmail: 'a@b.c',
}

const master = (legacy_id: string, name: string, tag: string) => ({
  id: `tpl-${legacy_id}`, legacy_id, name, type: 'email', tag,
  subject: `${legacy_id} subj`, body: `${legacy_id} body`,
  is_active: true, location_uuid: null, is_master: true, is_own_custom: false,
})

const TEMPLATES = [
  master('welcome', 'GEN2 Welcome Email', 'welcome'),
  master('opp_closed_job_3mo', 'GEN2 Closed Job 3mo', 'opportunity-stage'),
  master('opp_moving_estimate_30d', 'GEN2 Moving Estimate 30d', 'opportunity-stage'),
  // A legacy prototype master — belongs in the Other bucket, not the Gen 2 ones.
  master('t2', 'GEN1 How We Help', 'nurture'),
]

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url)
    if (u.includes('/api/templates')) {
      return { ok: true, status: 200, json: async () => ({ templates: TEMPLATES }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
  vi.stubGlobal('alert', vi.fn())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// Open the collapsed Email Templates section by walking up from its sub-label.
async function openEmailSection() {
  const sub = Array.from(container.querySelectorAll('*')).find(
    el => el.textContent?.trim().startsWith('Subject lines and bodies for client emails'),
  )
  expect(sub, 'the Email Templates section header').toBeTruthy()
  for (let el = sub as HTMLElement | null; el && el !== container; el = el.parentElement) {
    await act(async () => { el!.click() })
    if ((container.textContent || '').includes('GEN2 Welcome Email')) break
  }
}

describe('Templates tab — Gen 2 master grouping', () => {
  it('renders the Welcome and Opportunity Stages headings', async () => {
    await act(async () => {
      root.render(<SettingsScreen selectedLoc={selectedLoc} initialSection="templates" />)
    })
    await act(async () => {})
    await openEmailSection()

    const t = container.textContent || ''
    // Both headings were unreachable while the filters read `legacy_id`.
    expect(t, 'Welcome Email heading').toContain('💛 Welcome Email')
    expect(t, 'Opportunity Stages heading').toContain('📈 Opportunity Stages')
    expect(t, 'Other Templates heading').toContain('📨 Other Templates')
  })

  it('files each master under the right heading', async () => {
    await act(async () => {
      root.render(<SettingsScreen selectedLoc={selectedLoc} initialSection="templates" />)
    })
    await act(async () => {})
    await openEmailSection()

    const t = container.textContent || ''
    const at = (s: string) => t.indexOf(s)
    const welcomeHead = at('💛 Welcome Email')
    const oppHead = at('📈 Opportunity Stages')
    const otherHead = at('📨 Other Templates')

    // Every row is on screen…
    for (const name of ['GEN2 Welcome Email', 'GEN2 Closed Job 3mo', 'GEN2 Moving Estimate 30d', 'GEN1 How We Help']) {
      expect(t, name).toContain(name)
    }
    // …and each sits between its own heading and the next one. Before the fix
    // all four fell after 📨 Other Templates.
    expect(at('GEN2 Welcome Email')).toBeGreaterThan(welcomeHead)
    expect(at('GEN2 Welcome Email')).toBeLessThan(oppHead)

    expect(at('GEN2 Closed Job 3mo')).toBeGreaterThan(oppHead)
    expect(at('GEN2 Closed Job 3mo')).toBeLessThan(otherHead)
    expect(at('GEN2 Moving Estimate 30d')).toBeGreaterThan(oppHead)
    expect(at('GEN2 Moving Estimate 30d')).toBeLessThan(otherHead)

    expect(at('GEN1 How We Help')).toBeGreaterThan(otherHead)
  })

  it('keeps masters read-only — Preview + Duplicate, never Edit or Delete', async () => {
    await act(async () => {
      root.render(<SettingsScreen selectedLoc={selectedLoc} initialSection="templates" />)
    })
    await act(async () => {})
    await openEmailSection()

    const labels = Array.from(container.querySelectorAll('button'))
      .map(b => b.textContent?.trim())
    expect(labels).toContain('Preview')
    expect(labels).toContain('Duplicate')
    // No custom templates in this fixture, so any Edit/Delete button on screen
    // could only belong to a master row.
    expect(labels).not.toContain('Edit')
    expect(labels).not.toContain('Delete')
  })
})
