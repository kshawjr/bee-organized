// @vitest-environment happy-dom
//
// Issue 246 step 1 — the six horizontal tabs became a grouped left sidebar.
// SHELL ONLY: sections moved address, nothing inside them changed.
//
// Three things this file exists to catch, in descending order of how much
// they would hurt:
//
//   1. A MODAL WITH A DEAD MOUNT. Issue 240 step 4 removed
//      TemplatePreviewModal's mount while leaving its Preview buttons wired.
//      It was silently dead for seven commits and nothing caught it: the
//      state still resolved, so there was no lint error and no type error —
//      clicking Preview just set a variable no one read. This step moves JSX
//      the same way, by line range, so the same hole is open. The audit below
//      is mechanical (it discovers the modals from the source rather than
//      trusting a hand-written list) and runs in both directions: every mount
//      needs a trigger, and every modal on the pinned list needs a mount.
//
//   2. A MOBILE USER TRAPPED IN SETTINGS. The old mobile nav was a native
//      <select> and it WORKED. A drill-down whose "back" is a state flip
//      would be a regression dressed as an upgrade: the hardware back gesture
//      would leave Settings entirely from a section the user drilled into.
//      Back here is history.back() over a real pushState, pinned below.
//
//   3. A GROUP HEADER OVER NOTHING. Sections are conditionally mounted, so a
//      manager sees Profile only — but "Connections" standing over empty
//      space would tell them about surfaces they cannot reach, which is the
//      thing conditional mounting exists to avoid saying. Pinned in
//      lib/beta-settings-access.test.tsx alongside the rest of the role gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen, CurrentUserContext, MailchimpCard } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const currentUser = {
  id: '9a8b7c6d-1111-4222-8333-444455556666',
  email: 'user@bee.test',
  name: 'Riley Park',
  role: 'franchise',
  locationId: 'loc-uuid-1',
  first_name: 'Riley',
  last_name: 'Park',
  phone: '(206) 555-0100',
  booking_link: null,
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
  window.history.replaceState({}, '', '/settings')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const mount = async (initialSection: string | null = 'profile') => {
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={currentUser}>
        <SettingsScreen {...(initialSection ? { initialSection } : {})} franchiseRole="owner" />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => {})   // flush mount-time fetches
}

const rail  = () => container.querySelector('[data-settings-nav="rail"]')!
const drill = () => container.querySelector('[data-settings-nav="drill"]')!
// The section body wrapper is the drill nav's next sibling.
const pane  = () => drill().nextElementSibling as HTMLElement
const rowIn = (nav: Element, key: string) =>
  nav.querySelector(`[data-section="${key}"]`) as HTMLButtonElement

