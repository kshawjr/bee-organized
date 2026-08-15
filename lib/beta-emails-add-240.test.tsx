// @vitest-environment happy-dom
//
// Issue 240 step 9b — append an email, and the origin column that makes it
// coexist with 8b's reset.
//
// THE SILENT FAILURE THIS SUITE EXISTS FOR: the steps route validator builds a
// fixed-shape object and DROPS UNKNOWN KEYS WITHOUT ERROR. If `origin` is
// missed there or in insertRows, the value never reaches the database, the
// shape guard falls back to comparing whole step_order sets, and reset returns
// to guessing by position — while appearing to work. A single write-then-read
// does not catch it. The round-trip test below saves TWICE, because the second
// save is where a value that was never persisted shows up as lost.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  EmailsList, AddEmailModal,
  dripShapeMatchesMaster, offerableStartingTemplates, appendedStepPosition,
  ADD_STEP_EXCLUDED_LEGACY_IDS, ADD_STEP_INTERVAL_DAYS,
} from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const step = (order: number, subject: string, extra: any = {}) => ({
  id: `s${order}`, order, type: 'email',
  delay_days: order === 1 ? 0 : order === 2 ? 5 : 30,
  subject, body: `${subject}\n\nSecond line.`, origin: 'master', ...extra,
})
const MASTER = [step(1, 'One'), step(2, 'Two'), step(3, 'Three')]
const tpl = (o: any) => ({
  dbId: o.dbId, legacyId: o.legacyId ?? null, name: o.name ?? '', type: o.type ?? 'email',
  subject: o.subject ?? '', body: o.body ?? '', isActive: o.isActive !== false,
  isMaster: o.isMaster !== false, isOwnCustom: !!o.isOwnCustom, clonedFromId: null, updatedAt: '2026-01-01',
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

// ───────────────── the origin round trip ─────────────────
describe('origin survives a full round trip, including a SECOND save', () => {
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
  const stepsRoute = readFileSync(join(process.cwd(), 'app/api/drip-paths/[id]/steps/route.ts'), 'utf8')
  const cloneRoute = readFileSync(join(process.cwd(), 'app/api/locations/[id]/drip-paths/clone/route.ts'), 'utf8')
  const getRoute = readFileSync(join(process.cwd(), 'app/api/locations/[id]/drip-paths/route.ts'), 'utf8')

  it('the validator NAMES origin — the one that fails silently', () => {
    expect(stepsRoute).toContain("origin: 'master' | 'added'")
    expect(stepsRoute).toContain("origin: raw.origin === 'added' ? 'added' : 'master'")
  })

  it('insertRows writes it — validated-but-not-inserted is the same failure', () => {
    const insert = stepsRoute.slice(stepsRoute.indexOf('const insertRows'), stepsRoute.indexOf('const { data: inserted'))
    expect(insert).toContain('origin: s.origin')
  })

  it('the clone writes master on every copied step', () => {
    expect(cloneRoute).toContain("origin: 'master'")
    expect(cloneRoute).toContain('is_active, origin')      // and reads it back
  })

  it('the GET selects AND maps it — selecting alone is not enough', () => {
    expect(getRoute).toContain('is_active, origin,')
    expect(getRoute).toContain("origin: (s as any).origin ?? 'master'")
  })

  it('the client reads it in and sends it back out', () => {
    expect(beehub).toContain("origin: s.origin === 'added' ? 'added' : 'master'")
    // Present in BOTH loadLocationPaths and the commitSteps payload.
    expect(beehub.match(/origin: s\.origin === 'added' \? 'added' : 'master'/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2)
  })

  it('SIMULATED ROUND TRIP: save, reload, save again — the value is still there', () => {
    // Models the real pipeline: client payload -> validator -> insert -> GET
    // map -> client map -> client payload again. A drop at any stage shows up
    // on the SECOND pass, which is the one a write-then-read test misses.
    const validator = (raw: any) => ({ step_order: raw.step_order, delay_days: raw.delay_days,
      channel: raw.channel, master_template_id: raw.master_template_id ?? null,
      subject: raw.subject ?? null, body: raw.body ?? null,
      origin: raw.origin === 'added' ? 'added' : 'master' })
    const insert = (v: any) => ({ ...v, id: `db_${Math.random()}`, is_active: true })
    const getMap = (row: any) => ({ ...row, origin: row.origin ?? 'master' })
    const clientMap = (row: any) => ({ order: row.step_order, delay_days: row.delay_days,
      type: row.channel, subject: row.subject, body: row.body,
      masterTemplateId: row.master_template_id,
      origin: row.origin === 'added' ? 'added' : 'master' })
    const clientPayload = (s: any) => ({ step_order: s.order, delay_days: s.delay_days,
      channel: s.type, master_template_id: s.masterTemplateId ?? null,
      subject: s.subject ?? null, body: s.body ?? null,
      origin: s.origin === 'added' ? 'added' : 'master' })

    let inFlight = clientPayload({ order: 4, delay_days: 44, type: 'email', subject: 'Added', body: 'x', origin: 'added' })
    // save 1
    let stored = insert(validator(inFlight))
    expect(stored.origin, 'after the first save').toBe('added')
    // reload
    let onClient = clientMap(getMap(stored))
    expect(onClient.origin, 'after reloading').toBe('added')
    // save 2 — the one that catches a value that never really persisted
    stored = insert(validator(clientPayload(onClient)))
    expect(stored.origin, 'after the SECOND save').toBe('added')
    // and a master step stays master through the same trip
    let m = insert(validator(clientPayload(clientMap(getMap(insert(validator(
      clientPayload({ order: 1, delay_days: 0, type: 'email', subject: 'One', body: 'x', origin: 'master' }))))))))
    expect(m.origin).toBe('master')
  })
})

// ───────────────── the shape guard with an added step ─────────────────
describe('reset survives an append', () => {
  it('an added step does not count against the shape comparison', () => {
    const withAdded = [...MASTER, step(4, 'Added', { origin: 'added' })]
    expect(dripShapeMatchesMaster(withAdded, MASTER)).toBe(true)
  })

  it('a step added WITHOUT the marker still breaks it — the marker is load-bearing', () => {
    const unmarked = [...MASTER, step(4, 'Added')]   // origin defaults to master
    expect(dripShapeMatchesMaster(unmarked, MASTER)).toBe(false)
  })

  it('a genuine mid-sequence divergence is still caught', () => {
    const missing = [step(1, 'One'), step(3, 'Three'), step(4, 'Added', { origin: 'added' })]
    expect(dripShapeMatchesMaster(missing, MASTER)).toBe(false)
  })
})

// ───────────────── append position and the send invariants ─────────────────
describe('where an appended step lands', () => {
  it('takes max(step_order) + 1, keeping the sequence contiguous', () => {
    expect(appendedStepPosition(MASTER).order).toBe(4)
    expect(appendedStepPosition([...MASTER, step(4, 'x', { origin: 'added' })]).order).toBe(5)
  })

  it('its delay is >= the predecessor, never lower', () => {
    const pos = appendedStepPosition(MASTER)
    expect(pos.prevDelay).toBe(30)
    expect(pos.delay_days).toBe(30 + ADD_STEP_INTERVAL_DAYS)
    expect(pos.delay_days).toBeGreaterThanOrEqual(pos.prevDelay)
  })

  it('an empty path starts at 1', () => {
    expect(appendedStepPosition([]).order).toBe(1)
  })
})

// ───────────────── the picker ─────────────────
describe('what may be offered as a starting point', () => {
  const LIB = [
    tpl({ dbId: 'w', legacyId: 'welcome', name: 'Welcome Email' }),
    tpl({ dbId: 'c3', legacyId: 'opp_closed_job_3mo', name: 'Closed Job 3mo' }),
    tpl({ dbId: 'c12', legacyId: 'opp_closed_job_12mo', name: 'Closed Job 12mo' }),
    tpl({ dbId: 'e1', legacyId: 'opp_organizing_estimate_3d', name: 'Organizing Estimate 3d' }),
    tpl({ dbId: 'e2', legacyId: 'opp_organizing_estimate_30d', name: 'Organizing Estimate 30d' }),
    tpl({ dbId: 'e3', legacyId: 'opp_moving_estimate_3d', name: 'Moving Estimate 3d' }),
    tpl({ dbId: 'e4', legacyId: 'opp_moving_estimate_30d', name: 'Moving Estimate 30d' }),
    tpl({ dbId: 'ok', legacyId: null, name: 'A General Nudge' }),
    tpl({ dbId: 'sms', legacyId: null, name: 'A Text', type: 'sms' }),
    tpl({ dbId: 'dead', legacyId: null, name: 'Quarantined', isActive: false }),
    tpl({ dbId: 'mine', legacyId: null, name: 'My Own', isMaster: false, isOwnCustom: true }),
  ]

  it('excludes the rows that already appear on this screen', () => {
    const names = offerableStartingTemplates(LIB).map(t => t.name)
    expect(names).not.toContain('Welcome Email')
    expect(names).not.toContain('Closed Job 3mo')
    expect(names).not.toContain('Closed Job 12mo')
  })

  it('excludes the four RETIRED estimate templates', () => {
    // Retired in step 3 because Jobber duplicates them; 80 pending were
    // cancelled. Offering them re-introduces cancelled content sideways.
    const names = offerableStartingTemplates(LIB).map(t => t.name)
    for (const n of ['Organizing Estimate 3d', 'Organizing Estimate 30d', 'Moving Estimate 3d', 'Moving Estimate 30d']) {
      expect(names, `must not offer ${n}`).not.toContain(n)
    }
    for (const id of ['opp_organizing_estimate_3d', 'opp_organizing_estimate_30d', 'opp_moving_estimate_3d', 'opp_moving_estimate_30d']) {
      expect(ADD_STEP_EXCLUDED_LEGACY_IDS).toContain(id)
    }
  })

  it('offers only active email masters, and is a DENY list so new ones appear automatically', () => {
    const out = offerableStartingTemplates(LIB)
    expect(out.map(t => t.name)).toEqual(['A General Nudge'])
    // A brand new library entry needs no code change to become offerable.
    const grown = offerableStartingTemplates([...LIB, tpl({ dbId: 'new', legacyId: null, name: 'Written Later' })])
    expect(grown.map(t => t.name)).toContain('Written Later')
  })
})

// ───────────────── the confirmation ─────────────────
describe('the confirmation tells this owner the truth about their location', () => {
  const mountModal = async (over: any = {}) => {
    const props = { templates: [], steps: MASTER, ownsPath: true, liveLeadCount: 0,
      busy: false, err: '', onCancel: vi.fn(), onConfirm: vi.fn(), ...over }
    await act(async () => { root.render(<AddEmailModal {...props} />) })
    return props
  }
  const text = () => container.textContent ?? ''

  it('owns the path, leads mid-sequence: says they WILL get it, with the live number', async () => {
    await mountModal({ ownsPath: true, liveLeadCount: 7 })
    expect(text()).toContain('7 people are')
    expect(text()).toContain('They’ll get this new email too')
  })

  it('owns the path, nobody mid-sequence: says only future people get it', async () => {
    await mountModal({ ownsPath: true, liveLeadCount: 0 })
    expect(text()).toContain('Nobody is partway through')
    expect(text()).not.toContain('They’ll get this new email too')
  })

  it('does NOT own the path: the OPPOSITE statement, plus the permanent consequence', async () => {
    await mountModal({ ownsPath: false, liveLeadCount: 0 })
    expect(text()).toContain('Nobody partway through this sequence will get this one')
    expect(text()).toContain('stops following Bee Organized')
    expect(text()).toContain('can’t be undone')
  })

  it('the two cases are not one sentence with a number swapped in', async () => {
    await mountModal({ ownsPath: true, liveLeadCount: 3 })
    const owned = text()
    await act(async () => { root.unmount() })
    container.remove(); container = document.createElement('div')
    document.body.appendChild(container); root = createRoot(container)
    await mountModal({ ownsPath: false, liveLeadCount: 3 })
    expect(text()).not.toBe(owned)
    // Opposite claims, not a shared sentence with a number substituted.
    expect(owned).toContain('They’ll get this new email too')
    expect(owned).not.toContain('Nobody partway through')
    expect(text()).toContain('Nobody partway through this sequence will get this one')
    expect(text()).not.toContain('They’ll get this new email too')
  })

  it('states where it lands and when, since timing is not editable here', async () => {
    await mountModal()
    expect(text()).toContain('end')
    expect(text()).toContain(`${30 + ADD_STEP_INTERVAL_DAYS} days`)
  })

  it('a picked template is described as a live link, not a copy', async () => {
    const LIB = [tpl({ dbId: 'ok', legacyId: null, name: 'A General Nudge' })]
    await mountModal({ templates: LIB })
    const pick = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('A General Nudge'))!
    await act(async () => { pick.click() })
    expect(text()).toContain('stays linked')
    expect(text()).toContain('isn’t a copy')
  })
})

// ───────────────── the list ─────────────────
describe('the list offers append, and nothing else', () => {
  const mount = async (over: any = {}) => {
    const props = {
      pathSteps: { p: MASTER }, masterSteps: { p: MASTER }, templates: [],
      generalDefault: 'p', moveDefault: 'p',
      actions: { edit: vi.fn(), reset: vi.fn(), add: vi.fn() }, sendConfig: {},
      ...over,
    }
    await act(async () => { root.render(<EmailsList {...props} />) })
    return props
  }
  const labels = () => Array.from(container.querySelectorAll('button')).map(b => b.textContent?.trim() ?? '')

  it('offers exactly one add, and no delete or insert', async () => {
    await mount()
    expect(labels().filter(l => l === '+ Add another email').length).toBe(1)
    for (const banned of ['Delete', 'Remove', 'Insert', 'Add above', 'Add below']) {
      expect(labels(), `must not offer "${banned}"`).not.toContain(banned)
    }
  })

  it('an added step offers no reset, and says why instead of showing a dead control', async () => {
    const withAdded = [...MASTER.map(s => ({ ...s, fromMaster: false })),
      { ...step(4, 'Added', { origin: 'added' }), fromMaster: false }]
    await mount({ pathSteps: { p: withAdded }, masterSteps: { p: MASTER } })
    await act(async () => {
      Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Read')[3].click()
    })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('no Bee Organized version to go back to')
    expect(Array.from(dialog.querySelectorAll('button')).map(b => b.textContent))
      .not.toContain('Put the Bee Organized wording back')
  })

  it('the other rows on that path KEEP their reset', async () => {
    const withAdded = [...MASTER.map(s => ({ ...s, fromMaster: false })),
      { ...step(4, 'Added', { origin: 'added' }), fromMaster: false }]
    await mount({ pathSteps: { p: withAdded }, masterSteps: { p: MASTER } })
    await act(async () => {
      Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Read')[0].click()
    })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(Array.from(dialog.querySelectorAll('button')).map(b => b.textContent))
      .toContain('Put the Bee Organized wording back')
  })
})
