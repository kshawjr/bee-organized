// @vitest-environment happy-dom
//
// Gen 1 prototype-copy quarantine — MOUNT tests.
//
// Bee Hub carried two generations of drip content:
//   Gen 1 — 17 template rows (t1–t9, ta1–td2) seeded from a hardcoded
//           DEFAULT_TEMPLATES constant in BeeHub.jsx. Invented prototype copy.
//   Gen 2 — the 8 master drip_paths whose STEPS carry Kevin's real content
//           inline (subject + body), seeded from the master doc.
//
// Onboarding previewed Gen 1 from the JS bundle, and Settings → Paths
// materialized Gen 1 into real per-location paths: savePathToDb() POSTed a
// bare drip_paths row then PATCHed steps with no subject/body, leaving every
// step NULL-bodied and pointing at a t* row. drip-send.ts resolves
// `step.subject ?? linkedTpl.subject`, so the owner's first delay tweak
// silently swapped their live drip to prototype copy (Portland/moving-d, 7/13).
//
// These suites pin the behaviour, not the source:
//   1. the onboarding preview renders MASTER subject/body
//   2. the intro describes the REAL cadence (0 / +5d / +30d, Welcome at +24h)
//   3. a first-time customization CLONES the master
//   4. re-saving a customized path PRESERVES its content instead of nulling it
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OnboardingPathsEditor, SettingsScreen } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'
const MASTER_MOVING_D = 'aaaaaaaa-1111-4222-8333-444455556666'

// Distinctive master content — if any of these strings render, the surface is
// reading the DB masters. The Gen 1 strings below must never appear.
const MASTER_SUBJECT_1 = 'MASTER-SUBJ-1 lets get your move sorted'
const MASTER_BODY_1 = 'MASTER-BODY-1 real corp content from the master doc'
const MASTER_SUBJECT_2 = 'MASTER-SUBJ-2 following up on your move'

// Gen 1 prototype strings that used to be hardcoded in the bundle.
const GEN1_STRINGS = ['How We Help', 'Real Results', 'Ready to Book?']

const masterSteps = () => [
  { id: 's1', step_order: 1, delay_days: 0, channel: 'email', subject: MASTER_SUBJECT_1, body: MASTER_BODY_1, is_active: true },
  { id: 's2', step_order: 2, delay_days: 5, channel: 'email', subject: MASTER_SUBJECT_2, body: 'MASTER-BODY-2', is_active: true },
  { id: 's3', step_order: 3, delay_days: 30, channel: 'email', subject: 'MASTER-SUBJ-3', body: 'MASTER-BODY-3', is_active: true },
]

const MASTERS = ['a', 'b', 'c', 'd'].flatMap(l => [
  { id: l === 'd' ? MASTER_MOVING_D : `master-moving-${l}`, path_key: `moving-${l}`, name: `Move ${l}`, is_active: true, steps: masterSteps() },
  { id: `master-organizing-${l}`, path_key: `organizing-${l}`, name: `Org ${l}`, is_active: true, steps: masterSteps() },
])

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: { url: string; method: string; body: any }[]

// Per-test overrides for specific endpoints.
let routes: Record<string, any>