// ═══════════════════════════════════════════════════════════════════════════
// 1 · MODAL MOUNT / TRIGGER AUDIT
// ═══════════════════════════════════════════════════════════════════════════
describe('every modal SettingsScreen mounts has a live mount AND a live trigger', () => {
  const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  // SettingsScreen's own body — from its declaration to the next top-level
  // function. Modal state is SettingsScreen state, so both the mount and every
  // trigger must be inside this slice.
  const body = (() => {
    const start = src.indexOf('export function SettingsScreen(')
    expect(start, 'SettingsScreen declaration').toBeGreaterThan(-1)
    const after = src.slice(start + 10)
    return src.slice(start, start + 10 + after.search(/\n(export )?function [A-Z]/))
  })()

  // Discovered, not hand-listed: `{someState && (<SomeModal` / `{s&&<SomeSheet`.
  const discovered = [...body.matchAll(/\{(\w+)\s*&&[^}]{0,120}?<([A-Z]\w*(?:Modal|Sheet|Popup|Editor))\b/gs)]
    .map(m => ({ guard: m[1], component: m[2] }))

  // The pinned list. Auto-discovery alone cannot catch a DELETED mount — the
  // pattern simply stops matching and the loop gets shorter — which is exactly
  // how TemplatePreviewModal went missing. This list is the tripwire for that.
  const EXPECTED = [
    'TwoQuestionsModal',
    'TimingEditModal',
    'AddEmailModal',
    'EmailTemplateEditor',
    'TemplatePreviewModal',
    'TemplateEditorPopup',
    'ForkConfirmModal',
    'DripPathStepEditor',
    'AddSeatsModal',
    'BillingHistorySheet',
    'ScheduleRemovalModal',
    'CancelScheduledRemovalModal',
  ]

  it('the full set of modals is still mounted — none lost in the move', () => {
    expect(discovered.map(d => d.component).sort()).toEqual([...EXPECTED].sort())
  })

  it.each(EXPECTED)('%s has a mount that is actually rendered', name => {
    const hit = discovered.find(d => d.component === name)
    expect(hit, `${name} has no guarded mount in SettingsScreen`).toBeTruthy()
    // The mount must sit in the returned JSX, not in dead code below a return.
    expect(body.indexOf(`<${name}`)).toBeGreaterThan(body.indexOf('return ('))
  })

  it.each(EXPECTED)('%s has at least one trigger that sets its state TRUTHY', name => {
    const guard = discovered.find(d => d.component === name)!.guard
    const setter = 'set' + guard[0].toUpperCase() + guard.slice(1)
    const args = [...body.matchAll(new RegExp(`${setter}\\(([^)\\n]*)`, 'g'))].map(m => m[1].trim())
    expect(args.length, `${setter} is never called`).toBeGreaterThan(0)
    // A close-only setter (null / false) is not a trigger. Without this the
    // audit would pass on a modal that can only ever be dismissed.
    const opens = args.filter(a => a !== '' && a !== 'null' && a !== 'false' && a !== 'undefined')
    expect(opens.length, `${setter} is only ever called to CLOSE ${name}`).toBeGreaterThan(0)
  })

  it('every trigger is reachable from rendered JSX, not an orphaned handler', () => {
    // The 240 step 4 failure in its other direction: a handler that nothing
    // calls. Each opening setter must sit either in an onClick/actions prop or
    // in a named function that rendered JSX references by name.
    for (const { guard, component } of discovered) {
      const setter = 'set' + guard[0].toUpperCase() + guard.slice(1)
      let reachable = false
      for (const m of body.matchAll(new RegExp(`${setter}\\(`, 'g'))) {
        const before = body.slice(Math.max(0, m.index! - 600), m.index!)
        const arg = body.slice(m.index! + setter.length + 1, m.index! + setter.length + 40).trim()
        if (arg.startsWith('null') || arg.startsWith('false')) continue
        // inline handler …
        if (/onClick=\{[^}]*$/.test(before) || /on[A-Z]\w*=\{[^}]*$/.test(before)) { reachable = true; break }
        // … or inside `function name(` / `const name = ` that JSX names.
        const decl = [...before.matchAll(/(?:^|\n)\s*(?:async\s+)?function (\w+)|(?:^|\n)\s*const (\w+)\s*=/g)].pop()
        const fn = decl?.[1] || decl?.[2]
        if (fn && new RegExp(`[:=]\\s*\\{?\\s*${fn}\\b|\\b${fn}\\s*\\}`).test(body)) { reachable = true; break }
      }
      expect(reachable, `${component}'s trigger (${setter}) is not reachable from rendered JSX`).toBe(true)
    }
  })

  it("LIVE: the Preview button opens TemplatePreviewModal — the exact control that died in 240 step 4", async () => {
    // A source pin would have passed all seven commits that bug survived, so
    // this one clicks. Preview lives on Texts and scripts (call scripts).
    ;(globalThis.fetch as any) = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => url.includes('/api/templates')
        // The body is long on purpose: the LIST ROW shows a truncated
        // preview of it, so a short body would make this test pass on the row
        // alone and prove nothing about the modal. Only the modal renders the
        // tail sentence.
        ? { templates: [{ id: 't1', legacy_id: 'call-1', name: 'First call', type: 'call', subject: 'Hi', body: 'Say hello. ' + 'Then work through the checklist together. '.repeat(8) + 'ENDOFSCRIPTMARKER', is_active: true, is_master: false, is_own_custom: true }] }
        : {},
    }))
    await mount('texts')

    // Call Scripts renders collapsed — walk up from its sub-label and click
    // until the row appears (same approach as lib/master-template-grouping).
    const sub = Array.from(container.querySelectorAll('*')).find(
      el => el.textContent?.trim().startsWith('Talking points for you'),
    )
    expect(sub, 'the Call Scripts section header').toBeTruthy()
    for (let el = sub as HTMLElement | null; el && el !== container; el = el.parentElement) {
      await act(async () => { el!.click() })
      if ((container.textContent || '').includes('First call')) break
    }

    const preview = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.trim() === 'Preview') as HTMLButtonElement
    expect(preview, 'a Preview button on Texts and scripts').toBeTruthy()
    expect(container.textContent, 'the row shows a truncated preview only').not.toContain('ENDOFSCRIPTMARKER')

    await act(async () => { preview.click() })
    // The modal renders the WHOLE body — proof of a live mount, not just a
    // state variable that resolved.
    expect(container.textContent, 'TemplatePreviewModal did not open').toContain('ENDOFSCRIPTMARKER')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · MOBILE DRILL-DOWN
