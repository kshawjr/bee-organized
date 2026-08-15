// @vitest-environment happy-dom
//
// Issue 246a — the Profile tab saves what it says it saves.
//
// The defect: First Name, Last Name, Email and Phone all called updateProfile(),
// which is setSettings() and nothing else. An owner edited, saw the row close on
// the new value, reloaded, and it was gone. They are visually identical to the
// eight Location rows that persist correctly, on the only tab every role sees.
//
// Mount tests rather than source pins, for the reason the sibling 240 suite
// gives: a source pin passes as long as the string exists somewhere in a 35k-line
// file. What matters here is that clicking Save actually reaches the DB route,
// and that a REJECTED save does not paint.
//
// Pinned:
//   1) First / Last / Phone each PATCH /api/hub_users/me with the right column
//   2) the write lands before the paint — a 500 leaves the old value on screen
//      and tells the owner plainly (no false success)
//   3) what is written is what is read back on reload (column round-trip)
//   4) Email is read-only BY DESIGN — sign-in is Google OAuth and the route
//      deliberately refuses email; editing the copy would desync it from auth
//   5) Sign Out actually ends the session via /api/auth/signout
//   6) the Role and Location ID read-only rows are untouched
//   7) no "coming soon" survives on this tab
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen, CurrentUserContext } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const HUB = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
const ROUTE = readFileSync(join(process.cwd(), 'app/api/hub_users/me/route.ts'), 'utf8')

const currentUser = {
  id: '9a8b7c6d-1111-4222-8333-444455556666',
  email: 'riley@bee.test',
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
let fetchMock: ReturnType<typeof vi.fn>
let alerts: string[]

beforeEach(() => {
  alerts = []
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', (m: string) => { alerts.push(String(m)) })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const mount = async (user: any = currentUser) => {
  await act(async () => root.unmount())
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={user}>
        <SettingsScreen initialSection="profile" franchiseRole="owner" />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => {})   // flush mount-time fetches
}

// A SettingsEditRow is: row > flex > [ col(label <p>, value <p>|input), buttons ].
// Find the label <p>, then walk up three levels to the row container.
const rowFor = (label: string): HTMLElement => {
  const p = Array.from(container.querySelectorAll('p'))
    .find(el => (el.textContent ?? '').trim() === label)
  if (!p) throw new Error(`no settings row labelled "${label}"`)
  return p.parentElement!.parentElement!.parentElement! as HTMLElement
}

const buttonIn = (row: HTMLElement, text: string): HTMLButtonElement | undefined =>
  Array.from(row.querySelectorAll('button'))
    .find(b => (b.textContent ?? '').trim() === text) as HTMLButtonElement | undefined

// The displayed value <p> is the second <p> in the row (first is the label).
const shownValue = (label: string): string => {
  const ps = rowFor(label).querySelectorAll('p')
  return (ps[1]?.textContent ?? '').trim()
}

// React tracks input value on the node; a bare .value assignment is ignored.
const typeInto = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// Click Edit, type, click Save. Returns after the save promise settles.
const editRow = async (label: string, value: string) => {
  await act(async () => { buttonIn(rowFor(label), 'Edit')!.click() })
  const input = rowFor(label).querySelector('input') as HTMLInputElement
  await typeInto(input, value)
  await act(async () => { buttonIn(rowFor(label), 'Save')!.click() })
  await act(async () => {})   // flush the fetch + post-write paint
}

const profilePatches = () =>
  fetchMock.mock.calls
    .filter(c => String(c[0]) === '/api/hub_users/me' && (c[1] as any)?.method === 'PATCH')
    .map(c => JSON.parse(String((c[1] as any).body)))

// ── 1) the three editable rows reach the DB ───────────────────────────
describe('First / Last / Phone persist through PATCH /api/hub_users/me', () => {
  it('First Name writes first_name', async () => {
    await mount()
    await editRow('First Name', 'Alex')
    expect(profilePatches()).toEqual([{ first_name: 'Alex' }])
  })

  it('Last Name writes last_name', async () => {
    await mount()
    await editRow('Last Name', 'Nguyen')
    expect(profilePatches()).toEqual([{ last_name: 'Nguyen' }])
  })

  it('Phone writes phone', async () => {
    await mount()
    await editRow('Phone', '(312) 555-0177')
    expect(profilePatches()).toEqual([{ phone: '(312) 555-0177' }])
  })

  it('a landed write paints the new value', async () => {
    await mount()
    await editRow('First Name', 'Alex')
    expect(shownValue('First Name')).toBe('Alex')
  })

  it('none of the four rows is local-only any more — updateProfile is not their onSave', () => {
    // the exact defect: onSave={v=>updateProfile('firstName',v)}
    expect(HUB).not.toMatch(/onSave=\{v=>updateProfile\('firstName',v\)\}/)
    expect(HUB).not.toMatch(/onSave=\{v=>updateProfile\('lastName',v\)\}/)
    expect(HUB).not.toMatch(/onSave=\{v=>updateProfile\('email',v\)\}/)
    expect(HUB).not.toMatch(/onSave=\{v=>updateProfile\('phone',v\)\}/)
  })
})

// ── 2) a rejected write must not paint ────────────────────────────────
describe('a failed write surfaces an error and does not paint a false success', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async () => ({
      ok: false, status: 500, json: async () => ({ error: 'Failed to update profile' }),
    }))
  })

  it('the row keeps its OLD value when the server rejects', async () => {
    await mount()
    await editRow('First Name', 'Alex')
    expect(shownValue('First Name')).toBe('Riley')
  })

  it('the owner is told, in the server\'s own words', async () => {
    await mount()
    await editRow('First Name', 'Alex')
    expect(alerts.join('\n')).toContain('Failed to update profile')
  })

  it('a network throw is caught and surfaced, not swallowed', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('offline') })
    await mount()
    await editRow('Phone', '(312) 555-0177')
    expect(shownValue('Phone')).toBe('(206) 555-0100')
    expect(alerts.join('\n')).toContain('offline')
  })

  it('paint happens AFTER the write lands, never optimistically', () => {
    // updateProfile must sit below the res.ok guard inside persistProfileField
    const fn = HUB.slice(
      HUB.indexOf('async function persistProfileField'),
      HUB.indexOf('async function persistBookingLink'),
    )
    expect(fn).toBeTruthy()
    expect(fn.indexOf('if (!res.ok)')).toBeGreaterThan(-1)
    expect(fn.indexOf('updateProfile(stateKey, v)')).toBeGreaterThan(fn.indexOf('if (!res.ok)'))
  })

  it('a save is refused outright when there is no real signed-in hub user', async () => {
    // Without currentUserCtx the rows are USERS_DATA demo data with fabricated
    // @beehub.io addresses, and the route writes the CALLER's own row — so a
    // save from that state would stamp a placeholder onto a real account.
    await mount(null)
    const row = rowFor('First Name')
    if (buttonIn(row, 'Edit')) {
      await editRow('First Name', 'Alex')
      expect(profilePatches()).toEqual([])
      expect(alerts.join('\n')).toMatch(/not signed in as this person/)
    }
  })
})

