// @vitest-environment happy-dom
//
// issue 249 — every feedback submission records WHERE it came from.
//
// Before this, only the two record-menu affordances ("Report a problem with
// this client/engagement") populated feedback_items.context; the general
// FeedbackModal sent nothing, so 60 of 63 rows had no context at all and the
// triage step had only the owner's prose to place a bug from.
//
// What is pinned here:
//   • the AMBIENT builder is strict — an unknown screen yields NO screen key,
//     never a fallback label (a guessed screen is worse than an absent one)
//   • `path` carries only whitelisted query params — ?e= and ?section= locate
//     the user, ?feedback=1 and anything else are dropped
//   • the general modal's submission carries screen + path
//   • a RECORD report still sends byte-for-byte what it sent before (the seed
//     wins every collision, so the two affordances keep one vocabulary)
//   • the keys survive the FULL round trip — modal body → buildSafeContext →
//     insert → read back — not merely the write
//   • nothing outside the id-only whitelist is ever persisted (issue 110a)
//   • BeeHub actually MOUNTS the modal with ambientContext — a prop that is
//     accepted but never passed is the silent-drop shape this repo keeps hitting
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import FeedbackModal from '@/components/feedback/FeedbackModal'
import { buildAmbientContext, navScreenLabel, safeContextPath } from '@/components/hive/shared/hubUrl'
import { buildSafeContext, insertFeedbackRow, FEEDBACK_CONTEXT_KEYS } from '@/lib/feedback-context'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