// ═══════════════════════════════════════════════════════════════════════════
//
// happy-dom loads no stylesheet, so both navs are in the DOM at once and the
// media queries are not in play. What the component controls — and therefore
// what is testable here — is the CLASS it puts on each half. globals.css maps
// .bee-settings-hide-mobile to display:none below 768px and to nothing at all
// above it, which is why the desktop layout cannot be broken by drill state.
const hidden = (el: Element) => el.classList.contains('bee-settings-hide-mobile')

describe('mobile drill-down: list → section → back → list', () => {
  it('opens on the LIST, with the section pane hidden', async () => {
    await mount(null)
    expect(hidden(drill()), 'the list is showing').toBe(false)
    expect(hidden(pane()), 'the section pane is hidden behind the list').toBe(true)
  })

  it('tapping a row shows that section and hides the list', async () => {
    await mount(null)
    await act(async () => { rowIn(drill(), 'emails').click() })
    expect(hidden(drill()), 'the list stepped aside').toBe(true)
    expect(hidden(pane()), 'the section is showing').toBe(false)
    expect(container.textContent).toContain('Every email a client can receive')
  })

  it('tapping a row is REAL NAVIGATION — a pushState, not a state flip', async () => {
    // The whole requirement. A drill-down whose back is a state flip means the
    // hardware back gesture leaves Settings from a section the user drilled
    // into, which is worse than the <select> this replaced.
    await mount(null)
    const push = vi.spyOn(window.history, 'pushState')
    await act(async () => { rowIn(drill(), 'texts').click() })
    expect(push, 'drilling in pushed a history entry').toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][2]).toContain('section=texts')
    expect(window.location.search).toContain('section=texts')
  })

  it('the back control calls history.back() — the same action as the back gesture', async () => {
    await mount(null)
    await act(async () => { rowIn(drill(), 'emails').click() })
    const back = vi.spyOn(window.history, 'back')
    const btn = container.querySelector('.bee-settings-back') as HTMLButtonElement
    expect(btn, 'the back control').toBeTruthy()
    await act(async () => { btn.click() })
    expect(back, 'back is navigation, not setState').toHaveBeenCalledTimes(1)
  })

  it('the browser/hardware back gesture returns to the LIST, not out of Settings', async () => {
    await mount(null)
    await act(async () => { rowIn(drill(), 'emails').click() })
    expect(hidden(drill())).toBe(true)

    // What the browser does on a back gesture: restore the previous URL, then
    // fire popstate. The pathname never changed, so we are still on Settings.
    await act(async () => {
      window.history.replaceState({}, '', '/settings')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(window.location.pathname, 'still inside Settings').toBe('/settings')
    expect(hidden(drill()), 'back landed on the list').toBe(false)
    expect(hidden(pane())).toBe(true)
  })

  it('forward again re-opens the section the URL names', async () => {
    await mount(null)
    await act(async () => {
      window.history.replaceState({}, '', '/settings?section=texts')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(hidden(drill())).toBe(true)
    expect(container.textContent).toContain('Texts are on their way')
  })

  it('a retired key arriving by popstate resolves rather than blanking the pane', async () => {
    await mount(null)
    await act(async () => {
      window.history.replaceState({}, '', '/settings?section=yourteam')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(container.textContent).toContain('Who handles each kind of job')
    expect(container.textContent).not.toContain("You don't have access to this section")
  })

  it('the desktop rail does NOT push — back still leaves Settings, exactly as today', async () => {
    await mount(null)
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    await act(async () => { rowIn(rail(), 'emails').click() })
    expect(push, 'the rail must not stack history entries').not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalled()
  })

  it('rows clear the 16px floor and are no smaller than the <select> they replaced', async () => {
    // The old mobile nav was a native <select> at padding:12px with the global
    // 16px form-control floor — roughly a 44px target. These rows must not be
    // a downgrade in either dimension.
    await mount(null)
    const rows = Array.from(drill().querySelectorAll('[data-section]')) as HTMLElement[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(parseInt(row.style.minHeight, 10), `${row.dataset.section} tap target`).toBeGreaterThanOrEqual(44)
      const label = row.querySelector('span:not([aria-hidden])') as HTMLElement
      expect(parseInt(label.style.fontSize, 10), `${row.dataset.section} label size`).toBeGreaterThanOrEqual(16)
    }
  })

  it('the list is grouped with the same headers as the rail', async () => {
    await mount(null)
    const titles = (nav: Element) => Array.from(nav.children).map(g => g.querySelector('p')?.textContent?.trim())
    expect(titles(drill())).toEqual(titles(rail()))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · CONNECTIONS › MAILCHIMP
// ═══════════════════════════════════════════════════════════════════════════
// Step 1 shipped a placeholder and this block pinned it SHUT: no button, no
// route, no env var, no mailchimp.com. Step 2 built the connect flow, so those
// pins are now the wrong assertions — they described a deliberate absence that
// is deliberately over. What survives is the part that was never about the
// placeholder: the row is reachable from both navs, and the section it opens
// mounts the real card.
//
// The card's own behaviour — its three states, its copy, its zero-audience
// message, and the fact that it never surfaces mailchimp_sync_live — is pinned
// in lib/beta-mailchimp-connect-246-step2.test.tsx, next to the guard and the
// pure state module it shares them with.
describe('Connections › Mailchimp is a live row', () => {
  it('the row is present in both navs, and no longer muted against its neighbours', async () => {
    await mount(null)
    for (const nav of [rail(), drill()]) {
      const row = rowIn(nav, 'mailchimp')
      expect(row, 'a Mailchimp row').toBeTruthy()
      const label = row.querySelector('span:not([aria-hidden])') as HTMLElement
      // It now reads like Slack and Jobber — the live rows beside it. This is
      // the exact inverse of the step 1 assertion, which required it to DIFFER.
      const live = rowIn(nav, 'slack').querySelector('span:not([aria-hidden])') as HTMLElement
      expect(label.style.color).toBe(live.style.color)
    }
  })

  it('selecting it opens the real card, not the placeholder', async () => {
    await mount('mailchimp')
    expect(container.textContent).toContain('Connect Mailchimp')
    // The placeholder's copy is gone, in full.
    expect(container.textContent).not.toContain('Not connected yet.')
    expect(container.textContent).not.toContain("When it's ready")
  })

  it('there IS a button now, and it starts the connect flow', async () => {
    await mount('mailchimp')
    const btn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.trim() === 'Connect Mailchimp')
    expect(btn, 'a Connect Mailchimp button').toBeTruthy()
    expect(btn!.hasAttribute('disabled')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · ONE NAME FOR ONE SECTION
// ═══════════════════════════════════════════════════════════════════════════
describe('the Location section answers to one name', () => {
  it("is 'Location' in both navs — never 'My Location'", async () => {
    // It was 'Location' on the desktop pill and 'My Location' in the mobile
    // select: the same surface with two names depending on screen width.
    await mount(null)
    for (const nav of [rail(), drill()]) {
      const label = rowIn(nav, 'location').textContent ?? ''
      expect(label).toContain('Location')
      expect(label).not.toContain('My Location')
    }
  })
})
