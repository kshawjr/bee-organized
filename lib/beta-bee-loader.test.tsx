// @vitest-environment happy-dom
//
// BeeLoader — the branded loading state (bee orbits the honey pot).
//
// The animation is the least important thing pinned here. Two behaviours
// matter more, and both are the kind that quietly rot:
//
//  1. THE DELAY. After the Fix 2 work most screens resolve in well under a
//     second, so a loader that renders immediately would flash and vanish on
//     nearly every load — which reads as a glitch, not as progress. Nothing
//     renders before SHOW_AFTER_MS. If someone ever "simplifies" the delay
//     away, every fast surface starts strobing and no existing test would
//     have noticed.
//
//  2. REDUCED MOTION renders the STILL bee and pot, not nothing. Hiding it
//     would leave those users with no loading feedback at all — a worse
//     outcome than an un-animated one, and an easy mistake to make while
//     "respecting" the preference.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import BeeLoader, { SHOW_AFTER_MS, useDelayedFlag } from '@/components/hive/shared/BeeLoader'

// matchMedia is absent in happy-dom; useReducedMotion guards it, but these
// tests need to DRIVE it.
function setReducedMotion(reduce: boolean) {
  ;(window as any).matchMedia = (q: string) => ({
    matches: reduce && /prefers-reduced-motion/.test(q),
    media: q,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
  })
}

let cleanup: Array<() => void> = []
beforeEach(() => { vi.useFakeTimers(); setReducedMotion(false) })
afterEach(() => {
  cleanup.forEach(fn => fn()); cleanup = []
  vi.useRealTimers()
})

async function mount(ui: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  cleanup.push(() => { try { root.unmount() } catch {} host.remove() })
  return host
}

// Advance past the delay gate.
const settle = async (ms = SHOW_AFTER_MS + 20) => {
  await act(async () => { vi.advanceTimersByTime(ms) })
}

describe('BeeLoader — the delay gate', () => {
  it('renders NOTHING before the threshold', async () => {
    const host = await mount(<BeeLoader label="Gathering your clients…" />)
    // The whole point: a load that finishes fast must never have flashed.
    expect(host.textContent).toBe('')
    expect(host.querySelector('[role="status"]')).toBeNull()
    await settle(SHOW_AFTER_MS - 50)
    expect(host.textContent).toBe('')
  })

  it('renders once the load outlasts the threshold', async () => {
    const host = await mount(<BeeLoader label="Gathering your clients…" />)
    await settle()
    expect(host.textContent).toContain('Gathering your clients…')
    expect(host.querySelector('[role="status"]')).toBeTruthy()
  })

  it('reserves NO space before it shows — a placeholder box would jump the layout', async () => {
    const host = await mount(<BeeLoader />)
    expect(host.children.length).toBe(0)
  })

  it('the threshold sits in the 300–400ms band', () => {
    expect(SHOW_AFTER_MS).toBeGreaterThanOrEqual(300)
    expect(SHOW_AFTER_MS).toBeLessThanOrEqual(400)
  })

  it('useDelayedFlag resets between loads rather than inheriting the last clock', async () => {
    function Probe({ active }: { active: boolean }) {
      const shown = useDelayedFlag(active)
      return <span>{shown ? 'on' : 'off'}</span>
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<Probe active />) })
    await settle()
    expect(host.textContent).toBe('on')
    // load finishes…
    await act(async () => { root.render(<Probe active={false} />) })
    expect(host.textContent).toBe('off')
    // …a second load must wait its own full delay, not appear instantly.
    await act(async () => { root.render(<Probe active />) })
    expect(host.textContent).toBe('off')
    await settle()
    expect(host.textContent).toBe('on')
    cleanup.push(() => { try { root.unmount() } catch {} host.remove() })
  })
})

