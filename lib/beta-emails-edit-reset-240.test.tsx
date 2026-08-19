// @vitest-environment happy-dom
//
// Issue 240 step 8b — Edit and reset on the Emails list.
//
// Two rails that fork DIFFERENTLY. Get it wrong and an owner's edit either
// does nothing or changes what another location receives:
//   Rail A (drip steps)  the PATH is shared → clone the path, write inline.
//                        No master drip step points at a template (24 of 24 are
//                        inline in production), so there is nothing to repoint.
//   Rail C (closed job,  the TEMPLATE row is shared → duplicate it and patch
//   closed job)          the copy. No step is touched.
//
// Reset overrides SUBJECT and BODY only on BOTH rails, so it is one promise on
// every row — mirroring mergeForkOverMaster. Rail A's reset leaves delay_days
// alone: timing is step 10's.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EmailsList, dripShapeMatchesMaster } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const step = (order: number, subject: string, extra: any = {}) => ({
  id: `master_organizing-a_${order}`, order, type: 'email',
  delay_days: order === 1 ? 0 : order === 2 ? 5 : 30,
  subject, body: `${subject}\n\nSecond line of ${subject}.`, fromMaster: true, ...extra,
})
const MASTER_STEPS = [step(1, 'MASTER ONE'), step(2, 'MASTER TWO'), step(3, 'MASTER THREE')]

const tpl = (o: any) => ({
  dbId: o.dbId, legacyId: o.legacyId ?? null, name: o.name ?? '', type: 'email',
  subject: o.subject, body: o.body, isActive: o.isActive !== false,
  isMaster: !!o.isMaster, isOwnCustom: !!o.isOwnCustom,
  clonedFromId: o.clonedFromId ?? null, updatedAt: o.updatedAt ?? '2026-01-01',
})
const TEMPLATES = [
  tpl({ dbId: 't-welcome', legacyId: 'welcome', isMaster: true, subject: 'Welcome!', body: 'Welcome\n\nSecond.' }),
  tpl({ dbId: 't-3mo', legacyId: 'opp_closed_job_3mo', isMaster: true, subject: '3mo', body: '3mo\n\nSecond.' }),
  tpl({ dbId: 't-12mo', legacyId: 'opp_closed_job_12mo', isMaster: true, subject: '12mo', body: '12mo\n\nSecond.' }),
]

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const mount = async (over: any = {}) => {
  const props = {
    pathSteps: { 'organizing-a': MASTER_STEPS },
    masterSteps: { 'organizing-a': MASTER_STEPS },
    templates: TEMPLATES, generalDefault: 'organizing-a', moveDefault: 'organizing-a',
    actions: { edit: vi.fn(), reset: vi.fn() },
    ...over,
  }
  await act(async () => { root.render(<EmailsList {...props} />) })
  return props
}
const buttons = (label: string) =>
  Array.from(container.querySelectorAll('button')).filter(b => b.textContent?.trim() === label)

// ───────────────────────── the shape guard ─────────────────────────
describe('the shape guard', () => {
  it('matches when the fork mirrors its master', () => {
    expect(dripShapeMatchesMaster(MASTER_STEPS, MASTER_STEPS)).toBe(true)
  })

  it('rejects the real loc_test drift: fork [1,2,3,4,5] vs master [1,2,3]', () => {
    const drifted = [...MASTER_STEPS, step(4, 'ADDED FOUR'), step(5, 'ADDED FIVE')]
    expect(dripShapeMatchesMaster(drifted, MASTER_STEPS)).toBe(false)
  })

  it('rejects a mid-sequence insert, which is indistinguishable from an append after the fact', () => {
    expect(dripShapeMatchesMaster([step(1, 'a'), step(2, 'b'), step(3, 'c'), step(4, 'd')], MASTER_STEPS)).toBe(false)
  })

  it('rejects a deletion', () => {
    expect(dripShapeMatchesMaster([step(1, 'a'), step(2, 'b')], MASTER_STEPS)).toBe(false)
  })

  it('refuses when there is no master to restore from', () => {
    expect(dripShapeMatchesMaster(MASTER_STEPS, [])).toBe(false)
  })

  it('order of the arrays does not matter — it compares the sorted sequence', () => {
    expect(dripShapeMatchesMaster([step(3, 'c'), step(1, 'a'), step(2, 'b')], MASTER_STEPS)).toBe(true)
  })
})

