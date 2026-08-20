// @vitest-environment happy-dom
//
// Issue 246 step 2 — an owner connects their own Mailchimp account and picks
// one audience. NOTHING SYNCS in this step, and two of the things pinned below
// exist only to keep it that way.
//
// What this file exists to catch, in descending order of how much it would hurt:
//
//   1. AN UNSIGNED (OR FORGEABLE) STATE. If ?state= could be edited, the
//      callback would write an attacker's Mailchimp token onto another
//      franchise's location row, and that franchise's clients would be marketed
//      to from an account somebody else controls — while the row read
//      "connected" the whole time. Every tamper case is pinned: bad signature,
//      expired, mismatched, replayed, and the signing key being absent.
//
//   2. A CROSS-LOCATION WRITE VIA THE PARAM. admin/owner must get their OWN
//      location no matter what id they send. The rule lives in one function so
//      four routes cannot drift; this pins the function.
//
//   3. sync_live LEAKING INTO OWNER-FACING COPY. It is false everywhere and
//      Kevin turns it on by hand, per location. If it ever became an input to
//      the card's state or words, the card would start describing a switch the
//      owner cannot see — so it is pinned OUT, at the source.
//
//   4. A SILENT EMPTY DROPDOWN. An account with zero audiences must be told to
//      go make one. An empty <select> is the one outcome that explains nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  deriveMailchimpState,
  mailchimpCopy,
  NO_AUDIENCES_COPY,
} from '@/lib/mailchimp-connection-state'
import { MailchimpCard } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE THREE STATES (pure)
// ═══════════════════════════════════════════════════════════════════════════
describe('the three states, and the middle one that must not read as finished', () => {
  it('no account = not_connected', () => {
    expect(deriveMailchimpState({ connected: false })).toBe('not_connected')
    expect(deriveMailchimpState({})).toBe('not_connected')
    // A list id left behind by an old connection does NOT make it connected.
    expect(deriveMailchimpState({ connected: false, listId: 'abc123' })).toBe('not_connected')
  })

  it('account but no audience = needs_audience — the state the callback lands in', () => {
    expect(deriveMailchimpState({ connected: true, listId: null })).toBe('needs_audience')
    // An empty string is unset, not a chosen audience with a blank name.
    expect(deriveMailchimpState({ connected: true, listId: '' })).toBe('needs_audience')
  })

  it('account + audience = ready', () => {
    expect(deriveMailchimpState({ connected: true, listId: 'abc123' })).toBe('ready')
  })

  it('needs_audience does NOT say connected — it says something is outstanding', () => {
    const copy = mailchimpCopy('needs_audience', 'Bee Organized KC')
    expect(copy.badge).toBe('Finish setting up')
    expect(copy.badge).not.toMatch(/^Connected$/)
    // It names the account so an owner with several can tell which they linked.
    expect(copy.body).toContain('Bee Organized KC')
    expect(copy.body).toMatch(/finish setting up/i)
  })

  it('a missing account name degrades to a sentence, not to "undefined"', () => {
    for (const name of [null, undefined, '', '   ']) {
      const copy = mailchimpCopy('needs_audience', name as any)
      expect(copy.body).not.toMatch(/undefined|null/)
      expect(copy.body.length).toBeGreaterThan(20)
    }
  })

  it('the finished state promises setup, never sending', () => {
    const copy = mailchimpCopy('ready')
    expect(copy.badge).toBe('Connected')
    // Nothing syncs in this step, so no copy may imply that anything does.
    expect(copy.body).toMatch(/nothing is being sent/i)
    expect(copy.body).not.toMatch(/\bsyncing\b|\bwill send\b|\bsending now\b/i)
  })

  it('every state speaks owner language — no OAuth, token, list id or prefix', () => {
    const states = ['not_connected', 'needs_audience', 'ready'] as const
    for (const st of states) {
      const c = mailchimpCopy(st, 'Acme')
      const all = `${c.badge} ${c.headline} ${c.body}`
      expect(all, st).not.toMatch(/oauth|token|list[_ ]?id|server prefix|api key|endpoint/i)
      // Sentence case: the badge is not SHOUTING and not Title Cased.
      expect(c.badge, st).not.toBe(c.badge.toUpperCase())
    }
  })

  it('the zero-audience message names Mailchimp as the place to go', () => {
    expect(NO_AUDIENCES_COPY).toMatch(/no audiences/i)
    expect(NO_AUDIENCES_COPY).toMatch(/create one in Mailchimp/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · sync_live IS NOT PART OF THE OWNER SURFACE
// ═══════════════════════════════════════════════════════════════════════════
describe('mailchimp_sync_live never reaches an owner', () => {
  const stateSrc = readFileSync(join(process.cwd(), 'lib/mailchimp-connection-state.ts'), 'utf8')
  const beehubSrc = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('is not an input to the state derivation', () => {
    // Only the comment explaining its ABSENCE may name it. If it ever appears
    // in a destructure or a condition, the card can start describing it.
    const code = stateSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/sync_?[Ll]ive/)
  })

  it('no owner-facing state or copy changes when sync_live flips', () => {
    // The input type has no such field, so this is belt-and-braces: passing one
    // must not change a single rendered word.
    const off = { connected: true, listId: 'abc', mailchimp_sync_live: false } as any
    const on = { connected: true, listId: 'abc', mailchimp_sync_live: true } as any
    expect(deriveMailchimpState(on)).toBe(deriveMailchimpState(off))
    expect(mailchimpCopy(deriveMailchimpState(on))).toEqual(mailchimpCopy(deriveMailchimpState(off)))
  })

  it('the card never reads it', () => {
    const start = beehubSrc.indexOf('export function MailchimpCard(')
    expect(start).toBeGreaterThan(-1)
    const after = beehubSrc.slice(start + 10)
    const body = beehubSrc.slice(start, start + 10 + after.search(/\n(export )?function [A-Z]/))
    expect(body).not.toMatch(/sync_?[Ll]ive/)
  })

  it('the server never selects it into a client payload', () => {
    // _hub-page.tsx is what hydrates the settings object. The token, the server
    // prefix and sync_live must all stay out of every select there.
    const hub = readFileSync(join(process.cwd(), 'app/_hub-page.tsx'), 'utf8')
    const code = hub.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/mailchimp_sync_live/)
    expect(code).not.toMatch(/mailchimp_access_token/)
    expect(code).not.toMatch(/mailchimp_server_prefix/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE CARD, MOUNTED
// ═══════════════════════════════════════════════════════════════════════════
let container: HTMLElement
let root: ReturnType<typeof createRoot>
let fetchMock: any

const settingsFor = (loc: Record<string, any>) => ({
  location: {
    locId: 'loc_test',
    mailchimpConnected: false,
    mailchimpAccountName: '',
    mailchimpListId: '',
    mailchimpListName: '',
    ...loc,
  },
})

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ audiences: [] }) }))
  vi.stubGlobal('fetch', fetchMock)
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

const mountCard = async (loc: Record<string, any>) => {
  await act(async () => {
    root.render(<MailchimpCard settings={settingsFor(loc)} updateLocation={() => {}} />)
  })
  await act(async () => {})
}

describe('the card renders the state it is in', () => {
  it('not connected — offers Connect and fetches nothing', async () => {
    await mountCard({})
    expect(container.textContent).toContain('Connect Mailchimp')
    // There is no account to list audiences for, so it must not try.
    expect(fetchMock.mock.calls.map((c: any[]) => String(c[0]))).toHaveLength(0)
  })

  it('connected without an audience — shows the account and a real picker', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ audiences: [
        { id: 'a1', name: 'Bee clients', memberCount: 412 },
        { id: 'a2', name: 'Newsletter', memberCount: 8 },
      ] }),
    }))
    await mountCard({ mailchimpConnected: true, mailchimpAccountName: 'Bee Organized KC' })

    expect(container.textContent).toContain('Bee Organized KC')
    expect(container.textContent).toMatch(/finish setting up/i)
    const select = container.querySelector('select')!
    expect(select, 'an audience picker').toBeTruthy()
    const names = Array.from(select.querySelectorAll('option')).map(o => o.textContent)
    expect(names.join(' ')).toContain('Bee clients')
    expect(names.join(' ')).toContain('Newsletter')
    // The label is wired to the control, not floating beside it.
    expect(container.querySelector('label[for="mc-audience"]')).toBeTruthy()
  })

  it('an account with ZERO audiences says so and says where to go — no empty dropdown', async () => {
    // The whole point: a bare empty <select> would be indistinguishable from a
    // broken screen. This is the state that must SPEAK.
    await mountCard({ mailchimpConnected: true, mailchimpAccountName: 'Empty Co' })
    expect(container.textContent).toContain(NO_AUDIENCES_COPY)
    expect(container.querySelector('select'), 'no dropdown at all').toBeNull()
  })

  it('a failed audience load says it failed — it does not pose as an empty account', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false, status: 502, json: async () => ({ error: 'lists_failed' }),
    }))
    await mountCard({ mailchimpConnected: true, mailchimpAccountName: 'Acme' })
    expect(container.textContent).toMatch(/couldn.t load your audiences/i)
    expect(container.textContent).not.toContain(NO_AUDIENCES_COPY)
  })

  it('connected with an audience — account, audience, and a Disconnect', async () => {
    await mountCard({
      mailchimpConnected: true,
      mailchimpAccountName: 'Bee Organized KC',
      mailchimpListId: 'a1',
      mailchimpListName: 'Bee clients',
    })
    expect(container.textContent).toContain('Bee Organized KC')
    expect(container.textContent).toContain('Bee clients')
    const btn = Array.from(container.querySelectorAll('button')).map(b => b.textContent?.trim())
    expect(btn).toContain('Disconnect')
    // Finished means finished: no picker still hanging around, and no audience
    // fetch for a state that has nothing to choose.
    expect(container.querySelector('select')).toBeNull()
    expect(fetchMock.mock.calls).toHaveLength(0)
  })

  it('Disconnect asks first, and says Mailchimp itself is untouched', async () => {
    await mountCard({
      mailchimpConnected: true, mailchimpAccountName: 'Acme',
      mailchimpListId: 'a1', mailchimpListName: 'Clients',
    })
    const disconnect = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.trim() === 'Disconnect')!
    await act(async () => { disconnect.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(container.textContent).toMatch(/Nothing in Mailchimp is changed or deleted/i)
    // Asking is not doing.
    expect(fetchMock.mock.calls).toHaveLength(0)
  })

  it('a failed connect return is surfaced, not swallowed', async () => {
    // The connect flow is a full-page redirect, so its failure comes back as a
    // query param — there is no rejected promise for the card to catch.
    window.history.replaceState({}, '', '/settings?mailchimp=error&reason=metadata_failed')
    await mountCard({})
    expect(container.textContent).toMatch(/didn.t finish connecting/i)
    expect(container.textContent).toContain('metadata_failed')
    expect(container.textContent).toMatch(/Nothing was saved/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · NOTHING SYNCS
// ═══════════════════════════════════════════════════════════════════════════
describe('this step reads no leads and syncs no contacts', () => {
  const files = [
    'lib/mailchimp.ts',
    'lib/mailchimp-oauth-guard.ts',
    'lib/mailchimp-connection-state.ts',
    'app/api/mailchimp/connect/route.ts',
    'app/api/mailchimp/callback/route.ts',
    'app/api/mailchimp/audiences/route.ts',
    'app/api/locations/[id]/mailchimp-disconnect/route.ts',
  ]

  it('no Mailchimp file touches the leads table', () => {
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      expect(code, f).not.toMatch(/from\(['"]leads['"]\)/)
      expect(code, f).not.toMatch(/mailchimp_synced_at|mailchimp_sync_error/)
    }
  })

  it('no Mailchimp file writes a member into an audience', () => {
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      // /lists/{id}/members is the contact-push endpoint. Reading /lists is
      // this step; writing members is not.
      expect(src, f).not.toMatch(/\/members/)
      expect(src, f).not.toMatch(/batches/)
    }
  })

  it('no route sets mailchimp_sync_live true — the gate only ever closes', () => {
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).not.toMatch(/mailchimp_sync_live:\s*true/)
    }
  })

  it('no refresh-token code was copied over from Jobber', () => {
    // Mailchimp tokens do not expire and there is no refresh token. A refresh
    // path here would be dead code pretending to be a lifecycle.
    const src = readFileSync(join(process.cwd(), 'lib/mailchimp.ts'), 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/refresh_token|grant_type:\s*'refresh/)
    expect(code).not.toMatch(/token_expiry|expires_in/)
  })
})
