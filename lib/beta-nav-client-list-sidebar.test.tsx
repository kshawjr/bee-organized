// @vitest-environment happy-dom
//
// Nav placement, 2026-09-11 — two renames and one move.
//
//   · "Inbox (New)"  → "Inbox (New Leads)"
//   · "Engagements"  → "Engagements in Jobber"
//   · The client list leaves the top tab row and becomes a NESTED item in the
//     left sidebar under Clients, labelled "Everyone" (renamed 2026-09-11).
//     The top row is two tabs.
//
// Nothing about the view changed — same lens key, same ClientGroupedList, same
// data. Only the control that reaches it moved.
//
// THE ONE THAT WOULD ACTUALLY HURT: 'clients' is still the lens key, and real
// machines already have bee_hive_beta_lens = 'clients' in localStorage from
// before this move. If that stopped resolving, those people reload straight
// onto a blank screen with no tab left to click and no way back. The stored-
// lens tests below are the guard, and the mutation test for them is the point
// of this file.
//
// The sidebar itself lives in components/BeeHub.jsx — a ~38k-line component
// that no test in this repo mounts. Its nav is asserted the way
// beta-nav-swap.test.tsx asserts it: against the source, at the one place nav
// entries are declared. The BEHAVIOUR those entries drive (reaching the lens
// via a { tab:'clients' } intent) is executed for real against HiveShell.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { renderToString } from 'react-dom/server'
import HiveShell from '@/components/hive/HiveShell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const BEEHUB = readFileSync('components/BeeHub.jsx', 'utf8')
const SHELL = readFileSync('components/hive/HiveShell.jsx', 'utf8')
const LOC = 'loc-uuid-1'
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell', email: 'sarah@email.com', phone: '(561) 555-0199',
  locationId: LOC, created: daysAgo(3),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null,
  outreachTimeline: [], atLocOther: false, paused: false,
  originCity: null, originState: null, originZip: null, project: '',
  ...over,
})

// happy-dom ships no localStorage and the shell try/catches around it, so
// without this the stored-lens tests would be vacuous — they would pass on a
// shell that read nothing at all.
beforeEach(() => {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
})

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

const mount = async (props: any = {}) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => {
    root.render(React.createElement(HiveShell as any, {
      people: [person()], engagements: [], locFilter: LOC, ...props,
    }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return host
}

const tabRow = (host: Element) => host.querySelector('[style*="overflow-x"]')
const tabLabels = (host: Element) =>
  Array.from(host.querySelectorAll('button')).map(b => (b.textContent || '').trim())
// ClientGroupedList's own search field — present only when that lens renders,
// so it is how "the client list is actually on screen" is asserted rather than
// "the screen is not blank".
const clientListShowing = (host: Element) =>
  // The Everyone search box, by its own label — the Inbox grew a search box
  // with the same placeholder text (2026-10-16), so the placeholder no longer
  // tells the two screens apart.
  !!host.querySelector('input[aria-label="Search clients"]')

// ═══════════════════════════════════════════════════════════
// The two renames.
// ═══════════════════════════════════════════════════════════
describe('the renamed tabs', () => {
  it('renders "Inbox (New Leads)" and "Engagements in Jobber"', async () => {
    const host = await mount()
    const labels = tabLabels(host).join(' | ')
    expect(labels).toContain('Inbox (New Leads)')
    expect(labels).toContain('Engagements in Jobber')
  })

  it('the old labels are gone', () => {
    expect(SHELL).not.toContain("label: 'Inbox (New)'")
    expect(SHELL).not.toContain("label: 'Engagements',")
  })

  it('the labels are the ONLY thing that changed — both tabs keep their count badge', async () => {
    const html = renderToString(React.createElement(HiveShell as any, {
      people: [person(), person({ id: 'p2', name: 'Dana Reed' })],
      engagements: [], locFilter: LOC,
    }))
    // Two New leads, no engagements: the Inbox badge still counts, and the
    // Engagements tab still renders its own badge slot.
    expect(html).toMatch(/Inbox \(New Leads\)<span[^>]*>2<\/span>/)
    expect(html).toContain('Engagements in Jobber')
  })

  it('the longer label cannot wrap, overflow the row, or push "+ New" off', () => {
    // Structural, not a pixel measurement — these three properties are what
    // make the length safe at any width, and all three predate this change.
    //   · every pill is nowrap, so a long label never wraps to a second line
    //   · the pill STRIP is flex:1 minWidth:0 overflowX:auto, so if the labels
    //     ever exceed the row they scroll inside it rather than pushing out
    //   · the right cluster holding "+ New" is flexShrink:0, so it cannot be
    //     compressed or displaced by anything to its left
    expect(SHELL).toContain("whiteSpace: 'nowrap'")
    expect(SHELL).toContain("flex: 1, minWidth: 0, overflowX: 'auto'")
    expect(SHELL).toMatch(/gap: '12px', flexShrink: 0 \}\}>\s*\{newPillEl\}/)
  })
})

