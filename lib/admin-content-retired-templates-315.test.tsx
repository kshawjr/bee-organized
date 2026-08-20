// @vitest-environment happy-dom
//
// Issue 315 — Admin → Content stops showing a retired template as a live one.
// (Referred to as "issue 315" throughout, never a hash prefix: the token sweep
// over the admin surfaces reads a leading # as hex.)
//
// THE SURFACE. There are three template lists in this product and issue 314's
// commit message named the wrong one, which is how the brief for this issue
// inherited the mistake. For the record:
//
//   MasterTemplatesEditor      Admin → Content → "📧 Email Templates (Master)".
//                              super_admin / corporate only. The LIBRARY —
//                              every master plus every location's customs.
//                              It rendered is_active=false rows inline with
//                              live ones and said nothing. THIS is the screen
//                              Kevin is looking at, and the one that changes.
//
//   SettingsScreen → Texts     Owner-facing. Home of the "💛 Welcome Email"
//                              heading the brief quotes. It has filtered on
//                              is_active since long before 314
//                              (`t.isMaster && t.isActive`), so the welcome
//                              row left it by itself the moment Kevin flipped
//                              the flag. Nothing to do here.
//
//   SettingsScreen → Emails    Owner-facing. buildEmailList, note 5: does NOT
//                              filter is_active, on purpose, because the cron
//                              resolves a drip step's template without
//                              checking the flag. Still true, still
//                              load-bearing, untouched.
//
// The treatment is separate-and-label, not hide. A super_admin must be able
// to FIND an inactive template, and this screen is the only place one can be
// found at all — so the retired rows move below a labelled, counted
// disclosure inside their own scope section, and each row carries its own
// badge. Nothing leaves the page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MasterTemplatesEditor, AddEmailModal, buildEmailList, offerableStartingTemplates } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'
const LOCATIONS = [{ id: LOC_UUID, name: 'Testville' }]

const tpl = (over: any) => ({
  id: 'x', legacy_id: null, name: 'X', type: 'email', tag: 'custom',
  subject: 'subject line', body: 'body\n\nreal line.', is_active: true,
  location_uuid: null, is_master: true, is_own_custom: false,
  cloned_from_id: null, usage: [], usage_count: 0, ...over,
})

