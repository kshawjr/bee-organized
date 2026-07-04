// @vitest-environment happy-dom
// OverlayShell close affordance: the mobile sheet's header X must render
// in the drag-handle row and fire the SAME onClose the backdrop tap
// fires — one close path, two affordances. Needs a real DOM (events),
// hence the happy-dom override; the rest of the beta suite stays on the
// node/renderToString path.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import OverlayShell from '@/components/hive/OverlayShell'

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

describe('OverlayShell close affordance', () => {
  it('sheet X lives in the handle row, 44px hit target, aria-label Close', async () => {
    const { host, unmount } = await mount(<OverlayShell isMobile onClose={() => {}}><p>body</p></OverlayShell>)
    const btn = host.querySelector('button[aria-label="Close"]')
    expect(btn, 'X button missing from the sheet').toBeTruthy()
    expect(btn!.className).toBe('bee-sheet-close')

    // Same row as the handle: the button's parent is the 44px grab row
    // that also contains the centered handle bar — handle NOT replaced.
    const row = btn!.parentElement!
    expect(row.style.height).toBe('44px')
    expect(row.style.cursor).toBe('grab')
    const handle = row.querySelector('div')
    expect(handle, 'centered drag handle must remain').toBeTruthy()
    expect(handle!.style.width).toBe('36px')

    // 44x44 hit target via the class (glyph itself stays small).
    const css = [...host.querySelectorAll('style')].map(s => s.textContent).join('')
    expect(css).toMatch(/\.bee-sheet-close\s*{[^}]*width: 44px;[^}]*height: 44px;/)
    expect(css).toMatch(/\.bee-sheet-close\s*{[^}]*env\(safe-area-inset-right/)
    await unmount()
  })

  it('X fires the SAME onClose as the backdrop tap — exactly once per tap', async () => {
    const onClose = vi.fn()
    const { host, unmount } = await mount(<OverlayShell isMobile onClose={onClose}><p>body</p></OverlayShell>)

    await click(host.querySelector('button[aria-label="Close"]')!)
    expect(onClose).toHaveBeenCalledTimes(1)

    // Backdrop tap — the pre-existing close path, same handler.
    await click(host.firstElementChild!)
    expect(onClose).toHaveBeenCalledTimes(2)

    // Tapping sheet content must NOT close (stopPropagation intact).
    await click(host.querySelector('p')!)
    expect(onClose).toHaveBeenCalledTimes(2)
    await unmount()
  })
})