describe('BeeLoader — rendering', () => {
  it('renders the bee and the pot', async () => {
    const host = await mount(<BeeLoader />)
    await settle()
    expect(host.textContent).toContain('🐝')
    expect(host.textContent).toContain('🍯')
  })

  it('renders a calm default caption when given no label', async () => {
    const host = await mount(<BeeLoader />)
    await settle()
    const p = host.querySelector('p')
    expect(p).toBeTruthy()
    expect((p!.textContent || '').trim().length).toBeGreaterThan(0)
  })

  it('renders the caller’s label when given one', async () => {
    const host = await mount(<BeeLoader label="Gathering closed engagements…" />)
    await settle()
    expect(host.textContent).toContain('Gathering closed engagements…')
  })

  it('announces politely without stealing focus', async () => {
    const host = await mount(<BeeLoader label="Working…" />)
    await settle()
    const status = host.querySelector('[role="status"]')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    // The glyphs are decorative; the caption carries the message.
    expect(host.querySelector('[aria-hidden="true"]')).toBeTruthy()
  })

  it('the screen variant is larger than the inline one', async () => {
    const inline = await mount(<BeeLoader size="inline" />)
    await settle()
    const screen = await mount(<BeeLoader size="screen" />)
    await settle()
    const potOf = (h: HTMLElement) =>
      parseFloat((Array.from(h.querySelectorAll('span')).find(s => (s.textContent || '').includes('🍯')) as HTMLElement)?.style.fontSize || '0')
    expect(potOf(screen)).toBeGreaterThan(potOf(inline))
  })
})

describe('BeeLoader — prefers-reduced-motion', () => {
  it('renders the bee and pot STILL — not nothing', async () => {
    setReducedMotion(true)
    const host = await mount(<BeeLoader label="Gathering your clients…" />)
    await settle()
    // Present and legible…
    expect(host.textContent).toContain('🐝')
    expect(host.textContent).toContain('🍯')
    expect(host.textContent).toContain('Gathering your clients…')
    // …and completely un-animated. A looping orbit is exactly the motion that
    // triggers vestibular symptoms, so not one element may carry an animation.
    const animated = Array.from(host.querySelectorAll('*'))
      .filter(el => ((el as HTMLElement).style?.animation || '').trim() !== '')
    expect(animated).toHaveLength(0)
  })

  it('DOES animate when motion is allowed (the guard is real, not always-off)', async () => {
    setReducedMotion(false)
    const host = await mount(<BeeLoader />)
    await settle()
    const anims = Array.from(host.querySelectorAll('*'))
      .map(el => (el as HTMLElement).style?.animation || '')
      .filter(a => a.trim() !== '')
    expect(anims.some(a => a.includes('beeOrbit'))).toBe(true)
    expect(anims.some(a => a.includes('beeOrbitCounter'))).toBe(true)
  })
})

describe('BeeLoader — source contracts', () => {
  const src = readFileSync('components/hive/shared/BeeLoader.jsx', 'utf8')

  it('carries no hex/rgba literals — tokens only (hive sweep)', () => {
    const body = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(body).not.toMatch(/rgba?\(/)
  })

  it('animates with CSS only — no JS loop, no rAF', () => {
    expect(src).not.toContain('requestAnimationFrame')
    expect(src).not.toContain('setInterval')
  })

  it('reuses the ONE shared reduced-motion gate rather than a second copy', () => {
    expect(src).toContain("from './motion'")
    expect(src).toContain('useReducedMotion')
  })

  it('the orbit and counter-orbit share a duration — or the bee tumbles', () => {
    // They are paired: the ring rotates one way, the bee the other at the same
    // rate so it stays upright. A mismatch is a subtle, permanent wobble.
    expect(src).toContain('`beeOrbit ${SPIN_MS}ms linear infinite`')
    expect(src).toContain('`beeOrbitCounter ${SPIN_MS}ms linear infinite`')
  })
})

describe('the import screens keep their OWN bee animation', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')

  it('bee-fly / import keyframes are untouched', () => {
    // Explicitly out of scope: the import screens already have a bespoke bee
    // animation Kevin approved separately. BeeLoader must not have eaten it.
    for (const k of ['bee-fly-1', 'bee-fly-2', 'bee-fly-3', 'bee-fly-4', 'bee-fly-u']) {
      expect(src).toContain(`@keyframes ${k}`)
    }
    expect(src).toContain('beeImportIndeterminate')
    expect(src).toContain('jobberConnectBuzz')
  })

  it('no BeeLoader was dropped into an import screen', () => {
    const importBlock = src.slice(src.indexOf('bee-fly-1'), src.indexOf('bee-fly-1') + 4000)
    expect(importBlock).not.toContain('<BeeLoader')
  })
})
