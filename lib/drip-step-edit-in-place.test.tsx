// @vitest-environment happy-dom
//
// Template/Communications merge STAGE 2 — edit-in-place + preview parity.
// MOUNT tests against SettingsScreen (Settings → Communication → New lead
// emails), pinning behaviour, not source:
//
//   1. Editing a master-backed step FORKS first (existing clone route), then
//      opens the editor on the CLONED step — the master is never written.
//   2. The fork confirm carries the snapshot warning at the decision point.
//   3. An inline edit drops the step's master_template_id (inline content
//      wins at send time; a kept pointer would display a template the step
//      no longer uses). Untouched steps keep theirs.
//   4. Every mutation commits through commitSteps — the bulk
//      PATCH /api/drip-paths/:id/steps full replace. No per-step immediate
//      save (/api/drip-path-steps/:id) exists on the owner surface, and no
//      batch Save button exists.
//   5. A commit failure leaves the sequence unchanged — no partial
//      application, for content edits and delay edits alike.
//   6. The step-row Preview renders ALL 14 send-time variables — no empty
//      hole for rate, owner name, or either booking tag.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'
const MASTER_MOVING_D = 'aaaaaaaa-1111-4222-8333-444455556666'
const COPY_ID = 'copy-0000-1111'

// Body exercising every send-time variable — the preview-parity fixture.
const ALL_14 = [
  'first_name','organizer_name','location_name','phone','booking_link',
  'service_area','owner_name','owner_first_name','owner_booking_link',
  'location_owner_name','rate_per_hour','location_phone',
  'book_assessment_link','reviews_link',
]
const ALL_TAGS_BODY = ALL_14.map(k => `${k}=[{{${k}}}]`).join(' ')

const masterSteps = () => [
  { id: 'ms1', step_order: 1, delay_days: 0, channel: 'email', subject: 'MASTER SUBJ ONE', body: ALL_TAGS_BODY, is_active: true },
  { id: 'ms2', step_order: 2, delay_days: 5, channel: 'email', subject: 'MASTER SUBJ TWO', body: 'MASTER-BODY-2', is_active: true },
  { id: 'ms3', step_order: 3, delay_days: 30, channel: 'email', subject: 'MASTER SUBJ THREE', body: 'MASTER-BODY-3', is_active: true },
]

const MASTERS = ['a', 'b', 'c', 'd'].flatMap(l => [
  { id: l === 'd' ? MASTER_MOVING_D : `master-moving-${l}`, path_key: `moving-${l}`, name: `Move ${l}`, is_active: true, steps: masterSteps() },
  { id: `master-organizing-${l}`, path_key: `organizing-${l}`, name: `Org ${l}`, is_active: true, steps: masterSteps() },
])

// The clone the server returns after a fork — content deliberately DISTINCT
// from the master fixture so "the editor opened on the clone" is provable.
const CLONED_PATH = {
  id: COPY_ID, location_uuid: LOC_UUID, path_key: 'moving-d', name: 'Move d',
  is_active: true, is_default: false,
  steps: [
    { id: 'cs1', step_order: 1, delay_days: 0, channel: 'email', subject: 'CLONED SUBJ ONE', body: 'CLONED-BODY-ONE', master_template_id: null, template_name: null, template_legacy_id: null, is_active: true },
    { id: 'cs2', step_order: 2, delay_days: 5, channel: 'email', subject: 'CLONED SUBJ TWO', body: 'CLONED-BODY-TWO', master_template_id: null, template_name: null, template_legacy_id: null, is_active: true },
  ],
}

// An already-customized path whose step 1 still points at a master template
// row — the master_template_id drop fixture.
const CUSTOMIZED_PATH = {
  id: 'existing-copy', location_uuid: LOC_UUID, path_key: 'moving-d', name: 'Move d',
  is_active: true, is_default: false,
  steps: [
    { id: 'e1', step_order: 1, delay_days: 0, channel: 'email', subject: 'MY OWN SUBJ', body: 'MY OWN BODY', master_template_id: 'mt-1', template_name: null, template_legacy_id: null, is_active: true },
    { id: 'e2', step_order: 2, delay_days: 5, channel: 'email', subject: 'MY SUBJ 2', body: 'MY BODY 2', master_template_id: 'mt-2', template_name: null, template_legacy_id: null, is_active: true },
  ],
}

