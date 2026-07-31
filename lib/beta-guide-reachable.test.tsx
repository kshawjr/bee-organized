// @vitest-environment happy-dom
//
// Quick Start Guide reachability (issue 132). Ankur's "Guide did not show up"
// report was real: f67caa9 trimmed the Guide/Manual links out of the Ask Bee
// Hub footer, orphaning openGuide() — HowToGuideModal could never render.
// MOUNT tests (HowToGuideModal is its own module now, same extraction move as
// FeedbackModal in #131):
//
//   1) the Guide entry point renders in the Ask Bee Hub panel footer
//   2) clicking it opens HowToGuideModal (panel + modal wired the same way
//      the App wires them; the App call-site itself is pinned below because
//      BeeHub.jsx cannot be mounted whole)
//   3) the modal renders slide content when slides exist
//   4) no slides → an honest empty state, never a blank/null modal
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import AskBeeHubPanel from '@/components/hive/AskBeeHubPanel'
import HowToGuideModal from '@/components/guide/HowToGuideModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const btn = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)

const SLIDES = [
  { chapter: 'Basics', icon: '🐝', title: 'Welcome to the Hive', color: '#1a2e2b', body: 'Your clients live here.', bullets: ['Add a client', 'Log a call'] },
  { chapter: 'Basics', icon: '📊', title: 'Reports', color: '#1a2e2b', body: 'Watch the honey flow.', bullets: [] },
]

describe('Guide entry point — Ask Bee Hub panel footer', () => {
  it('renders Quick Start Guide + Manual links when handlers are passed', async () => {
    const onOpenGuide = vi.fn()
    const onOpenManual = vi.fn()
    const { host, unmount } = await mount(
      <AskBeeHubPanel isMobile={false} screenName="Home" onClose={() => {}}
        onOpenGuide={onOpenGuide} onOpenManual={onOpenManual} onOpenFeedback={() => {}} />
    )
    const guideLink = btn(host, 'Quick Start Guide')
    const manualLink = btn(host, 'Manual')
    expect(guideLink, 'Quick Start Guide link missing from panel footer').toBeTruthy()
    expect(manualLink, 'Manual link missing from panel footer').toBeTruthy()
    // The escalation link stays alongside them — the footer carries all three.
    expect(btn(host, 'Report Bug or Feature')).toBeTruthy()
    await click(guideLink!)
    expect(onOpenGuide).toHaveBeenCalledTimes(1)
    await click(manualLink!)
    expect(onOpenManual).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('null handlers hide the links instead of rendering dead buttons', async () => {
    const { host, unmount } = await mount(
      <AskBeeHubPanel isMobile={false} screenName="Home" onClose={() => {}} />
    )
    expect(btn(host, 'Quick Start Guide')).toBeUndefined()
    expect(btn(host, 'Manual')).toBeUndefined()
    await unmount()
  })
})

describe('clicking the footer link opens HowToGuideModal', () => {
  // Panel + modal composed the same way the App composes them (close the
  // chat, open the Guide). Proves the click path end to end in a mount.
  function Harness() {
    const [showHelpChat, setShowHelpChat] = React.useState(true)
    const [showGuide, setShowGuide] = React.useState(false)
    return (
      <>
        {showHelpChat && (
          <AskBeeHubPanel isMobile={false} screenName="Home"
            onClose={() => setShowHelpChat(false)}
            onOpenGuide={() => { setShowHelpChat(false); setShowGuide(true) }} />
        )}
        {showGuide && (
          <HowToGuideModal onClose={() => setShowGuide(false)} onDismiss={() => setShowGuide(false)} slides={SLIDES} />
        )}
      </>
    )
  }

  it('click → chat closes, Guide modal mounts with slide 1', async () => {
    const { host, unmount } = await mount(<Harness />)
    expect(host.textContent).not.toContain('Welcome to the Hive')
    await click(btn(host, 'Quick Start Guide')!)
    expect(host.textContent).toContain('Welcome to the Hive')
    expect(host.textContent).toContain('Your clients live here.')
    // The chat panel yielded to the modal (App behavior: close chat first).
    expect(btn(host, 'Quick Start Guide')).toBeUndefined()
    await unmount()
  })

  it('the App passes the same wiring to the real panel (BeeHub.jsx is not mountable — pin the call site)', () => {
    const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    expect(beehub).toContain('onOpenGuide={() => { setShowHelpChat(false); openGuide() }}')
    expect(beehub).toContain('onOpenManual={() => { setShowHelpChat(false); setShowManual(true) }}')
    // openGuide() actually opens the modal — the orphaned-function regression.
    expect(beehub).toMatch(/function openGuide\(\) \{\s*dismissGuideHint\(\)\s*setShowGuide\(true\)/)
    expect(beehub).toContain('{showGuide && (')
  })
})

describe('HowToGuideModal content', () => {
  it('renders slides when slides exist, and Next walks them', async () => {
    const { host, unmount } = await mount(
      <HowToGuideModal onClose={() => {}} onDismiss={() => {}} slides={SLIDES} />
    )
    expect(host.textContent).toContain('Welcome to the Hive')
    expect(host.textContent).toContain('Add a client')
    await click(btn(host, 'Next →')!)
    expect(host.textContent).toContain('Watch the honey flow.')
    expect(btn(host, 'Done')).toBeTruthy()
    await unmount()
  })

  it('no slides → honest empty state, not a blank modal', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <HowToGuideModal onClose={onClose} onDismiss={() => {}} slides={[]} />
    )
    // Never null/blank: something visible mounts…
    expect((host.textContent || '').trim().length).toBeGreaterThan(0)
    // …and it says so honestly, with a working close.
    expect(host.textContent).toContain('Quick Start Guide')
    expect(host.textContent).toContain('doesn’t have any pages yet')
    const close = host.querySelector('button[aria-label="Close"]')
    expect(close).toBeTruthy()
    await click(close!)
    expect(onClose).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('empty state offers Add slides to editors only', async () => {
    const a = await mount(
      <HowToGuideModal onClose={() => {}} onDismiss={() => {}} slides={[]} canEdit={true} />
    )
    expect(btn(a.host, '✏️ Add slides')).toBeTruthy()
    await a.unmount()
    const b = await mount(
      <HowToGuideModal onClose={() => {}} onDismiss={() => {}} slides={[]} canEdit={false} />
    )
    expect(btn(b.host, '✏️ Add slides')).toBeUndefined()
    await b.unmount()
  })
})