function makeFetch() {
  return vi.fn(async (url: any, init: any = {}) => {
    const u = String(url)
    const method = init?.method || 'GET'
    let body: any = undefined
    try { body = init?.body ? JSON.parse(init.body) : undefined } catch { /* non-JSON */ }
    calls.push({ url: u, method, body })

    for (const [frag, payload] of Object.entries(routes)) {
      const [m, f] = frag.includes(' ') ? frag.split(' ') : ['GET', frag]
      if (method === m && u.includes(f)) {
        return { ok: true, status: 200, json: async () => payload }
      }
    }
    if (u.includes('/api/drip-paths/masters')) {
      return { ok: true, status: 200, json: async () => ({ masters: MASTERS }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

beforeEach(() => {
  calls = []
  routes = {}
  vi.stubGlobal('fetch', makeFetch())
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('confirm', vi.fn(() => true))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const textEls = (t: string) =>
  Array.from(container.querySelectorAll('p, button, span')).filter(
    el => el.textContent?.trim() === t,
  )

const clickText = async (t: string) => {
  const el = textEls(t)[0]
  expect(el, `element with text "${t}"`).toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
}

// ═══════════════════════════════════════════════════════════════════════════
describe('onboarding preview reads the DB masters', () => {
  const mount = async () => {
    await act(async () => { root.render(<OnboardingPathsEditor onComplete={vi.fn()} />) })
    await act(async () => {})   // masters fetch
  }

  it('the ▼ Emails preview lists MASTER subjects, and 👁 Preview shows the master body', async () => {
    await mount()
    await clickText("Let's pick my paths →")
    await clickText('▼ Emails')   // first path card

    // Step rows are labelled with the master's own subject lines.
    expect(container.textContent).toContain(MASTER_SUBJECT_1)
    expect(container.textContent).toContain(MASTER_SUBJECT_2)

    // And the peek modal renders the body that will actually send.
    await clickText('👁 Preview')
    expect(container.textContent).toContain(MASTER_BODY_1)
  })

  it('never renders Gen 1 prototype copy', async () => {
    await mount()
    await clickText("Let's pick my paths →")
    await clickText('▼ Emails')
    for (const s of GEN1_STRINGS) {
      expect(container.textContent, `Gen 1 string "${s}" leaked into onboarding`).not.toContain(s)
    }
  })

  it('degrades honestly when masters fail to load — no invented copy', async () => {
    routes = {}
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    await mount()
    await clickText("Let's pick my paths →")
    await clickText('▼ Emails')
    expect(container.textContent).toContain("Couldn't load this path's emails")
    for (const s of GEN1_STRINGS) {
      expect(container.textContent).not.toContain(s)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('onboarding intro describes the real cadence', () => {
  it('states 0 / +5 days / +30 days plus the separate 24h Welcome', async () => {
    await act(async () => { root.render(<OnboardingPathsEditor onComplete={vi.fn()} />) })
    await act(async () => {})
    const t = container.textContent || ''

    expect(t).toContain('Right away')
    expect(t).toContain('5 days later')
    expect(t).toContain('30 days later')
    // The Welcome Email is a SEPARATE send at +24h, not the first drip email.
    expect(t).toMatch(/Welcome Email/)
    expect(t).toMatch(/24 hours after/)
  })

  it('drops the old claim that a welcome email leads and a follow-up lands in 1-2 days', async () => {
    await act(async () => { root.render(<OnboardingPathsEditor onComplete={vi.fn()} />) })
    await act(async () => {})
    const t = container.textContent || ''

    expect(t).not.toContain('1–2 days')
    expect(t).not.toContain('A welcome email - goes out right when they sign up')
    // Per-path explainers no longer promise a leading welcome email either.
    expect(t).not.toContain("You'll send a welcome email")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('Settings → Paths customization clones the master', () => {
  const selectedLoc = {
    id: LOC_UUID, name: 'Testville', address: '1 Main', phone: '', bookingLink: '',
    reviewsLink: '', ratePerHour: '', serviceRadius: '', timezone: 'America/Chicago',
    assessmentType: 'in-person', smsEnabled: false, jobberConnected: false,
    jobberAccountId: null, crmStatus: 'active', sendFromName: 'Bee', sendFromEmail: 'a@b.c',
    replyToEmail: 'a@b.c',
  }

  const mountPaths = async () => {
    await act(async () => {
      root.render(<SettingsScreen selectedLoc={selectedLoc} initialSection="paths" />)
    })
    await act(async () => {})
    await clickText('Moving')          // open the move sequence
    await clickText('Path D')          // expand the moving-d row
  }

  it('a first-time save CLONES from the master — never POSTs a bare path row', async () => {
    routes = {
      [`GET /api/locations/${LOC_UUID}/drip-paths`]: { paths: [], default_drip_path: null, default_move_drip_path: null },
      [`POST /api/locations/${LOC_UUID}/drip-paths/clone`]: { path: { id: 'new-copy-id', name: 'Move d', is_default: false } },
    }
    await mountPaths()
    await clickText('Save path to DB')

    const clone = calls.find(c => c.method === 'POST' && c.url.includes('/drip-paths/clone'))
    expect(clone, 'the clone call').toBeTruthy()
    expect(clone!.body).toEqual({ master_id: MASTER_MOVING_D })

    // The old bare-path POST must be gone: no POST to the collection endpoint.
    const barePost = calls.find(
      c => c.method === 'POST' && c.url.endsWith(`/api/locations/${LOC_UUID}/drip-paths`),
    )
    expect(barePost, 'bare drip_paths POST should no longer happen').toBeFalsy()
  })

  it('the saved steps carry the MASTER subject/body — not a NULL-bodied t* pointer', async () => {
    routes = {
      [`GET /api/locations/${LOC_UUID}/drip-paths`]: { paths: [], default_drip_path: null, default_move_drip_path: null },
      [`POST /api/locations/${LOC_UUID}/drip-paths/clone`]: { path: { id: 'new-copy-id', name: 'Move d', is_default: false } },
    }
    await mountPaths()
    await clickText('Save path to DB')

    const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('/steps'))
    expect(patch, 'the steps PATCH').toBeTruthy()
    const steps = patch!.body.steps
    expect(steps).toHaveLength(3)

    // Content travels with the step. This is the whole fix: a step whose
    // subject/body are null falls through to master_template_id at send time,
    // which is how Gen 1 copy used to end up in a live drip.
    expect(steps[0].subject).toBe(MASTER_SUBJECT_1)
    expect(steps[0].body).toBe(MASTER_BODY_1)
    expect(steps[0].master_template_id).toBeNull()
    expect(steps.every((s: any) => s.body)).toBe(true)

    // Cadence survives the round trip.
    expect(steps.map((s: any) => s.delay_days)).toEqual([0, 5, 30])
  })

  it('re-saving an ALREADY customized path preserves its content (no NULL wipe)', async () => {
    // A location copy that already holds real inline content.
    routes = {
      [`GET /api/locations/${LOC_UUID}/drip-paths`]: {
        paths: [{
          id: 'existing-copy', location_uuid: LOC_UUID, path_key: 'moving-d', name: 'Move d',
          is_active: true, is_default: false,
          steps: [
            { id: 'e1', step_order: 1, delay_days: 0, channel: 'email', subject: 'MY OWN SUBJ', body: 'MY OWN BODY', master_template_id: null, template_name: 'Mine', template_legacy_id: null, is_active: true },
            { id: 'e2', step_order: 2, delay_days: 5, channel: 'email', subject: 'MY SUBJ 2', body: 'MY BODY 2', master_template_id: null, template_name: 'Mine 2', template_legacy_id: null, is_active: true },
          ],
        }],
        default_drip_path: null, default_move_drip_path: 'moving-d',
      },
    }
    await mountPaths()
    await clickText('Save changes')

    // No clone — the copy already exists.
    expect(calls.find(c => c.url.includes('/drip-paths/clone'))).toBeFalsy()

    const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('/steps'))
    expect(patch, 'the steps PATCH').toBeTruthy()
    const steps = patch!.body.steps
    expect(steps).toHaveLength(2)
    expect(steps[0].subject).toBe('MY OWN SUBJ')
    expect(steps[0].body).toBe('MY OWN BODY')
    expect(steps[1].body).toBe('MY BODY 2')
    // Previously every one of these was null — the regression this pins.
    expect(steps.some((s: any) => s.body == null)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §E — quarantine is a display gate, not a delete. Inert until the DB flip.
describe('quarantined templates disappear from the Templates tab', () => {
  const selectedLoc = {
    id: LOC_UUID, name: 'Testville', address: '', phone: '', bookingLink: '',
    reviewsLink: '', ratePerHour: '', serviceRadius: '', timezone: 'America/Chicago',
    assessmentType: 'in-person', smsEnabled: false, jobberConnected: false,
    jobberAccountId: null, crmStatus: 'active', sendFromName: 'Bee',
    sendFromEmail: 'a@b.c', replyToEmail: 'a@b.c',
  }

  const TEMPLATES = [
    // A quarantined Gen 1 row.
    { id: 'tpl-td1', legacy_id: 'td1', name: 'GEN1 Move · Avail + Calendar + Phone', type: 'email', tag: 'cta', subject: 'gen1 subj', body: 'gen1 body', is_active: false, location_uuid: null, is_master: true, is_own_custom: false },
    // A live Gen 2 standalone master — must survive the same pass.
    { id: 'tpl-welcome', legacy_id: 'welcome', name: 'GEN2 Welcome Email', type: 'email', tag: 'welcome', subject: 'w subj', body: 'w body', is_active: true, location_uuid: null, is_master: true, is_own_custom: false },
    { id: 'tpl-opp', legacy_id: 'opp_closed_job_3mo', name: 'GEN2 Opportunity 3mo', type: 'email', tag: 'opportunity-stage', subject: 'o subj', body: 'o body', is_active: true, location_uuid: null, is_master: true, is_own_custom: false },
  ]

  it('hides is_active=false masters but keeps the Gen 2 welcome/opp rows', async () => {
    routes = { '/api/templates': { templates: TEMPLATES } }
    await act(async () => {
      root.render(<SettingsScreen selectedLoc={selectedLoc} initialSection="templates" />)
    })
    await act(async () => {})
    // The email section starts collapsed and its header is a plain div, so
    // walk up from the sub-label and click ancestors until the list opens.
    const sub = Array.from(container.querySelectorAll('*')).find(
      el => el.textContent?.trim().startsWith('Subject lines and bodies for client emails'),
    )
    expect(sub, 'the Email Templates section header').toBeTruthy()
    for (let el = sub as HTMLElement | null; el && el !== container; el = el.parentElement) {
      await act(async () => { el!.click() })
      if ((container.textContent || '').includes('GEN2 Welcome Email')) break
    }

    const t = container.textContent || ''
    expect(t, 'quarantined Gen 1 row should be hidden').not.toContain('GEN1 Move · Avail + Calendar + Phone')
    // The load-bearing Gen 2 rows must NOT be collateral damage.
    expect(t).toContain('GEN2 Welcome Email')
    expect(t).toContain('GEN2 Opportunity 3mo')
  })
})
