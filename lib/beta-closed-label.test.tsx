// @vitest-environment happy-dom
//
// ONE LABEL, TWO PLACES: the close action reads "Close".
//
// It briefly read "Closed" while fixing a worse label. Every other verb in
// these menus is imperative, so it is "Close".
//
// Before that it read "Close — not interested", which presupposed one of the very
// answers the wizard then asks the owner to pick — the lead may have gone
// elsewhere, gone quiet, or simply become unreachable. The verb now states
// the outcome and lets the wizard ask the reason.
//
// BOTH SURFACES OR NEITHER. The Inbox row menu and the client card's ⋯ menu
// open the IDENTICAL wizard, so two different labels for one action would be
// worse than either label alone. Both are asserted here.
//
// COPY ONLY. The `close-lost` key, CloseLostWizard, closed_reason and every
// 'closed_lost' in stage-emails / drip-lifecycle / welcome-email / auto-close
// are VOCABULARY, not copy, and are deliberately untouched — renaming them is
// a different job with real blast radius. The last block pins that.
//
// ASSERTED ON RENDERED OUTPUT, never on the source. A source grep would match
// the issue-204 comments, which stay exactly as they are — so a grep-based
// test would fail for a reason that has nothing to do with what an owner
// sees.
//
// THE MENUS RENDER THROUGH A PORTAL into document.body. A host-scoped lookup
// finds the wrong control and passes for the wrong reason — that mistake cost
// a build earlier today. Every menu assertion below is document-scoped.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import ClientProfile from '@/components/hive/ClientProfile'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: 'p-1', name: 'Sarah Watts', email: 'sarah@email.com', phone: '(561) 555-0199',
  locationId: 'loc-uuid-1', created: daysAgo(3),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null,
  jobberRef: null, outreachTimeline: [], ...over,
})

const profilePayload = (over: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Sarah Watts', first_name: 'Sarah', last_name: 'Watts',
    email: 'sarah@email.com', phone: '(561) 555-0199', address: '12 Oak St',
    stage: 'New', created_at: daysAgo(30), tags: [], jobber_client_id: null,
    is_junk: false, snoozed_until: null, inbox_dismissed_at: null, assigned_to: null,
    ...(over.client || {}),
  },
  referred_us: [], referred_us_total: 0, contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { owing: 0, paid: 0, invoiced: 0 },
})

let patches: any[] = []
let posts: any[] = []
let profileOver: any = {}

beforeEach(() => {
  patches = []; posts = []; profileOver = {}
  ;(globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url); const method = init?.method || 'GET'
    if (method === 'POST' && /\/api\/engagements$/.test(u)) {
      posts.push({ u, body: JSON.parse(init.body || '{}') })
      return { ok: true, json: async () => ({ engagement: { id: 'eng-NEW' } }) } as any
    }
    if (method === 'PATCH' && /\/api\/engagements\//.test(u)) {
      patches.push({ u, body: JSON.parse(init.body || '{}') })
      return { ok: true, json: async () => ({ id: 'eng-NEW', stage: 'Closed Lost' }) } as any
    }
    if (/close-not-interested$/.test(u)) return { ok: true, json: async () => ({ ok: true }) } as any
    if (/\/profile/.test(u)) return { ok: true, json: async () => profilePayload(profileOver) } as any
    return { ok: true, json: async () => ({}) } as any
  })
  document.body.innerHTML = ''
})