// ───────────────────────── the affordances ─────────────────────────
describe('Edit appears on every row, and never adds or deletes', () => {
  // issue 314 — was six. Group one lost the retired welcome row.
  it('all five rows offer Edit alongside Read', async () => {
    await mount()
    expect(buttons('Read').length).toBe(5)
    expect(buttons('Edit').length).toBe(5)
  })

  it('there is no add affordance and no delete — the only thing that can drift a shape', async () => {
    await mount()
    const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent?.trim() ?? '')
    for (const banned of ['+ Add another email', 'Add another email', '＋ Add another email', 'Delete', 'Remove', '+ Add step']) {
      expect(labels, `must not offer "${banned}"`).not.toContain(banned)
    }
  })

  it('a read-only mount (no actions) offers no Edit at all', async () => {
    await mount({ actions: null })
    expect(buttons('Read').length).toBe(5)
    expect(buttons('Edit').length).toBe(0)
  })

  it('Edit hands back the row, with the identifiers each rail needs', async () => {
    const props = await mount()
    await act(async () => { buttons('Edit')[0].click() })
    const row = props.actions.edit.mock.calls[0][0]
    expect(row.rail).toBe('drip')
    expect(row.pathKey).toBe('organizing-a')   // rail A acts on (pathKey, order)
    expect(row.order).toBe(1)

    await act(async () => { buttons('Edit')[3].click() })   // first closed-job row (was [4])
    const stageRow = props.actions.edit.mock.calls[1][0]
    expect(stageRow.rail).toBe('stage')
    expect(stageRow.masterDbId).toBe('t-3mo')  // rail B/C acts on the template
    expect(stageRow.forkDbId).toBeNull()
  })
})

