// @vitest-environment happy-dom
// IdentityScopeControl — the merged sidebar-bottom identity/scope control
// that replaced the top super-admin strip + footer location switcher +
// footer avatar/sign-out block. Covers:
//   - super admin popover: identity + viewing-as + location + sign out
//   - owner degradation: NO viewing-as section (omitted, not disabled);
//     location is a STATIC row (no switch button); sign out present
//   - active impersonation: the CLOSED trigger shows "Viewing as <Name>"
//     + the active-ring state (asserted as state, not pixels)
//   - the old top strip is gone from BeeHub (source-level assertions)
//   - sign out is fenced below its own divider, never flush against a
//     scope row
//   - the new rows invoke the SAME handlers the old controls called
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'fs'
import { join } from 'path'
import IdentityScopeControl from '@/components/hive/IdentityScopeControl'

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
const openPopover = async (host: Element) => {
  await click(host.querySelector('button[aria-label="Account and scope"]')!)
}
const rowByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').includes(text))

const SUPER = {
  name: 'Kevin Shaw', email: 'kevin@bmave.com', initials: 'KS',
  roleLabel: 'Super Admin', roleBadgeTint: 'warning' as const,
  isSuperAdmin: true,
  locationLabel: 'All locations', locationCount: 3, canSwitchLocation: true,
}
const OWNER = {
  name: 'Dana Owner', email: 'dana@x.com', initials: 'DO',
  roleLabel: 'Zee Bee', roleBadgeTint: 'accent' as const,
  isSuperAdmin: false,
  locationLabel: 'Kansas City, MO', locationCount: 1, canSwitchLocation: false,
}

describe('IdentityScopeControl popover by role', () => {
  it('super admin: identity + viewing-as + location + sign out, in that order', async () => {
    const { host, unmount } = await mount(<IdentityScopeControl {...SUPER} />)
    await openPopover(host)

    const sections = [...host.querySelectorAll('[data-section]')].map(s => s.getAttribute('data-section'))
    expect(sections).toEqual(['identity', 'viewing-as', 'location', 'signout'])

    // Identity header: name, email, role badge
    const identity = host.querySelector('[data-section="identity"]')!
    expect(identity.textContent).toContain('Kevin Shaw')
    expect(identity.textContent).toContain('kevin@bmave.com')
    expect(identity.textContent).toContain('Super Admin')

    // Viewing-as default row
    const va = host.querySelector('[data-section="viewing-as"]')!
    expect(va.textContent).toContain('Viewing as')
    expect(va.textContent).toContain('Yourself')
    expect(va.textContent).toContain('Not impersonating anyone')

    // Location switcher row with count subline
    const loc = host.querySelector('[data-section="location"]')!
    expect(loc.textContent).toContain('All locations')
    expect(loc.textContent).toContain('3 franchise locations')
    expect(loc.querySelector('button'), 'location must be a switch button for multi-location viewers').toBeTruthy()

    expect(host.querySelector('[data-section="signout"] a')!.textContent).toContain('Sign out')
    await unmount()
  })

  it('owner: NO viewing-as section (omitted, not disabled); location static; sign out present', async () => {
    const { host, unmount } = await mount(<IdentityScopeControl {...OWNER} />)
    await openPopover(host)

    const sections = [...host.querySelectorAll('[data-section]')].map(s => s.getAttribute('data-section'))
    expect(sections).toEqual(['identity', 'location', 'signout'])
    expect(host.textContent).not.toContain('Viewing as')
    expect(host.textContent).not.toContain('impersonating')

    // Static read-only location row: a div, not a button, no chevron
    const loc = host.querySelector('[data-section="location"]')!
    expect(loc.textContent).toContain('Kansas City, MO')
    expect(loc.textContent).toContain('Your location')
    expect(loc.querySelector('button'), 'single-location viewer must NOT get a switch button').toBeNull()

    const signout = host.querySelector('[data-section="signout"] a')!
    expect(signout.textContent).toContain('Sign out')
    expect(signout.getAttribute('href')).toBe('/api/auth/signout')
    await unmount()
  })
})