let root: any
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return host
}
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null; document.body.innerHTML = ''; vi.restoreAllMocks()
})
const click = (el: Element | null | undefined) => act(async () => {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

// DOCUMENT-scoped: both menus portal into body.
const menuButtons = () => [...document.querySelectorAll('button')]
const menuTexts = () => menuButtons().map(b => (b.textContent || '').trim())
// Menu rows now carry a DESCRIPTION under the label, so a row's textContent
// is label + sentence. Match the label's own span, and fall back to a testid
// where one exists — never an exact match on the whole row.
const itemLabelled = (label: string) => menuButtons().find(b => {
  const first = b.querySelector('span')
  return ((first?.textContent) || b.textContent || '').trim() === label
})

const openInboxMenu = async () => {
  const host = await mount(
    <InboxScreen people={[person()]} engagements={[]} locFilter="all"
      closeLostReasons={['Went quiet', 'Other']} setToast={() => {}} />)
  await click(host.querySelector('button[aria-label="More"]'))
  return host
}
const openCardMenu = async () => {
  const host = await mount(<ClientProfile clientId="lead-9" onClose={() => {}} />)
  const trigger = [...host.querySelectorAll('button')]
    .find(b => /^(More|Client actions|Record actions)$/.test(b.getAttribute('aria-label') || ''))
  await click(trigger)
  return host
}

describe('both surfaces say "Close"', () => {
  it('the Inbox row menu', async () => {
    await openInboxMenu()
    expect(itemLabelled('Close')).toBeTruthy()
  })

  it('the client card’s ⋯ menu', async () => {
    await openCardMenu()
    expect(itemLabelled('Close')).toBeTruthy()
  })

  it('and they are the SAME label — two surfaces, one action', async () => {
    await openInboxMenu()
    const fromInbox = (itemLabelled('Close')!.querySelector('span')!.textContent || '').trim()
    await act(async () => { root.unmount() }); root = null; document.body.innerHTML = ''

    await openCardMenu()
    const fromCard = (itemLabelled('Close')!.querySelector('span')!.textContent || '').trim()

    expect(fromInbox).toBe(fromCard)
    expect(fromInbox).toBe('Close')
  })
})

describe('"not interested" is gone from what an owner reads', () => {
  it('nowhere in the Inbox row menu', async () => {
    await openInboxMenu()
    expect(menuTexts().join(' | ').toLowerCase()).not.toContain('not interested')
  })

  it('nowhere in the card menu', async () => {
    await openCardMenu()
    expect(menuTexts().join(' | ').toLowerCase()).not.toContain('not interested')
  })

  it('nowhere on the whole Inbox surface, menu open', async () => {
    // Rendered output, not the source: the issue-204 comments stay.
    await openInboxMenu()
    expect((document.body.textContent || '').toLowerCase()).not.toContain('not interested')
  })

  it('nowhere on the whole card surface, menu open', async () => {
    await openCardMenu()
    expect((document.body.textContent || '').toLowerCase()).not.toContain('not interested')
  })

  it('nor in the wizard the action opens', async () => {
    // The wizard was checked too: it says "Close as lost", which is the
    // OUTCOME rather than a presupposed reason, so it is left alone.
    await openInboxMenu()
    await click(itemLabelled('Close'))
    const body = (document.body.textContent || '').toLowerCase()
    expect(body).toContain('close as lost')
    expect(body).not.toContain('not interested')
  })
})

describe('copy only — the behaviour underneath is untouched', () => {
  it('the renamed item still opens the same CloseLostWizard', async () => {
    await openInboxMenu()
    await click(itemLabelled('Close'))
    expect(document.body.textContent).toContain('Close as lost')
  })

  it('and still writes the same closed_reason through the same routes', async () => {
    await openInboxMenu()
    await click(itemLabelled('Close'))

    // Drive the wizard: reason step → Next → confirm.
    const next = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Next')
    await click(next)
    const confirm = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Close as lost')
    await click(confirm)
    await act(async () => { await Promise.resolve() })

    // A lead with no engagement founds one, then closes it Closed Lost.
    expect(posts.length + patches.length).toBeGreaterThan(0)
    const closing = patches.find(p => p.body?.stage === 'Closed Lost')
    expect(closing, 'the close still PATCHes stage Closed Lost').toBeTruthy()
    expect(closing.body.closed_reason).toBeTruthy()
    expect(String(closing.body.closed_reason)).not.toBe('won')
  })

  it('the vocabulary is deliberately NOT renamed', () => {
    // The key, the wizard and the stored reason are vocabulary, not copy.
    // Renaming them is a different job with real blast radius.
    const fs = require('node:fs'); const path = require('node:path')
    const card = fs.readFileSync(path.join(process.cwd(), 'components/hive/ClientProfile.jsx'), 'utf8')
    expect(card).toContain("key: 'close-lost'")
    expect(card).toContain('CloseLostWizard')
    const inbox = fs.readFileSync(path.join(process.cwd(), 'components/hive/InboxScreen.jsx'), 'utf8')
    expect(inbox).toContain('CloseLostWizard')
    // and the issue-204 comments survive, which is exactly why these tests
    // assert on rendered output rather than on the file
    expect(inbox.toLowerCase()).toContain('not interested')
    expect(card.toLowerCase()).toContain('not interested')
  })
})