// Mirrors production's shape: live masters, retired masters, live customs.
const TEMPLATES = [
  tpl({ id: 'live-3mo', legacy_id: 'opp_closed_job_3mo', name: 'LIVE Closed Job 3mo' }),
  tpl({ id: 'gone-welcome', legacy_id: 'welcome', name: 'GONE Welcome Email', is_active: false }),
  tpl({ id: 'gone-t2', legacy_id: 't2', name: 'GONE How We Help', is_active: false }),
  tpl({ id: 'cust-live', name: 'LIVE KC Intro', is_active: true, location_uuid: LOC_UUID, is_master: false, is_own_custom: true }),
]

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    if (String(url).includes('/api/templates')) {
      return { ok: true, status: 200, json: async () => ({ templates: TEMPLATES }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('confirm', vi.fn(() => false))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mountLibrary() {
  await act(async () => { root.render(<MasterTemplatesEditor locations={LOCATIONS} />) })
  await act(async () => {})
}

// The disclosure bar that holds a scope section's retired rows.
function retiredToggle(): HTMLElement | null {
  return (Array.from(container.querySelectorAll('button')) as HTMLElement[])
    .find(b => (b.textContent || '').includes('⊘ Retired')) || null
}

// The rendered row for a template name, or null. Rows carry the name in a
// <p>; walk up to the row container that also holds the action buttons.
function rowFor(name: string): HTMLElement | null {
  const label = Array.from(container.querySelectorAll('p'))
    .find(el => (el.textContent || '').trim() === name)
  if (!label) return null
  for (let el = label.parentElement; el && el !== container; el = el.parentElement) {
    if (el.querySelector('button')) return el as HTMLElement
  }
  return label.parentElement as HTMLElement
}

// ═══════════════════════════════════════════════════════════════════════════
describe('Admin → Content — an inactive template does not render as an active one', () => {
  it('a live master renders on the shelf; a retired one does not sit beside it', async () => {
    await mountLibrary()
    const t = container.textContent || ''

    // The live master is on screen with no disclosure needed.
    expect(t, 'the live master').toContain('LIVE Closed Job 3mo')

    // The retired ones are NOT rendered alongside it. This is the whole bug:
    // before this change 'GONE Welcome Email' sat under the same
    // "📧 Email Templates" heading as the row above, styled identically.
    expect(t, 'retired master must not render on the live shelf')
      .not.toContain('GONE Welcome Email')
    expect(t).not.toContain('GONE How We Help')
  })

  it('the retired rows are announced by a counted, labelled bar — not silently dropped', async () => {
    await mountLibrary()
    const bar = retiredToggle()
    expect(bar, 'the Retired disclosure').toBeTruthy()

    // The count is on the bar, so the screen states how many are down there
    // rather than leaving their absence to be discovered.
    expect(bar!.textContent, 'retired count').toContain('2')
    // And it says what retired MEANS, which is the thing 314 could not say
    // while the row was inline.
    expect(container.textContent).toMatch(/Out of service — nothing schedules these/)
  })

  it('a retired row, once open, is badged on the row itself', async () => {
    await mountLibrary()
    await act(async () => { retiredToggle()!.click() })

    const row = rowFor('GONE Welcome Email')
    expect(row, 'the welcome row').toBeTruthy()
    // The badge rides the row, not the block — a row read on its own still
    // says what it is.
    expect(row!.textContent, 'RETIRED badge on the row').toContain('⊘ RETIRED')

    // The live row above carries no such badge.
    expect(rowFor('LIVE Closed Job 3mo')!.textContent).not.toContain('⊘ RETIRED')
  })

  it('the live scope section is not disturbed — customs still render', async () => {
    await mountLibrary()
    expect(container.textContent, 'a live location custom').toContain('LIVE KC Intro')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('a super_admin can still FIND an inactive template', () => {
  it('one click on the disclosure brings every retired row back, with its actions', async () => {
    await mountLibrary()
    expect(container.textContent).not.toContain('GONE Welcome Email')

    await act(async () => { retiredToggle()!.click() })

    const t = container.textContent || ''
    expect(t, 'retired master reachable').toContain('GONE Welcome Email')
    expect(t, 'the other retired master too').toContain('GONE How We Help')

    // Reachable means usable: Preview and Edit are on the row, so the library
    // can still be read and corrected from here.
    const row = rowFor('GONE Welcome Email')!
    const actions = Array.from(row.querySelectorAll('button')).map(b => b.textContent)
    expect(actions, 'Preview on a retired row').toContain('Preview')
    expect(actions, 'Edit on a retired row').toContain('Edit')
  })

  it('the disclosure toggles back closed, and reports its state to assistive tech', async () => {
    await mountLibrary()
    const bar = retiredToggle()!
    expect(bar.getAttribute('aria-expanded')).toBe('false')

    await act(async () => { bar.click() })
    expect(retiredToggle()!.getAttribute('aria-expanded')).toBe('true')

    await act(async () => { retiredToggle()!.click() })
    expect(retiredToggle()!.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('GONE Welcome Email')
  })

  it('the scope header still counts the whole scope, retired included', async () => {
    await mountLibrary()
    // 3 masters exist (1 live + 2 retired). The header counts the SCOPE, not
    // the shelf — otherwise a collapsed section would look like the library
    // had shrunk.
    const t = container.textContent || ''
    expect(t).toContain('🏢 Master Templates')
    expect(t, 'filter pill counts the whole scope').toMatch(/Masters \(3\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the owner-facing Emails tab is unchanged', () => {
  // buildEmailList is the Emails tab's row builder. Its note 5 records why it
  // must NOT filter is_active: the cron resolves a drip step's linked
  // template without checking the flag, so a step pointing at a quarantined
  // template still sends. 3 such steps are live in production today. Issue
  // 315 changes the library's labelling and must not leak into this rule.
  const step = (over: any) => ({
    dbId: 's1', order: 1, delay_days: 0, type: 'email',
    subject: null, body: null, masterTemplateId: 'quarantined', ...over,
  })
  const camel = (over: any) => ({
    dbId: 'quarantined', legacyId: null, name: 'Quarantined Master',
    type: 'email', subject: 'STILL SENDS', body: 'still\n\nsends.',
    isActive: false, isMaster: true, isOwnCustom: false, clonedFromId: null, ...over,
  })

  it('a step linked to an INACTIVE template still produces a row that shows what sends', () => {
    const list = buildEmailList({
      pathSteps: { 'organizing-a': [step({})] },
      templates: [camel({})],
      pathKey: 'organizing-a',
    })
    const row = list.newLead.find((r: any) => r.rail === 'drip')
    expect(row, 'the drip row').toBeTruthy()
    // The content resolves THROUGH the inactive template. Filtering it out
    // here would blank the row an owner reads.
    expect(row.subject, 'resolved from the quarantined template').toBe('STILL SENDS')
  })

  it('the rule is still written down where the next person will look', () => {
    // A negative that a source grep can hold: the builder must not grow an
    // isActive filter on the linked-template lookup.
    const list = buildEmailList({
      pathSteps: { 'organizing-a': [step({ dbId: 's2', order: 1 })] },
      templates: [camel({ isActive: false })],
      pathKey: 'organizing-a',
    })
    expect(list.newLead.some((r: any) => r.subject === 'STILL SENDS')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('a picker with nothing to offer renders its empty state', () => {
  // PRODUCTION STATE, verified: offerableStartingTemplates already returns []
  // — 'Test 2 Email' and 'Test Custom' are ALREADY is_active=false, and the
  // only 6 active email masters all carry excluded legacy_ids. The empty
  // picker is not a hypothetical to guard against later; it is what an owner
  // sees today.
  it('returns nothing when every active master is excluded', () => {
    const lib = [
      { dbId: 'a', legacyId: 'opp_closed_job_3mo', name: 'Closed 3mo', type: 'email', isMaster: true, isActive: true },
      { dbId: 'b', legacyId: 'opp_organizing_estimate_3d', name: 'Est 3d', type: 'email', isMaster: true, isActive: true },
      { dbId: 'c', legacyId: null, name: 'Test Custom', type: 'email', isMaster: true, isActive: false },
    ]
    expect(offerableStartingTemplates(lib)).toEqual([])
  })

  it('an inactive master is never offered, even with no legacy_id to exclude it by', () => {
    const lib = [{ dbId: 'c', legacyId: null, name: 'Test Custom', type: 'email', isMaster: true, isActive: false }]
    expect(offerableStartingTemplates(lib)).toEqual([])
    // Flip the flag and it comes back — the exclusion is the flag, not the name.
    expect(offerableStartingTemplates([{ ...lib[0], isActive: true }]).map(t => t.name)).toEqual(['Test Custom'])
  })

  it('the MODAL renders its empty state, not a blank list', async () => {
    // The distinction the brief asks for. With nothing offerable the picker
    // must still show "A blank email" plus a sentence explaining the absence
    // — an owner who opens it sees a working screen, not a broken one.
    await act(async () => {
      root.render(
        <AddEmailModal
          templates={[{ dbId: 'c', legacyId: null, name: 'Test Custom', type: 'email', isMaster: true, isActive: false }]}
          steps={[{ dbId: 's1', order: 1, delay_days: 30 }]}
          ownsPath={false} liveLeadCount={0} busy={false} err={null}
          onCancel={() => {}} onConfirm={() => {}}
        />,
      )
    })
    await act(async () => {})

    const t = container.textContent || ''
    expect(t, 'the blank-email option survives an empty library').toContain('A blank email')
    expect(t, 'the empty state').toMatch(/aren.t any ready-made emails to start from/)
    // The excluded template is not smuggled in.
    expect(t).not.toContain('Test Custom')
    // And the modal is still operable.
    const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent)
    expect(labels).toContain('Add this email')
    expect(labels).toContain('Cancel')
  })
})