// ── 3) what is written is what is read back ───────────────────────────
describe('the saved value survives a reload', () => {
  it('the columns written are the columns the mount reads back', () => {
    // persistProfileField writes first_name / last_name / phone; locProfile
    // hydrates firstName / lastName / phone from those same hub_users columns,
    // so a reload re-renders the saved value rather than the pre-edit one.
    expect(HUB).toMatch(/firstName: currentUserCtx\.first_name/)
    expect(HUB).toMatch(/lastName:\s+currentUserCtx\.last_name/)
    expect(HUB).toMatch(/phone:\s+currentUserCtx\.phone/)
    expect(HUB).toContain("persistProfileField('firstName','first_name'")
    expect(HUB).toContain("persistProfileField('lastName','last_name'")
    expect(HUB).toContain("persistProfileField('phone','phone'")
  })

  it('a remount on the saved row shows the saved value', async () => {
    // stands in for the reload: the row re-reads from hub_users, not state
    await mount({ ...currentUser, first_name: 'Alex', last_name: 'Nguyen', phone: '(312) 555-0177' })
    expect(shownValue('First Name')).toBe('Alex')
    expect(shownValue('Last Name')).toBe('Nguyen')
    expect(shownValue('Phone')).toBe('(312) 555-0177')
  })

  it('the route persists all three and recomputes full_name', () => {
    expect(ROUTE).toMatch(/const \{ first_name, last_name, phone, booking_link \} =/)
    expect(ROUTE).toContain('patch.first_name = first_name.trim() || null')
    expect(ROUTE).toContain('patch.last_name  = last_name.trim()  || null')
    expect(ROUTE).toContain('patch.phone      = phone.trim()      || null')
    expect(ROUTE).toContain('patch.full_name = full || null')
  })
})