// ───────────────────────── reset, and when it is refused ─────────────────────────
describe('reset', () => {
  const forked = { 'organizing-a': MASTER_STEPS.map(s => ({ ...s, fromMaster: false, dbId: `db${s.order}` })) }

  const openFirstRow = async () => {
    await act(async () => { buttons('Read')[0].click() })
  }

  it('is offered only on a row the owner has actually changed', async () => {
    await mount()          // every row is master wording
    await openFirstRow()
    expect(container.textContent).not.toContain('Put the Bee Organized wording back')
  })

  it('appears on a changed row when the shape matches', async () => {
    await mount({ pathSteps: forked })
    await openFirstRow()
    expect(container.textContent).toContain("You've changed this one")
    expect(buttons('Put the Bee Organized wording back').length).toBe(1)
  })

  it('is DISABLED with a stated reason when the shape has drifted, never hidden', async () => {
    const drifted = { 'organizing-a': [...forked['organizing-a'], { ...step(4, 'ADDED'), fromMaster: false, dbId: 'db4' }] }
    await mount({ pathSteps: drifted })
    await openFirstRow()
    expect(buttons('Put the Bee Organized wording back').length).toBe(0)
    expect(container.textContent).toContain("Can't undo this")
    expect(container.textContent).toContain('added to or reordered')
  })

  it('disables reset for EVERY row on a drifted path, not just the suspect one', async () => {
    const drifted = { 'organizing-a': [...forked['organizing-a'], { ...step(4, 'ADDED'), fromMaster: false, dbId: 'db4' }] }
    await mount({ pathSteps: drifted })
    for (const i of [0, 2, 3]) {
      await act(async () => { buttons('Read')[i].click() })
      expect(buttons('Put the Bee Organized wording back').length, `row ${i}`).toBe(0)
      await act(async () => { (Array.from(container.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Close') as HTMLElement).click() })
    }
  })

  it('a stage row with a fork can always reset — its shape guard does not apply', async () => {
    const withFork = [...TEMPLATES, tpl({ dbId: 'f1', isOwnCustom: true, clonedFromId: 't-3mo', subject: 'Ours', body: 'Ours\n\nSecond.' })]
    await mount({ templates: withFork })
    await act(async () => { buttons('Read')[3].click() })
    expect(container.textContent).toContain("You've changed this one")
    expect(buttons('Put the Bee Organized wording back').length).toBe(1)
  })

  it('hands the row back with the fork id the delete needs', async () => {
    const withFork = [...TEMPLATES, tpl({ dbId: 'f1', isOwnCustom: true, clonedFromId: 't-3mo', subject: 'Ours', body: 'Ours\n\nSecond.' })]
    const props = await mount({ templates: withFork })
    await act(async () => { buttons('Read')[3].click() })
    await act(async () => { buttons('Put the Bee Organized wording back')[0].click() })
    expect(props.actions.reset).toHaveBeenCalledTimes(1)
    expect(props.actions.reset.mock.calls[0][0].forkDbId).toBe('f1')
  })
})

// ───────────────────── the write paths, pinned at source ─────────────────────
describe('the two rails write differently, and the master is never written', () => {
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
  // emailsSaveTemplateEdit sits BETWEEN edit and reset, so bound the slice on
  // it — otherwise rail A's slice swallows rail B/C's duplicate call.
  const edit = beehub.slice(beehub.indexOf('async function emailsRowEdit('), beehub.indexOf("  // Create-or-reuse the location's fork"))
  const reset = beehub.slice(beehub.indexOf('async function emailsRowReset('), beehub.indexOf('  function ensureOwnedThen('))
  const save = beehub.slice(beehub.indexOf('async function emailsSaveTemplateEdit('), beehub.indexOf('async function emailsRowReset('))

  it('rail A edit goes through ensureOwnedThen — which clones only if unowned', () => {
    // ensureOwnedThen returns early when dbPaths[pathId] exists, so an
    // already-owned path is never cloned twice.
    expect(edit).toContain('ensureOwnedThen(row.pathKey')
    const guard = beehub.slice(beehub.indexOf('function ensureOwnedThen('), beehub.indexOf('function ensureOwnedThen(') + 500)
    expect(guard).toContain('if (dbPaths[pathId])')
    expect(guard).toContain('setForkConfirm')
  })

  it('rail A edit forks no template and repoints nothing', () => {
    // Assert on CALLS, not on the word: the neighbouring comment legitimately
    // names the duplicate route when explaining what rail B/C does.
    expect(edit).not.toContain('fetch(')
    expect(edit).not.toContain('master_template_id')
    expect(edit).not.toContain('cloned_from_id')
  })

  it('rail B/C edit duplicates the master then patches the COPY, never the master', () => {
    expect(save).toContain('/duplicate')
    expect(save).toContain('`/api/templates/${forkId}`')
    expect(save).toContain("method:'PATCH'")
    // The only id ever PATCHed is the fork's.
    expect(save).not.toContain('`/api/templates/${row.masterDbId}`')
  })

  it('rail B/C reset deletes the fork; the send path falls back on the next resolve', () => {
    expect(reset).toContain("method:'DELETE'")
    expect(reset).toContain('row.forkDbId')
  })

  it('rail A reset builds its payload from a FRESH read, not stale client state', () => {
    expect(reset).toContain('await loadLocationPaths()')
    expect(reset).toContain('fresh?.steps?.[row.pathKey]')
  })

  it('rail A reset re-checks the shape guard server-side of the UI', () => {
    expect(reset).toContain('dripShapeMatchesMaster(steps, master)')
  })

  it('reset restores SUBJECT and BODY only — delay_days is untouched on both rails', () => {
    expect(reset).toContain('subject: src.subject')
    expect(reset).toContain('body: src.body')
    expect(reset).not.toContain('delay_days: src.delay_days')
    expect(reset).not.toContain('delay: ')
  })
})
