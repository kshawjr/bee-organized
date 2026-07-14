// @vitest-environment happy-dom
//
// 868kawwmh — the read-only BETA SURFACE, UI side. Two kinds of pin:
//   1) render tests on representative leaf write-components — the edit
//      affordance is ABSENT when readOnly, PRESENT when not (no
//      regression), and display content stays visible either way.
//   2) source pins on the wiring — BeeHub computes betaReadOnly and
//      threads it HiveScreen → HiveShell → every write-bearing child;
//      the write routes call the server guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import TagsRow from '@/components/hive/shared/TagsRow'
import NotesStream from '@/components/hive/NotesStream'
import MetaSelect from '@/components/hive/MetaSelect'
import PinnedBuzz from '@/components/hive/shared/PinnedBuzz'
import EngagementAssignees from '@/components/hive/shared/EngagementAssignees'

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const btnWith = (host: Element, text: string) =>
  Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').includes(text)) || null

beforeEach(() => {
  ;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
})

describe('TagsRow — read-only hides add + remove, keeps pills', () => {
  const TAGS = [{ id: 't1', label: 'VIP' }]
  const OPTS = [{ id: 't1', label: 'VIP' }, { id: 't2', label: 'Returning' }]

  it('writable: shows the + Tag affordance', async () => {
    const { host, unmount } = await mount(<TagsRow leadId="l1" tags={TAGS} options={OPTS} />)
    expect(host.textContent).toContain('VIP')
    expect((host.textContent || '')).toContain('+')
    await unmount()
  })

  it('readOnly: no + Tag, no remove ✗, but pills still render', async () => {
    const { host, unmount } = await mount(<TagsRow leadId="l1" tags={TAGS} options={OPTS} readOnly />)
    expect(host.textContent).toContain('VIP')           // display preserved
    expect(host.textContent || '').not.toContain('+ Tag')
    expect(host.textContent || '').not.toContain('✕')
    expect(host.textContent || '').not.toContain('✗')
    await unmount()
  })
})

describe('NotesStream — read-only hides the composer', () => {
  const ITEMS = [{ t: 'note', id: 'n1', text: 'Called client', ts: '2026-07-01T00:00:00Z', user_label: 'Kevin' }]

  it('writable: renders a composer input', async () => {
    const { host, unmount } = await mount(<NotesStream label="Activity" items={ITEMS} onPost={() => {}} />)
    expect(host.querySelector('input,textarea')).toBeTruthy()
    await unmount()
  })

  it('readOnly: no composer input, existing notes still shown', async () => {
    const { host, unmount } = await mount(<NotesStream label="Activity" items={ITEMS} onPost={() => {}} readOnly />)
    expect(host.querySelector('input,textarea')).toBeNull()
    expect(host.textContent).toContain('Called client')
    await unmount()
  })
})

describe('PinnedBuzz — read-only hides add affordances', () => {
  const NOTES = [{ id: 'b1', text: 'Prefers mornings', created_at: '2026-07-01T00:00:00Z', user_label: 'Kevin' }]

  it('writable, no buzz yet: shows the "Add buzz" affordance', async () => {
    const { host, unmount } = await mount(<PinnedBuzz notes={[]} onPost={() => {}} />)
    expect(host.querySelector('button[aria-label="Add buzz"]')).toBeTruthy()
    await unmount()
  })

  it('readOnly, no buzz yet: renders nothing (pure add affordance suppressed)', async () => {
    const { host, unmount } = await mount(<PinnedBuzz notes={[]} onPost={() => {}} readOnly />)
    expect((host.textContent || '').trim()).toBe('')
    await unmount()
  })

  it('readOnly with a buzz: note shown, no edit pencil, no input', async () => {
    const { host, unmount } = await mount(<PinnedBuzz notes={NOTES} onPost={() => {}} readOnly />)
    expect(host.textContent).toContain('Prefers mornings')
    expect(host.querySelector('[aria-label="Edit buzz"]')).toBeNull()
    expect(host.querySelector('input,textarea')).toBeNull()
    await unmount()
  })
})