// ═══════════════════════════════════════════════════════════
// Client List is out of the tab row.
// ═══════════════════════════════════════════════════════════
describe('Client List has left the top tab row', () => {
  it('is not a tab', async () => {
    const host = await mount()
    expect(tabLabels(host).join(' | ')).not.toContain('Client List')
    expect(tabRow(host)!.textContent).not.toContain('Client List')
  })

  it('the TABS array carries exactly two entries', () => {
    const block = SHELL.slice(SHELL.indexOf('const TABS = ['), SHELL.indexOf('const TABS = [') + 400)
    expect(block).toContain("key: 'inbox'")
    expect(block).toContain("key: 'engagements'")
    expect(block).not.toContain("key: 'clients'")
  })

  it('its count went with it — deliberately dropped, not re-homed', () => {
    // The sidebar carries no counts anywhere, and total clients is inventory
    // rather than work. Recomputing it elsewhere just to decorate a nav item
    // would also put a second derivation of one number in a second file.
    expect(SHELL).not.toContain('clientCount')
    expect(SHELL).toContain('{ inbox: null, engagements: null }')
  })
})

// ═══════════════════════════════════════════════════════════
// …and is in the sidebar, under Clients.
// ═══════════════════════════════════════════════════════════
// ── "Everyone" LEFT THE MENU on 2026-11-13 (the menu rebuild; Kevin's ruling:
// nurturing moves into the Network & Nurture work). It had been nested under
// Clients since 2026-09-10. The client list itself is untouched — the lens,
// its key and the way in from Home are all still here — it just has no menu
// row. These replace the seven tests that pinned the nested row.
describe('Client List is no longer a row in the menu', () => {
  const navBlock = BEEHUB.slice(BEEHUB.indexOf('const navItems = ['), BEEHUB.indexOf('const navItems = [') + 2500)
  const RAIL = readFileSync('components/design/AppRail.jsx', 'utf8')

  it('there is no "Everyone" or "Client List" nav item, and Clients has no children', () => {
    const items = navBlock.slice(0, navBlock.indexOf('\n  ]\n'))
    expect(items).not.toMatch(/label:'Everyone'/)
    expect(items).not.toMatch(/label: ?'Client List'/)
    expect(items).not.toContain('children:[')
    expect(items).not.toContain("key:'hive-clients'")
    expect(items).toContain("{ key:'hive',     icon:'🐝', label:'Clients' },")
    expect(BEEHUB).not.toMatch(/label: ?'Client List'/)
    expect(SHELL).not.toMatch(/label: ?'Client List'/)
  })

  it('the menu draws no nested rows at all', () => {
    expect(BEEHUB).not.toContain('(item.children||[]).map(')
    expect(RAIL).not.toMatch(/item\.children|child\.|onPick\(child/)
    expect(BEEHUB).not.toContain('const childActive')
  })

  it('the client list is still THERE: the lens key, its storage key and the way in are untouched', () => {
    expect(BEEHUB).toContain("setHiveIntent({ tab: 'clients' })")
    expect(BEEHUB).toContain('const openClientListLens = () => {')
    expect(SHELL).toContain("const LENS_LS_KEY = 'bee_hive_beta_lens'")
  })

  // With the row gone, Home's tile is the way in (2026-11-13). It was a number
  // with no link, labelled "Everyone"; Kevin renamed it "Clients" and it now
  // calls the very function the menu row called. Clicked through per role in
  // lib/home-clients-tile.test.tsx.
  it('Home’s "Clients" tile is the way in, by the same function the menu row called', () => {
    expect(BEEHUB).not.toContain('<HomeMetricTile label="Everyone"')
    const at = BEEHUB.indexOf('<HomeMetricTile label="Clients" testId="home-everyone"')
    expect(at).toBeGreaterThan(0)
    expect(BEEHUB.slice(at, at + 400)).toContain('onOpen={onOpenClientList}')
    expect(BEEHUB).toContain('onOpenClientList={openClientListLens}')
  })

  it('the sidebar reaches the lens the SAME way Home’s deep links already do', () => {
    // Not a second way in that could drift from onOpenHive.
    expect(BEEHUB).toContain("setHiveIntent({ tab: 'clients' })")
    expect(BEEHUB).toContain('const openClientListLens = () =>')
  })

  it('the shell reports its lens up so the sidebar can mark the item', () => {
    expect(SHELL).toContain('onLensChange')
    expect(SHELL).toContain('useEffect(() => { onLensChange(lens) }, [lens])')
    expect(BEEHUB).toContain('onLensChange={setHiveLens}')
  })
})

// ═══════════════════════════════════════════════════════════
// THE GUARD: a saved lens of 'clients' must still resolve.
// ═══════════════════════════════════════════════════════════
describe('a stored lens pointing at the Client List still resolves', () => {
  it('a machine carrying bee_hive_beta_lens="clients" lands on the Client List, not a blank screen', async () => {
    localStorage.setItem('bee_hive_beta_lens', 'clients')
    const host = await mount()
    expect(clientListShowing(host), 'the Client List must render for a stored lens of "clients"').toBe(true)
    // And it is genuinely that view with real rows behind it, not an empty
    // shell. The status bands start COLLAPSED (their own remembered state), so
    // the assertion is the band and its count, not the person's name.
    expect(host.textContent).toMatch(/New.*·.*1/)
  })

  it("the hydration whitelist still accepts 'clients'", () => {
    expect(SHELL).toContain("['inbox', 'engagements', 'clients'].includes(v)")
  })

  it('the lens key itself is unchanged, so nothing stored needs migrating', () => {
    expect(SHELL).toContain("const LENS_LS_KEY = 'bee_hive_beta_lens'")
  })

  it('selecting it from the sidebar shows the client list view', async () => {
    // The sidebar hands the shell the intent; this is that journey, executed.
    const host = await mount({ initialIntent: { tab: 'clients' } })
    expect(clientListShowing(host)).toBe(true)
  })

  it('the intent applies while the shell is ALREADY mounted', async () => {
    // Every previous intent caller lived on another screen, so a new intent
    // always coincided with a mount and mount-only deps looked correct. The
    // sidebar item is the first that can fire with the shell already up — on
    // mount-only deps its click would do nothing at all.
    const consumed = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })

    const render = (intent: any) => act(async () => {
      root.render(React.createElement(HiveShell as any, {
        people: [person()], engagements: [], locFilter: LOC,
        initialIntent: intent, onIntentConsumed: consumed,
      }))
    })

    await render(null)                       // opens on the remembered lens
    expect(clientListShowing(host)).toBe(false)
    await render({ tab: 'clients' })         // …the sidebar item fires
    expect(clientListShowing(host)).toBe(true)
    expect(consumed).toHaveBeenCalled()
  })

  it('a stored lens of "inbox" or "engagements" is untouched by the move', async () => {
    localStorage.setItem('bee_hive_beta_lens', 'inbox')
    const host = await mount()
    expect(clientListShowing(host)).toBe(false)
    expect(host.textContent).toContain('Inbox (New Leads)')
  })

  it('a legacy stored "board"/"list" value still migrates to Engagements', async () => {
    localStorage.setItem('bee_hive_beta_lens', 'board')
    const host = await mount()
    expect(clientListShowing(host)).toBe(false)
    expect(host.textContent).toContain('Engagements in Jobber')
  })
})