const selectedLoc = {
  id: LOC_UUID, name: 'Testville', owner: 'Pat Owner', address: '1 Main', phone: '(111) 222-3333',
  bookingLink: 'https://cal.example/loc', reviewsLink: 'https://g.page/testville',
  ratePerHour: '$88/hr', serviceRadius: '', timezone: 'America/Chicago',
  assessmentType: 'in-person', smsEnabled: false, jobberConnected: false,
  jobberAccountId: null, crmStatus: 'active', sendFromName: 'Bee Testville',
  sendFromEmail: 'a@b.c', replyToEmail: 'a@b.c',
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: { url: string; method: string; body: any }[]
// Mutable server state the fetch mock serves.
let serverPaths: any[]
let stepsPatchStatus: number

function makeFetch() {
  return vi.fn(async (url: any, init: any = {}) => {
    const u = String(url)
    const method = init?.method || 'GET'
    let body: any = undefined
    try { body = init?.body ? JSON.parse(init.body) : undefined } catch { /* non-JSON */ }
    calls.push({ url: u, method, body })

    if (u.includes('/api/drip-paths/masters')) {
      return { ok: true, status: 200, json: async () => ({ masters: MASTERS }) }
    }
    if (method === 'POST' && u.includes(`/api/locations/${LOC_UUID}/drip-paths/clone`)) {
      // Cloning materializes the copy — subsequent GETs serve it.
      serverPaths = [CLONED_PATH]
      return { ok: true, status: 201, json: async () => ({ path: { id: COPY_ID, name: 'Move d', is_default: false } }) }
    }
    if (method === 'GET' && u.includes(`/api/locations/${LOC_UUID}/drip-paths`)) {
      return { ok: true, status: 200, json: async () => ({ paths: serverPaths, default_drip_path: null, default_move_drip_path: 'moving-d' }) }
    }
    if (method === 'PATCH' && /\/api\/drip-paths\/[^/]+\/steps/.test(u)) {
      const ok = stepsPatchStatus < 400
      return { ok, status: stepsPatchStatus, json: async () => (ok ? { ok: true, steps: body?.steps || [] } : { error: 'insert_failed' }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

beforeEach(() => {
  calls = []
  serverPaths = []
  stepsPatchStatus = 200
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

// React-controlled input mutation (native setter + input event).
const setNativeValue = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const mountPaths = async () => {
  await act(async () => {
    root.render(<SettingsScreen selectedLoc={selectedLoc} initialSection="paths" />)
  })
  await act(async () => {})   // masters + location paths fetches
  await clickText('Moving projects')
  await clickText('Booking link · rate on the call')   // expand the moving-d row
}

const editButtons = () =>
  Array.from(container.querySelectorAll('button[title="Edit this email\'s wording"]')) as HTMLElement[]

const stepsPatches = () => calls.filter(c => c.method === 'PATCH' && /\/api\/drip-paths\/[^/]+\/steps/.test(c.url))
const perStepCalls = () => calls.filter(c => c.url.includes('/api/drip-path-steps/'))

// ═══════════════════════════════════════════════════════════════════════════
describe('fork-on-edit for master-backed paths', () => {
  it('Edit forks first, then opens the editor on the CLONE — never the master', async () => {
    await mountPaths()

    await act(async () => { editButtons()[0].click() })

    // The confirm gate is up and NOTHING has been written yet.
    const t1 = container.textContent || ''
    expect(t1).toContain('Customize these emails for your location?')
    expect(calls.find(c => c.url.includes('/clone'))).toBeFalsy()

    await clickText('Create my copy & edit')
    await act(async () => {})

    // Fork happened via the existing clone route, against the right master.
    const clone = calls.find(c => c.method === 'POST' && c.url.includes('/drip-paths/clone'))
    expect(clone, 'the clone call').toBeTruthy()
    expect(clone!.body).toEqual({ master_id: MASTER_MOVING_D })

    // The editor opened on the CLONED step's content, not the master fixture.
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea, 'the step editor body field').toBeTruthy()
    expect(textarea.value).toBe('CLONED-BODY-ONE')

    // Save an edit → bulk replace against the CLONE id.
    await setNativeValue(textarea, 'OWNER EDITED BODY')
    await clickText('Save')
    await act(async () => {})

    const patch = stepsPatches().find(c => c.url.includes(COPY_ID))
    expect(patch, 'bulk steps PATCH against the clone').toBeTruthy()
    expect(patch!.body.steps[0].body).toBe('OWNER EDITED BODY')

    // The master was never written: no non-GET request addresses it, and the
    // owner surface never touches the per-step route at all.
    expect(calls.some(c => c.method !== 'GET' && c.url.includes(`/api/drip-paths/${MASTER_MOVING_D}`))).toBe(false)
    expect(perStepCalls()).toHaveLength(0)
  })

  it('the fork confirm states the snapshot consequence at the decision point', async () => {
    await mountPaths()
    await act(async () => { editButtons()[0].click() })

    const t = container.textContent || ''
    expect(t).toContain('snapshot')
    expect(t).toContain("won't reach your version")
    expect(t).toContain('Reset to master')
  })

  it('cancelling the fork confirm changes nothing', async () => {
    await mountPaths()
    await act(async () => { editButtons()[0].click() })
    await clickText('Cancel')

    expect(container.textContent).not.toContain('Customize these emails for your location?')
    expect(container.querySelector('textarea')).toBeFalsy()
    expect(calls.some(c => c.method !== 'GET')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('inline edit on an already-customized path', () => {
  beforeEach(() => { serverPaths = [CUSTOMIZED_PATH] })

  it('opens the editor directly (no fork confirm) and DROPS master_template_id on the edited step only', async () => {
    await mountPaths()
    await act(async () => { editButtons()[0].click() })

    // No gate — the location already owns this path.
    expect(container.textContent).not.toContain('Customize these emails for your location?')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('MY OWN BODY')

    await setNativeValue(textarea, 'REWRITTEN BY OWNER')
    await clickText('Save')
    await act(async () => {})

    const patch = stepsPatches()[0]
    expect(patch, 'the bulk steps PATCH').toBeTruthy()
    expect(calls.find(c => c.url.includes('/clone'))).toBeFalsy()

    const steps = patch.body.steps
    expect(steps[0].body).toBe('REWRITTEN BY OWNER')
    // Inline content is now the step's truth — the template pointer is gone.
    expect(steps[0].master_template_id).toBeNull()
    // The untouched step keeps its pointer: the drop is per-step, not a wipe.
    expect(steps[1].master_template_id).toBe('mt-2')
    expect(steps[1].body).toBe('MY BODY 2')
  })

  it('every commit goes through the bulk replace — no per-step save path, no batch Save button', async () => {
    await mountPaths()

    // Content edit.
    await act(async () => { editButtons()[0].click() })
    await setNativeValue(container.querySelector('textarea') as HTMLTextAreaElement, 'EDIT A')
    await clickText('Save')
    await act(async () => {})

    // Delay edit auto-commits too.
    await clickText('🕐 Immediately')
    const num = container.querySelector('input[type="number"]') as HTMLInputElement
    await setNativeValue(num, '3')
    await clickText('✓')
    await act(async () => {})

    expect(stepsPatches().length).toBeGreaterThanOrEqual(2)
    const delayPatch = stepsPatches()[1]
    expect(delayPatch.body.steps[0].delay_days).toBe(3)

    expect(perStepCalls()).toHaveLength(0)
    const t = container.textContent || ''
    expect(t).not.toContain('Save changes')
    expect(t).not.toContain('Save to my location')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('a commit failure leaves the sequence unchanged', () => {
  beforeEach(() => { serverPaths = [CUSTOMIZED_PATH] })

  it('failed content edit: editor surfaces the error, the row keeps its old content', async () => {
    await mountPaths()
    stepsPatchStatus = 500

    await act(async () => { editButtons()[0].click() })
    await setNativeValue(container.querySelector('textarea') as HTMLTextAreaElement, 'SHOULD-NOT-PERSIST')
    await clickText('Save')
    await act(async () => {})

    // The PATCH was attempted and refused; the editor stays open with the error.
    expect(stepsPatches()).toHaveLength(1)
    expect(container.querySelector('textarea'), 'editor stays open on failure').toBeTruthy()
    expect(container.textContent).toContain('insert_failed')

    await clickText('Cancel')
    const t = container.textContent || ''
    expect(t).toContain('MY OWN SUBJ')
    expect(t).not.toContain('SHOULD-NOT-PERSIST')
  })

  it('failed delay edit: the delay label reverts', async () => {
    await mountPaths()
    stepsPatchStatus = 500

    await clickText('🕐 Immediately')
    const num = container.querySelector('input[type="number"]') as HTMLInputElement
    await setNativeValue(num, '9')
    await clickText('✓')
    await act(async () => {})

    expect(stepsPatches()).toHaveLength(1)
    const t = container.textContent || ''
    expect(t).toContain('🕐 Immediately')
    expect(t).not.toContain('9 days after sign-up')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('preview parity — all 14 send-time variables render', () => {
  it('the step-row Preview fills rate, owner name, and both booking tags — no holes, no literal {{…}}', async () => {
    await mountPaths()
    await clickText('Preview')   // step 1 carries the all-14-tags body
    await act(async () => {})

    const t = container.textContent || ''
    // Every one of the 14 rendered as key=[value]; a hole would read key=[].
    for (const key of ALL_14) {
      expect(t, `hole for {{${key}}}`).not.toContain(`${key}=[]`)
    }
    expect(t).not.toContain('{{')

    // The named gaps from the 7-variable preview are filled with THIS
    // location's real values.
    expect(t).toContain('rate_per_hour=[$88/hr]')
    expect(t).toContain('owner_name=[Pat Owner]')
    expect(t).toContain('book_assessment_link=[https://cal.example/loc]')
    expect(t).toContain('owner_booking_link=[https://cal.example/loc]')
  })
})