describe('MetaSelect — read-only renders static value, no trigger', () => {
  const OPTS = [{ value: 'Referral', label: 'Referral' }, { value: 'Google', label: 'Google' }]

  it('writable: renders a clickable trigger', async () => {
    const { host, unmount } = await mount(<MetaSelect label="Source" value="Referral" options={OPTS} onPick={() => {}} />)
    expect(host.querySelector('button')).toBeTruthy()
    await unmount()
  })

  it('readOnly: no button/trigger, value still shown', async () => {
    const { host, unmount } = await mount(<MetaSelect label="Source" value="Referral" options={OPTS} onPick={() => {}} readOnly />)
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain('Referral')
    await unmount()
  })
})

describe('EngagementAssignees — read-only hides assign + unassign, keeps names', () => {
  const USERS = [{ id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', locationId: 'loc-1', jobberUserId: 'j1' }]
  const ASSIGNED = [{ hub_user_id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', jobber_user_id: 'j1' }]

  it('writable: shows + Assign and an unassign control', async () => {
    const { host, unmount } = await mount(
      <EngagementAssignees engagementId="eng-1" assignees={ASSIGNED} users={USERS} jobberConnected onChange={() => {}} setToast={() => {}} />
    )
    expect(btnWith(host, '+ Assign')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Unassign Kevin Shaw"]')).toBeTruthy()
    await unmount()
  })

  it('readOnly: no + Assign, no unassign, name still shown', async () => {
    const { host, unmount } = await mount(
      <EngagementAssignees engagementId="eng-1" assignees={ASSIGNED} users={USERS} jobberConnected onChange={() => {}} setToast={() => {}} readOnly />
    )
    expect(btnWith(host, '+ Assign')).toBeNull()
    expect(host.querySelector('button[aria-label="Unassign Kevin Shaw"]')).toBeNull()
    expect(host.textContent).toContain('Kevin Shaw')
    await unmount()
  })
})

// ── Wiring source-pins ───────────────────────────────────────────
describe('read-only wiring (source pins)', () => {
  it('BeeHub computes betaReadOnly via resolveBetaReadOnly and threads it to the live Hive mount', () => {
    const src = readFileSync('components/BeeHub.jsx', 'utf8')
    expect(src).toContain('resolveBetaReadOnly')
    expect(src).toMatch(/const betaReadOnly = resolveBetaReadOnly\(/)
    // the live hive mount (activeNav==='hive') forwards it as readOnly
    expect(src).toContain('readOnly={betaReadOnly}')
    // HiveScreen forwards its readOnly into the beta HiveShell
    expect(src).toMatch(/<HiveShell[\s\S]{0,400}readOnly=\{readOnly\}/)
  })

  it('betaGate.resolveBetaReadOnly excludes past_due and elevated, includes viewer/paused', () => {
    const src = readFileSync('components/hive/shared/betaGate.js', 'utf8')
    expect(src).toContain('export function resolveBetaReadOnly')
    expect(src).toContain("'viewer'")
    expect(src).toContain("crmStatus === 'inactive'")
    // elevated short-circuit
    expect(src).toMatch(/super_admin'\s*\|\|\s*role === 'corporate'/)
  })

  it('HiveShell threads readOnly to every write-bearing child', () => {
    const src = readFileSync('components/hive/HiveShell.jsx', 'utf8')
    // PersonCard is no longer a HiveShell overlay child — lead detail is
    // unified on ClientProfile (record-id-in-URL work). It still accepts
    // readOnly as a standalone component; it's just not mounted here.
    for (const child of ['InboxScreen', 'EngagementBoard', 'NewClientSheet', 'EngagementPanel', 'ClientProfile']) {
      const re = new RegExp(`<${child}[\\s\\S]{0,600}readOnly=\\{readOnly\\}`)
      expect(src, `${child} should receive readOnly`).toMatch(re)
    }
    // the "New" client pill is suppressed when readOnly
    expect(src).toMatch(/newPillEl = readOnly \? null/)
  })

  it('the server write routes call the shared read-only guard', () => {
    const routes = [
      'app/api/leads/[id]/route.ts',
      'app/api/engagements/[id]/route.ts',
      'app/api/engagements/[id]/assignees/route.ts',
      'app/api/lead-notes/[id]/route.ts',
      'app/api/lead-tags/route.ts',
      'app/api/touchpoints/route.ts',
      'app/api/partners/route.ts',
    ]
    for (const r of routes) {
      const src = readFileSync(r, 'utf8')
      expect(src, `${r} should import the guard`).toContain('read-only-access')
    }
  })
})
