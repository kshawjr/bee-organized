// @vitest-environment happy-dom
//
// Loading feedback for the two waits BeeLoader could not reach.
//
// THE DIAGNOSIS THESE TESTS ENCODE:
//
//  · LOCATION SWITCH — router.refresh() re-fetches the RSC payload and
//    reconciles it into the EXISTING tree. Nothing unmounts, no Suspense
//    boundary engages, no loading.tsx fires. There was therefore no loading
//    state anywhere in the tree for a loader to attach to, and the previous
//    location's content sat fully rendered and fully clickable for the whole
//    round trip. useTransition is the only thing that knows the refresh is
//    still in flight.
//
//  · INITIAL LOAD — HubPage is an async Server Component with no boundary above
//    it. On a hard load our JS has not been downloaded, let alone hydrated, so
//    no client component can render. Only a route-level loading file can serve
//    it, because Next streams that as HTML.
//
// The feedback must be IMMEDIATE. BeeLoader's 350ms gate answers "is this slow
// enough to warrant a loader"; a click answers "did that land", and any delay
// there is the whole problem.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import BeeLoader from '@/components/hive/shared/BeeLoader'

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })
beforeEach(() => {
  ;(window as any).matchMedia = (q: string) => ({
    matches: false, media: q,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
  })
})

async function mount(ui: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  cleanup.push(() => { try { root.unmount() } catch {} host.remove() })
  return host
}

describe('initial load — only a route-level boundary can serve it', () => {
  const src = readFileSync('app/loading.tsx', 'utf8')

  it('app/loading.tsx exists and covers every hub route by inheritance', () => {
    // One file at the app root; nested segments inherit it unless they define
    // their own, so /, /clients, /contacts, /hive, /reports, /settings, /admin
    // are all covered.
    expect(src).toContain('export default function Loading')
    expect(src).toContain('BeeLoader')
  })

  it('uses delay={0} — the default gate is an EFFECT and would stream empty', () => {
    // The fallback is HTML streamed before any JS runs. With the 350ms gate the
    // useEffect never fires pre-hydration, so the fallback would render nothing
    // for exactly the wait it exists to cover.
    expect(src).toContain('delay={0}')
  })

  it('renders real markup with NO client JS — server-rendered, not hydrated', () => {
    // The actual property that makes this work: renderToString is what Next
    // streams. If it comes back empty, the fallback is useless.
    const html = renderToString(<BeeLoader size="screen" delay={0} label="Warming up the hive…" />)
    expect(html).toContain('🐝')
    expect(html).toContain('🍯')
    expect(html).toContain('Warming up the hive…')
    expect(html).toContain('role="status"')
  })

  it('the DEFAULT delay still streams empty — proving the gate is the reason', () => {
    // Guards against someone "simplifying" delay={0} away in loading.tsx.
    const html = renderToString(<BeeLoader size="screen" label="x" />)
    expect(html).toBe('')
  })

  it('the orbit keyframes live in globals.css, not the effect-injected block', () => {
    // Same pre-hydration reason: an effect-injected keyframe does not exist
    // when the fallback is painted, and the bee would sit frozen.
    const css = readFileSync('app/globals.css', 'utf8')
    expect(css).toContain('@keyframes beeOrbit')
    expect(css).toContain('@keyframes beeOrbitCounter')
    const motion = readFileSync('components/hive/shared/motion.jsx', 'utf8')
    expect(motion).not.toContain('@keyframes beeOrbit')
  })
})