// ── 4) Email is read-only by design ───────────────────────────────────
describe('Email is read-only because it is the Google sign-in identity', () => {
  it('the row offers no Edit affordance', async () => {
    await mount()
    expect(buttonIn(rowFor('Email'), 'Edit')).toBeUndefined()
    expect(rowFor('Email').textContent).toContain('Read-only')
  })

  it('it still SHOWS the address — read-only, not removed', async () => {
    await mount()
    expect(shownValue('Email')).toBe('riley@bee.test')
  })

  it('it says why, rather than looking broken', async () => {
    await mount()
    expect(rowFor('Email').textContent).toMatch(/sign in with Google/i)
  })

  it('the route refuses email — it is not in the accepted-field list', () => {
    expect(ROUTE).not.toMatch(/patch\.email\s*=/)
    expect(ROUTE).toMatch(/email is intentionally not editable/)
  })

  it('sign-in really is OAuth-only, so there is no address to change here', () => {
    const login = readFileSync(join(process.cwd(), 'app/auth/login/page.tsx'), 'utf8')
    expect(login).toContain('signInWithOAuth')
    expect(login).not.toContain('signInWithPassword')
  })
})

// ── 5) Sign Out ends the session ──────────────────────────────────────
describe('Sign Out', () => {
  const findAccountButton = (label: string): HTMLButtonElement => {
    const b = Array.from(container.querySelectorAll('button'))
      .find(el => (el.textContent ?? '').includes(label))
    if (!b) throw new Error(`no account button "${label}"`)
    return b as HTMLButtonElement
  }

  it('navigates to the route that clears the Supabase session', async () => {
    await mount()
    const navigations: string[] = []
    const real = window.location
    Object.defineProperty(window, 'location', {
      configurable: true, writable: true,
      value: { get href() { return '' }, set href(v: string) { navigations.push(v) } },
    })
    try {
      await act(async () => { findAccountButton('Sign Out').click() })
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, writable: true, value: real })
    }
    expect(navigations).toEqual(['/api/auth/signout'])
  })

  it('that route really signs out server-side and bounces to login', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/auth/signout/route.ts'), 'utf8')
    expect(src).toContain('await supabase.auth.signOut()')
    expect(src).toContain("new URL('/auth/login'")
    expect(src).toContain('export const GET = doSignOut')
  })

  it('it is no longer an alert', async () => {
    await mount()
    await act(async () => { findAccountButton('Sign Out').click() })
    expect(alerts.join('\n')).not.toMatch(/coming soon/i)
  })
})

// ── 6) Change Password says something true ────────────────────────────
describe('Change Password', () => {
  it('does not claim to be coming soon', async () => {
    await mount()
    const b = Array.from(container.querySelectorAll('button'))
      .find(el => (el.textContent ?? '').includes('Change Password')) as HTMLButtonElement
    await act(async () => { b.click() })
    expect(alerts.join('\n')).not.toMatch(/coming soon/i)
    expect(alerts.join('\n')).toMatch(/Google/)
  })

  it('nothing on this tab says "coming soon" any more', async () => {
    await mount()
    expect(container.textContent ?? '').not.toMatch(/coming soon/i)
  })
})

// ── 7) the read-only rows this issue must not disturb ─────────────────
describe('the read-only rows are unchanged', () => {
  it('Role still reads read-only with its franchisor hint', async () => {
    await mount()
    expect(buttonIn(rowFor('Role'), 'Edit')).toBeUndefined()
    expect(rowFor('Role').textContent).toContain('Contact your franchisor to change your role')
    expect(HUB).toContain(
      '<SettingsEditRow label="Role"       value={settings.profile.role}      readOnly hint="Contact your franchisor to change your role" />',
    )
  })

  it('Location ID is untouched on the Location tab', () => {
    expect(HUB).toContain(
      '<SettingsEditRow label="Location ID"     value={settings.location.locId||\'—\'}   readOnly hint="Your unique franchise location identifier" />',
    )
  })

  it('the Location rows still persist through their own route, not this one', () => {
    expect(HUB).toContain("persistLocationField('name','name',v,'location name')")
    expect(HUB).toMatch(/fetch\(`\/api\/locations\/\$\{realLocId\}`/)
  })
})
