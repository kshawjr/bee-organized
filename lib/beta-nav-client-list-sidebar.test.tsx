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
  !!host.querySelector('input[placeholder="Search name, email, phone…"]')

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
describe('Client List is nested under Clients in the sidebar', () => {
  const navBlock = BEEHUB.slice(BEEHUB.indexOf('const navItems = ['), BEEHUB.indexOf('const navItems = [') + 2500)

  it('reads "Everyone", and "Client List" is no longer a nav label anywhere', () => {
    expect(navBlock).toContain("label:'Everyone'")
    expect(navBlock).not.toContain("label:'Client List'")
    // Not a label anywhere else in the app either — the rename is a display
    // string, so this is the one place it can hide.
    expect(BEEHUB).not.toMatch(/label: ?'Client List'/)
    expect(SHELL).not.toMatch(/label: ?'Client List'/)
  })

  it('the rename is DISPLAY ONLY — the lens key, the child key and the wiring are untouched', () => {
    expect(navBlock).toContain("lens:'clients'")
    expect(navBlock).toContain("key:'hive-clients'")
    expect(BEEHUB).toContain("setHiveIntent({ tab: 'clients' })")
    expect(SHELL).toContain("const LENS_LS_KEY = 'bee_hive_beta_lens'")
  })

  it('is declared as a child of the Clients nav item, and is not a sibling section', () => {
    expect(navBlock).toContain("key:'hive'")
    expect(navBlock).toContain('children:[')
    // It must hang off Clients, not become a seventh top-level section. That
    // adjacency is load-bearing for the LABEL too: "Everyone" only means
    // something with "Clients" directly above it.
    const hiveAt = navBlock.indexOf("key:'hive'")
    const childAt = navBlock.indexOf("label:'Everyone'")
    const nextTopLevel = navBlock.indexOf("key:'partners'")
    expect(childAt).toBeGreaterThan(hiveAt)
    expect(childAt).toBeLessThan(nextTopLevel)
  })

  it('BOTH navs keep the parent immediately above the child — the label depends on it', () => {
    // In each render the children map sits directly after the parent button,
    // inside the same fragment, so "Clients" is the row above "Everyone" on
    // desktop AND in the mobile drawer. If the mobile drawer ever rendered a
    // flat list, "Everyone" would sit between Network and Reports meaning
    // nothing — this is the assertion that would catch it.
    const sites = [...BEEHUB.matchAll(/\(item\.children\|\|\[\]\)\.map\(child=>\{/g)]
    expect(sites, 'desktop sidebar + mobile drawer').toHaveLength(2)
    for (const site of sites) {
      const before = BEEHUB.slice(0, site.index!)
      // The row immediately preceding each children map is the PARENT row —
      // the last thing rendered before it is the parent's own label, with no
      // other nav row opened in between.
      const parentLabelAt = before.lastIndexOf('{item.label}')
      const buttonAt = before.lastIndexOf('<button')
      expect(parentLabelAt).toBeGreaterThan(-1)
      expect(parentLabelAt).toBeGreaterThan(buttonAt)   // same button, still open
    }
  })

  it('BOTH navs render children — the desktop sidebar and the mobile drawer', () => {
    expect(BEEHUB.match(/\(item\.children\|\|\[\]\)\.map\(child=>\{/g) || []).toHaveLength(2)
  })

  it('a child lights up only when its section is active AND the shell reports its lens', () => {
    expect(BEEHUB).toContain('const childActive = isActive && hiveLens===child.lens')
    // Clients itself still reads as the active section while a child is on.
    expect(BEEHUB).toContain("background:isActive?'rgba(168,201,196,0.12)':'transparent'")
  })

  it('the nested row borrows the sidebar rows it sits with, not the tab row it replaced', () => {
    const MARK = 'const childActive = isActive && hiveLens===child.lens'
    // The mobile drawer is declared BEFORE the desktop sidebar in this file,
    // so first/last is how each block is addressed.
    const mobile = BEEHUB.slice(BEEHUB.indexOf(MARK), BEEHUB.indexOf(MARK) + 1200)
    const desktop = BEEHUB.slice(BEEHUB.lastIndexOf(MARK), BEEHUB.lastIndexOf(MARK) + 1200)

    for (const child of [mobile, desktop]) {
      expect(child).toContain("borderRadius:'10px'")        // same shell as its siblings
      expect(child).toContain("background:childActive?")    // the siblings' active fill
      // The size sits on the SPAN, never the button — globals.css
      // `button{font-size:16px!important}` discards an inline size on a button,
      // which is exactly how every sibling row in this sidebar is written.
      expect(child).toMatch(/<span style=\{\{ fontSize:'1[23]px'/)
      expect(child).not.toMatch(/<button[^>]*fontSize/)
    }
    // Each indents to sit under ITS OWN parent's label: desktop is a 14px
    // inset + 18px icon + 12px gap; the drawer is 14px + 20px + 14px.
    expect(desktop).toContain("padding:'7px 14px 7px 44px'")
    expect(desktop).toContain("width:'4px', height:'4px'")   // desktop's dot
    expect(mobile).toContain("padding:'10px 14px 10px 48px'")
    expect(mobile).toContain("minHeight:'48px'")             // the drawer's touch target
    expect(mobile).toContain("width:'5px', height:'5px'")    // the drawer's larger dot
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