type Call = { url: string; method: string; body: any }
let calls: Call[] = []
const installFetch = () => {
  calls = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
    if (method !== 'GET') {
      const isUpload = u.includes('/upload')
      calls.push({ url: u, method, body: isUpload ? '<form>' : (opts.body ? JSON.parse(opts.body) : null) })
    }
    if (u.includes('/api/feedback') && method === 'POST') return json({ id: 'fb-1', status: 'submitted' }, 201)
    if (u.includes('/api/feedback')) return json({ items: [] })
    return json({})
  })
}

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
const typeIn = (el: Element, value: string) => act(async () => {
  const proto = el.tagName === 'TEXTAREA'
    ? (globalThis as any).window.HTMLTextAreaElement.prototype
    : (globalThis as any).window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
// The tab strip also has a button reading "Submit"; the action button is last.
const submitBtn = (host: Element) =>
  [...host.querySelectorAll('button')].filter(b => (b.textContent || '').trim() === 'Submit').pop()!
const postBody = () =>
  calls.find(c => c.url.includes('/api/feedback') && c.method === 'POST' && !c.url.includes('/upload'))!.body

// Drive a full general-modal submission with the given ambient context.
const submitGeneral = async (ambientContext: any) => {
  const { host, unmount } = await mount(
    <FeedbackModal initialTab="submit" ambientContext={ambientContext} onClose={() => {}} />,
  )
  await typeIn(host.querySelector('input[placeholder="Short summary"]')!, 'Board is slow')
  await typeIn(host.querySelector('textarea')!, 'Takes ten seconds to open.')
  await click(submitBtn(host))
  await unmount()
  return postBody()
}

beforeEach(() => { document.body.innerHTML = ''; installFetch() })

// ─── The ambient builder ──────────────────────────────────────────────

describe('navScreenLabel — the shared vocabulary, strict on unknowns', () => {
  it('maps each nav key to the label the record menus already use', () => {
    expect(navScreenLabel('hive')).toBe('Clients')
    expect(navScreenLabel('home')).toBe('Home')
    expect(navScreenLabel('partners')).toBe('Network')
    expect(navScreenLabel('reports')).toBe('Reports')
    expect(navScreenLabel('backoffice')).toBe('Back Office')
    expect(navScreenLabel('settings')).toBe('Settings')
  })

  it('resolves admin by role, as the existing inline maps do', () => {
    expect(navScreenLabel('admin', 'super_admin')).toBe('Admin')
    expect(navScreenLabel('admin', 'corporate')).toBe('Corp')
  })

  // The whole point of the strictness: no invented label reaches the column.
  it('returns null — NOT a fallback label — for an unknown nav', () => {
    expect(navScreenLabel('nope' as any)).toBeNull()
    expect(navScreenLabel(undefined as any)).toBeNull()
  })
})

describe('safeContextPath — pathname plus only whitelisted params', () => {
  it('keeps ?e= (the engagement) and ?section= (the settings screen)', () => {
    expect(safeContextPath('/clients/lead-9', '?e=eng-3')).toBe('/clients/lead-9?e=eng-3')
    expect(safeContextPath('/settings', '?section=emails')).toBe('/settings?section=emails')
  })

  it('drops ?feedback=1 — it says how the modal opened, not where the user was', () => {
    expect(safeContextPath('/reports', '?feedback=1')).toBe('/reports')
  })

  // A query string is exactly where free text would first appear.
  it('drops any param not on the list, including free text', () => {
    expect(safeContextPath('/clients', '?q=dana%40example.com&sort=name')).toBe('/clients')
    expect(safeContextPath('/clients', '?e=eng-3&q=dana')).toBe('/clients?e=eng-3')
  })

  it('returns null when there is no usable pathname (SSR)', () => {
    expect(safeContextPath(null as any, '')).toBeNull()
    expect(safeContextPath('clients', '')).toBeNull()
  })
})

describe('buildAmbientContext — where the user was standing', () => {
  it('carries screen, path and origin from the Clients tab', () => {
    expect(buildAmbientContext({ nav: 'hive', pathname: '/clients', search: '' })).toEqual({
      origin: 'feedback_modal', screen: 'Clients', path: '/clients',
    })
  })

  // Free: the Hub already reflects the open record into the address bar.
  it('lifts the open record ids out of the URL', () => {
    expect(buildAmbientContext({ nav: 'hive', pathname: '/clients/lead-9', search: '?e=eng-3' })).toEqual({
      origin: 'feedback_modal',
      screen: 'Clients',
      path: '/clients/lead-9?e=eng-3',
      lead_id: 'lead-9',
      engagement_id: 'eng-3',
    })
  })

  it('omits screen entirely when the nav is unknown — no fake value', () => {
    const ctx = buildAmbientContext({ nav: 'nope', pathname: '/somewhere', search: '' })
    expect('screen' in ctx).toBe(false)
    expect(ctx.path).toBe('/somewhere')
  })

  it('degrades to origin alone when nothing is knowable', () => {
    expect(buildAmbientContext({})).toEqual({ origin: 'feedback_modal' })
  })

  it('never emits a key outside the persisted whitelist', () => {
    const ctx = buildAmbientContext({ nav: 'hive', role: 'super_admin', pathname: '/clients/l1', search: '?e=e1&section=x' })
    for (const k of Object.keys(ctx)) expect(FEEDBACK_CONTEXT_KEYS).toContain(k)
  })
})

// ─── The modal ────────────────────────────────────────────────────────

describe('the general modal now says where it came from', () => {
  it('a submission carries screen and path', async () => {
    const body = await submitGeneral(buildAmbientContext({ nav: 'reports', pathname: '/reports', search: '' }))
    expect(body.context).toEqual({ origin: 'feedback_modal', screen: 'Reports', path: '/reports' })
  })

  it('a submission with no screen available still saves, without a fake value', async () => {
    const body = await submitGeneral(buildAmbientContext({ nav: 'nope', pathname: null, search: null }))
    // It filed…
    expect(body.title).toBe('Board is slow')
    // …and invented nothing.
    expect(body.context).toEqual({ origin: 'feedback_modal' })
    expect('screen' in body.context).toBe(false)
    expect('path' in body.context).toBe(false)
  })

  // The pre-249 behaviour for a modal mounted with neither seed nor ambient.
  it('sends no context key at all when there is nothing to send', async () => {
    const body = await submitGeneral(null)
    expect('context' in body).toBe(false)
  })

  it('keeps the screen on a SECOND report filed without closing the modal', async () => {
    const ambient = buildAmbientContext({ nav: 'hive', pathname: '/clients', search: '' })
    const { host, unmount } = await mount(
      <FeedbackModal initialTab="submit" ambientContext={ambient} onClose={() => {}} />,
    )
    for (const n of ['First', 'Second']) {
      await click([...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Submit')!)
      await typeIn(host.querySelector('input[placeholder="Short summary"]')!, n)
      await typeIn(host.querySelector('textarea')!, `${n} report.`)
      await click(submitBtn(host))
    }
    const posts = calls.filter(c => c.method === 'POST' && !c.url.includes('/upload'))
    expect(posts).toHaveLength(2)
    for (const p of posts) expect(p.body.context.screen).toBe('Clients')
    await unmount()
  })
})

// ─── The record menus must be untouched ───────────────────────────────

const CLIENT_CONTEXT = {
  kind: 'client', lead_id: 'lead-9', location_id: 'loc-1',
  screen: 'Clients', path: '/clients/lead-9', origin: 'client_profile_menu',
}
const ENGAGEMENT_CONTEXT = {
  kind: 'engagement', engagement_id: 'eng-3', lead_id: 'lead-9', location_id: 'loc-1',
  stage: 'Estimate', screen: 'Clients', path: '/clients/lead-9?e=eng-3', origin: 'engagement_panel_menu',
}

describe('a record report still carries exactly what it carried before', () => {
  for (const [label, ctx] of [['client', CLIENT_CONTEXT], ['engagement', ENGAGEMENT_CONTEXT]] as const) {
    it(`the ${label} menu's context survives the merge unchanged`, async () => {
      // Ambient for the SAME screen is present underneath — the realistic case,
      // since both menus only open from the Clients tab.
      const ambient = buildAmbientContext({ nav: 'hive', pathname: '/clients/lead-9', search: '' })
      const { host, unmount } = await mount(
        <FeedbackModal initialTab="submit" seed={{ type: 'bug', title: 'Problem', context: ctx }}
                       ambientContext={ambient} onClose={() => {}} />,
      )
      await typeIn(host.querySelector('textarea')!, 'Something is wrong.')
      await click(submitBtn(host))
      // Byte-for-byte: the seed wins every collision, incl. origin.
      expect(postBody().context).toEqual(ctx)
      await unmount()
    })
  }

  // The affordances themselves are the other half of "unchanged".
  it('both menus still hand over the same screen vocabulary', () => {
    const profile = readSrc('components/hive/ClientProfile.jsx')
    const panel = readSrc('components/hive/EngagementPanel.jsx')
    expect(profile).toContain("origin: 'client_profile_menu'")
    expect(panel).toContain("origin: 'engagement_panel_menu'")
    for (const src of [profile, panel]) expect(src).toContain("screen: 'Clients'")
  })
})

// ─── The full round trip ──────────────────────────────────────────────

// Everything the route does between the POST body and the stored row, using
// the REAL helpers: re-sanitize, then insert. A write-only assertion would
// miss a key dropped on the way back out, so this reads the row again.
const roundTrip = async (bodyContext: unknown) => {
  let stored: Record<string, unknown> | null = null
  const { data, error } = await insertFeedbackRow(
    async (row) => { stored = { id: 'fb-1', ...row }; return { data: stored as any, error: null } },
    { user_id: 'u1', location_id: 'loc-1', type: 'bug', title: 't', description: 'd', status: 'submitted', attachments: [] },
    buildSafeContext(bodyContext),
  )
  expect(error).toBeNull()
  // The read-back: what a later GET select('*') would hand the triage screen.
  return (data as any)?.context ?? null
}

describe('the keys survive the round trip, not just the write', () => {
  it('a general submission reads back with its screen and path', async () => {
    const sent = await submitGeneral(buildAmbientContext({ nav: 'settings', pathname: '/settings', search: '?section=emails' }))
    const readBack = await roundTrip(sent.context)
    expect(readBack).toEqual({
      origin: 'feedback_modal', screen: 'Settings', path: '/settings?section=emails',
    })
  })

  it('a record report reads back with every key it sent', async () => {
    expect(await roundTrip(ENGAGEMENT_CONTEXT)).toEqual(ENGAGEMENT_CONTEXT)
  })

  it('a context of only unwhitelisted keys stores NO column rather than an empty one', async () => {
    expect(await roundTrip({ client_name: 'Dana', email: 'dana@example.com' })).toBeNull()
  })
})

describe('nothing outside the whitelist is ever persisted', () => {
  it('strips PII smuggled alongside the real keys', async () => {
    const readBack = await roundTrip({
      ...CLIENT_CONTEXT,
      client_name: 'Dana Client', email: 'dana@example.com', phone: '555-0100', notes: 'free text',
    })
    expect(readBack).toEqual(CLIENT_CONTEXT)
    for (const k of Object.keys(readBack)) expect(FEEDBACK_CONTEXT_KEYS).toContain(k)
  })
})

// ─── The mount itself ─────────────────────────────────────────────────

// A prop the modal accepts but nobody passes reads exactly like a shipped
// feature and stores exactly nothing. BeeHub is 37k lines and cannot be
// mounted here, so its single FeedbackModal mount is pinned as source.
describe('BeeHub passes the ambient context (mount blind spot)', () => {
  const src = readSrc('components/BeeHub.jsx')

  it('imports the builder and hands it to the one FeedbackModal mount', () => {
    expect(src).toContain('buildAmbientContext')
    const mountLine = src.split('\n').find(l => l.includes('<FeedbackModal'))
    expect(mountLine, 'FeedbackModal mount not found in BeeHub').toBeTruthy()
    expect(mountLine!).toContain('ambientContext={buildAmbientContext(')
    expect(mountLine!).toContain('nav: activeNav')
  })

  it('there is still exactly ONE FeedbackModal mount to keep in step', () => {
    expect(src.match(/<FeedbackModal/g) ?? []).toHaveLength(1)
  })
})
