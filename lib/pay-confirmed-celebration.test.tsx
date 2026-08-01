// @vitest-environment happy-dom
//
// issue 168 — the pay-confirmed modal centres against the viewport (or, more
// precisely, escapes the sidebar-offset content column) and the celebration is
// safe: no motion under prefers-reduced-motion, and it never blocks Continue Setup.

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ViewportCenteredOverlay, PayConfirmedCelebration } from './pay-confirmed-celebration'

// matchMedia is absent in happy-dom; useReducedMotion guards it, but the reduced
// path needs it present and matching. Mirrors the BeeLoader test's mock.
function setReducedMotion(reduce: boolean) {
  ;(window as any).matchMedia = (q: string) => ({
    matches: reduce && /prefers-reduced-motion/.test(q),
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}

let cleanup: Array<() => void> = []
beforeEach(() => { setReducedMotion(false) })
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

// Mount into a host that is itself transformed. Note (issue 170): the real bug
// was NOT a transformed ancestor — there is none in the onboarding tree — it was
// the 220px-offset content column (.bee-main). We still mount inside a transform
// here because portalling to document.body must escape it either way: a fix that
// survives the strictest containing block (a transform) also survives the mere
// margin offset that is the actual production cause.
async function mountInTransformedHost(ui: React.ReactElement) {
  const host = document.createElement('div')
  host.style.transform = 'translateZ(0)' // strictest case: a fixed-positioning containing block
  host.setAttribute('data-host', '')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  cleanup.push(() => { try { root.unmount() } catch {} host.remove() })
  return host
}

function overlayEl() {
  return document.body.querySelector('[data-pay-modal-overlay]') as HTMLElement | null
}

describe('ViewportCenteredOverlay — centres against the viewport', () => {
  it('portals out of the transformed content column to document.body', async () => {
    const host = await mountInTransformedHost(
      <ViewportCenteredOverlay>
        <button>Continue Setup →</button>
      </ViewportCenteredOverlay>,
    )
    const overlay = overlayEl()
    expect(overlay).toBeTruthy()
    // Escaped the transformed host — so no ancestor transform can confine it.
    expect(host.contains(overlay)).toBe(false)
    expect(overlay!.parentElement).toBe(document.body)
  })

  it('is a viewport-anchored, centred layer', async () => {
    await mountInTransformedHost(
      <ViewportCenteredOverlay>
        <button>Continue Setup →</button>
      </ViewportCenteredOverlay>,
    )
    const overlay = overlayEl()!
    expect(overlay.style.position).toBe('fixed')
    expect(overlay.style.justifyContent).toBe('center')
    expect(overlay.style.alignItems).toBe('center')
    // inset:0 pins all four edges to the viewport.
    expect(overlay.style.inset === '0px' || overlay.style.inset === '0').toBe(true)
  })

  it('honors an opaque backdrop (the launching-screen full-bleed path)', async () => {
    await mountInTransformedHost(
      <ViewportCenteredOverlay backdrop="#1a2e2b" padding="2rem">
        <div>Setting up your Hub</div>
      </ViewportCenteredOverlay>,
    )
    const overlay = overlayEl()!
    expect(overlay.style.background).toBe('#1a2e2b')
    expect(overlay.style.position).toBe('fixed')
    expect(overlay.style.justifyContent).toBe('center')
  })

  // issue 170 — pricing, pay_confirm and stripe_wait ride the `scroll` variant:
  // the full-height pay page portals to body (escaping the offset column) and is
  // a top-anchored, scrollable viewport layer rather than a flex-centred card.
  it('scroll variant portals the full-height pay page out to document.body', async () => {
    const host = await mountInTransformedHost(
      <ViewportCenteredOverlay backdrop="#1a2e2b" padding={0} scroll>
        <div style={{ minHeight: '100vh' }}>Activate your subscription</div>
      </ViewportCenteredOverlay>,
    )
    const overlay = overlayEl()
    expect(overlay).toBeTruthy()
    expect(host.contains(overlay)).toBe(false)
    expect(overlay!.parentElement).toBe(document.body)
  })

  it('scroll variant is a viewport-anchored, top-aligned scrollable layer (no top clipping)', async () => {
    await mountInTransformedHost(
      <ViewportCenteredOverlay backdrop="#1a2e2b" padding={0} scroll>
        <div style={{ minHeight: '100vh' }}>Activate your subscription</div>
      </ViewportCenteredOverlay>,
    )
    const overlay = overlayEl()!
    expect(overlay.style.position).toBe('fixed')
    expect(overlay.style.inset === '0px' || overlay.style.inset === '0').toBe(true)
    // block + overflow-y:auto, NOT flex/align-items:center — a full-height page
    // must scroll from the top, not be vertically centred and clipped.
    expect(overlay.style.display).toBe('block')
    expect(overlay.style.overflowY).toBe('auto')
    expect(overlay.style.alignItems).toBe('')
  })

  it('keeps the Continue Setup button live inside the portalled overlay', async () => {
    let clicks = 0
    await mountInTransformedHost(
      <ViewportCenteredOverlay>
        <button onClick={() => { clicks++ }}>Continue Setup →</button>
      </ViewportCenteredOverlay>,
    )
    const overlay = overlayEl()!
    const btn = overlay.querySelector('button') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.disabled).toBe(false)
    await act(async () => { btn.click() })
    expect(clicks).toBe(1)
  })
})

describe('PayConfirmedCelebration — reduced motion', () => {
  it('renders NOTHING under prefers-reduced-motion', async () => {
    setReducedMotion(true)
    const host = await mountInTransformedHost(<PayConfirmedCelebration />)
    // No celebration container, no confetti pieces anywhere.
    expect(host.querySelector('[data-pay-celebration]')).toBeNull()
    expect(document.body.querySelector('.pay-confetti-piece')).toBeNull()
  })

  it('renders confetti when motion is allowed', async () => {
    setReducedMotion(false)
    const host = await mountInTransformedHost(<PayConfirmedCelebration />)
    const layer = host.querySelector('[data-pay-celebration]') as HTMLElement
    expect(layer).toBeTruthy()
    expect(host.querySelectorAll('.pay-confetti-piece').length).toBeGreaterThan(0)
  })
})

describe('PayConfirmedCelebration — never obstructs Continue Setup', () => {
  it('is pointer-events:none so clicks pass through to the button', async () => {
    const host = await mountInTransformedHost(<PayConfirmedCelebration />)
    const layer = host.querySelector('[data-pay-celebration]') as HTMLElement
    expect(layer.style.pointerEvents).toBe('none')
  })

  it('sits behind the card (zIndex 0) rather than over it', async () => {
    const host = await mountInTransformedHost(<PayConfirmedCelebration />)
    const layer = host.querySelector('[data-pay-celebration]') as HTMLElement
    expect(layer.style.zIndex).toBe('0')
  })
})