describe('location switch — immediate acknowledgment', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')

  it('the refresh runs inside a transition, so pending is knowable at all', () => {
    expect(src).toContain('const [isScopePending, startScopeTransition] = React.useTransition()')
    expect(src).toContain('startScopeTransition(() => { router.refresh() })')
  })

  it('feedback is rendered from that pending state', () => {
    expect(src).toContain('<ScopeSwitchProgress active={isScopePending} />')
  })

  it('the stale content is dimmed AND made unclickable while in flight', () => {
    // It is the PREVIOUS location's data: correct-looking, completely stale.
    // A click landing on one of those rows would open a record from a location
    // the user just navigated away from.
    expect(src).toContain('aria-busy={isScopePending || undefined}')
    expect(src).toContain("{ opacity: 0.45, pointerEvents: 'none', transition: 'opacity 140ms ease-out' }")
  })

  it('has NO delay gate — a delayed "did my click land" is the bug itself', () => {
    const fn = src.slice(src.indexOf('function ScopeSwitchProgress'), src.indexOf('function ScopeSwitchProgress') + 1600)
    expect(fn).toContain('if (!active) return null')
    expect(fn).not.toContain('useDelayedFlag')
    expect(fn).not.toContain('setTimeout')
  })

  it('is a hairline bar, not a panel — a fast switch must not flash something worse', () => {
    const fn = src.slice(src.indexOf('function ScopeSwitchProgress'), src.indexOf('function ScopeSwitchProgress') + 1600)
    expect(fn).toContain("height: '2px'")
    expect(fn).toContain("position: 'fixed'")
    expect(fn).toContain("pointerEvents: 'none'")
    // Not BeeLoader: a 2px bar appearing for 150ms is fine, a bee is not.
    expect(fn).not.toContain('BeeLoader')
  })

  it('announces politely for screen readers', () => {
    const fn = src.slice(src.indexOf('function ScopeSwitchProgress'), src.indexOf('function ScopeSwitchProgress') + 1600)
    expect(fn).toContain('role="status"')
    expect(fn).toContain('aria-live="polite"')
    expect(fn).toContain('Switching location…')
  })

  it('the chrome stays live — the switch can be changed mid-flight', () => {
    // pointer-events:none is scoped to the content wrapper INSIDE bee-main, so
    // the sidebar, picker and nav remain clickable.
    const block = src.slice(src.indexOf('{/* Main content - offset by sidebar'), src.indexOf('{showGlobalSearch&&('))
    expect(block).toContain('{screen()}')
    expect(block).toContain('pointerEvents')
  })
})

describe('reduced motion', () => {
  const css = readFileSync('app/globals.css', 'utf8')

  it('every looping loader animation is stopped by the media query', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    for (const cls of ['.bee-loader-orbit', '.bee-loader-counter', '.bee-loader-pot', '.bee-scope-bar']) {
      expect(block).toContain(cls)
    }
    expect(block).toContain('animation: none !important')
  })

  it('the elements still RENDER — stopping motion must not remove the feedback', () => {
    // The media query kills the animation, never `display`. Hiding them would
    // leave reduced-motion users with no loading feedback at all.
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).not.toContain('display: none')
    expect(block).not.toContain('visibility: hidden')
  })

  it('the bar carries the class the media query targets', () => {
    const src = readFileSync('components/BeeHub.jsx', 'utf8')
    expect(src).toContain('className="bee-scope-bar"')
  })

  it('the loader carries its classes too (pre-hydration guard)', () => {
    // useReducedMotion is an effect, so before hydration only the CSS query
    // protects these users. Both layers are needed.
    const src = readFileSync('components/hive/shared/BeeLoader.jsx', 'utf8')
    expect(src).toContain('className="bee-loader-orbit"')
    expect(src).toContain('className="bee-loader-counter"')
    expect(src).toContain('className="bee-loader-pot"')
  })
})

describe('BeeLoader\'s 350ms gate is untouched for section loads', () => {
  it('the default still waits — this change must not lower it globally', async () => {
    vi.useFakeTimers()
    const host = await mount(<BeeLoader label="Gathering…" />)
    expect(host.textContent).toBe('')
    await act(async () => { vi.advanceTimersByTime(370) })
    expect(host.textContent).toContain('Gathering…')
    vi.useRealTimers()
  })
})