describe('active impersonation — the strip-replacement signal', () => {
  const viewingAs = { name: 'Dana Owner', roleLabel: 'Zee Bee' }

  it('CLOSED trigger reads "Viewing as <Name>" and carries the active-ring state', () => {
    const html = renderToString(<IdentityScopeControl {...SUPER} viewingAs={viewingAs} />)
    const trigger = html.match(/<button[^>]*aria-label="Account and scope"[^>]*>/)
    expect(trigger, 'trigger missing').toBeTruthy()
    expect(trigger![0]).toContain('data-impersonating="true"')
    expect(html).toContain('Viewing as Dana Owner')
    // Ring treatment present on the trigger itself (state, not pixels —
    // but the ring must exist without opening anything).
    expect(trigger![0]).toContain('box-shadow')

    // Inactive: no ring state, plain name
    const idle = renderToString(<IdentityScopeControl {...SUPER} />)
    expect(idle).not.toContain('data-impersonating')
    expect(idle).not.toContain('Viewing as ')
    expect(idle).toContain('Kevin Shaw')
  })

  it('open popover shows the target + a return-to-yourself exit riding the old Exit handler', async () => {
    const onExitViewAs = vi.fn()
    const { host, unmount } = await mount(
      <IdentityScopeControl {...SUPER} viewingAs={viewingAs} onExitViewAs={onExitViewAs} />
    )
    await openPopover(host)
    const va = host.querySelector('[data-section="viewing-as"]')!
    expect(va.textContent).toContain('Dana Owner')
    expect(va.textContent).toContain('Zee Bee')
    await click(rowByText(host, 'Return to yourself')!)
    expect(onExitViewAs).toHaveBeenCalledTimes(1)
    await unmount()
  })
})

describe('sign-out fence', () => {
  it('sign out sits below its OWN divider, never flush against a scope row', async () => {
    for (const props of [SUPER, OWNER]) {
      const { host, unmount } = await mount(<IdentityScopeControl {...props} />)
      await openPopover(host)
      const signout = host.querySelector('[data-section="signout"]')!
      // The section's first element is the divider — the fence.
      expect(signout.firstElementChild!.getAttribute('data-divider')).toBe('true')
      // And the section is last, after the location scope section.
      const sections = [...host.querySelectorAll('[data-section]')]
      expect(sections[sections.length - 1]).toBe(signout)
      expect(sections[sections.length - 2].getAttribute('data-section')).toBe('location')
      await unmount()
    }
  })
})

describe('handler wiring', () => {
  it('location row invokes the location-picker handler; viewing-as row invokes the view-as handler', async () => {
    const onOpenLocationPicker = vi.fn()
    const onOpenViewAs = vi.fn()
    const { host, unmount } = await mount(
      <IdentityScopeControl {...SUPER} onOpenLocationPicker={onOpenLocationPicker} onOpenViewAs={onOpenViewAs} />
    )
    await openPopover(host)
    await click(host.querySelector('[data-section="location"] button')!)
    expect(onOpenLocationPicker).toHaveBeenCalledTimes(1)

    await openPopover(host)
    await click(host.querySelector('[data-section="viewing-as"] button')!)
    expect(onOpenViewAs).toHaveBeenCalledTimes(1)
    await unmount()
  })
})

describe('the old chrome is gone (BeeHub source)', () => {
  const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('top super-admin strip removed: no DemoBar, no DEMO_BAR_H, no strip View-as button', () => {
    expect(src).not.toContain('DemoBar')
    expect(src).not.toContain('DEMO_BAR_H')
    expect(src).not.toContain('👁 View as\n') // the strip's button label (mobile menu's "View as user…" stays)
  })

  it('the merged control is mounted and wired to the SAME handlers the old controls called', () => {
    expect(src).toContain('<IdentityScopeControl')
    // Old All Locations switcher path → same setShowLocPicker
    expect(src).toMatch(/onOpenLocationPicker=\{\(\)=>setShowLocPicker\(true\)\}/)
    // Old strip View-as path → same setRole('franchise') + setViewAsTarget
    expect(src).toMatch(/onOpenViewAs=\{\(\)=>\{ if \(!viewAsUser\) setRole\('franchise'\); setViewAsTarget\(true\) \}\}/)
    // Old strip Exit path → same reset triple
    expect(src).toMatch(/onExitViewAs=\{\(\)=>\{ setViewAsUser\(null\); setRole\('super_admin'\); setLocFilter\('all'\) \}\}/)
    // The old footer blocks are gone (switcher comment + user-info block)
    expect(src).not.toContain('Location picker — elevated roles only')
    expect(src).not.toContain('User info at bottom')
    expect(src.match(/Sign Out/g) || []).toHaveLength(4) // mobile drawer + mobile menu + 2 non-chrome usages — the desktop footer's is gone
  })
})
