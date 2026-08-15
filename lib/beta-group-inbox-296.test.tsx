// @vitest-environment happy-dom
//
// Issue 296 — A JOB TYPE CAN SEND FROM A GROUP INBOX.
//
// A job type's client emails very commonly come from a shared mailbox —
// moving@beeorganized-kc.com — not a person. Six of the twenty configured
// locations already do this at LOCATION level, and loc_lakenorman runs exactly
// this shape today: From is the group inbox, Reply-To is a person. This makes
// it sayable per JOB TYPE, without giving up the per-type assignee that issue
// 246 was built to deliver.
//
//   WHO HANDLES IT    source_user_id. A person. Drives assignment. Required.
//   WHAT IT SENDS AS  sender_is_custom + name/email/reply_to. The handler's own
//                     identity, or a hand-typed one.
//
// WHY THIS FILE EXISTS AT ALL — and why it leans on the UI rather than the lib.
// The natural guard against dropping a new field is the type system: issue 246
// step 2 made source_user_id required on SenderIdentity precisely so a caller
// that omitted it failed the BUILD instead of writing a null. That lever works,
// and 296 pulls it again for sender_is_custom. But it is powerless exactly
// where the original bug lived: tsconfig.json's `include` is
// ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"] — no .jsx —
// so components/BeeHub.jsx is never type-checked. The four UI layers that
// actually dropped sender_reply_to for its entire life are invisible to tsc.
// A test is the only thing that can see them. Hence: payload assertions on the
// real component, not just on the lib.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = '132b42c2-0000-4000-8000-000000000001'

// ── The config the section renders ──────────────────────────────────────────
// Moving is handled by Carol but sends from the shared moving@ mailbox, with
// replies reaching Carol. Organizing is plain person mode. That pair is the
// whole feature in one fixture.
const CFG = () => ({
  base_sender_email: 'hello@beeorganized-kc.com',
  base_sender_domain: 'beeorganized-kc.com',
  project_types: ['Home or Office Organizing', 'Moving/Relocation'],
  project_type_groups: [
    { label: 'Home or Office Organizing', drip_category: 'general' },
    { label: 'Moving/Relocation', drip_category: 'move' },
  ],
  assignments: [
    {
      id: 'a1', project_type: 'Home or Office Organizing',
      sender_name: 'Lynette Ewy', sender_email: 'lynette@beeorganized-kc.com',
      sender_reply_to: null, sender_is_custom: false,
      source_user_id: 'u-lynette', domain_warning: false,
    },
    {
      id: 'a2', project_type: 'Moving/Relocation',
      sender_name: 'Bee Organized Moving', sender_email: 'moving@beeorganized-kc.com',
      sender_reply_to: 'carol@beeorganized-kc.com', sender_is_custom: true,
      source_user_id: 'u-carol', domain_warning: false,
    },
  ],
  people: [
    { id: 'u-lynette', name: 'Lynette Ewy', email: 'lynette@beeorganized-kc.com', role: 'owner', domain_warning: false },
    { id: 'u-carol', name: 'Carol Kern', email: 'carol@beeorganized-kc.com', role: 'manager', domain_warning: false },
  ],
})

const NOTIF = {
  project_types: ['Home or Office Organizing', 'Moving/Relocation'],
  users: [
    { hub_user_id: 'u-lynette', name: 'Lynette Ewy', email: 'lynette@beeorganized-kc.com', role: 'owner', subscribed: true },
    { hub_user_id: 'u-carol', name: 'Carol Kern', email: 'carol@beeorganized-kc.com', role: 'manager', subscribed: true },
  ],
  externals: [],
}

let container: HTMLDivElement
let root: any
let calls: Array<{ url: string; method: string; body: any }> = []

const mountSection = async (cfg: any = CFG(), ok = true) => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    const json = url.includes('project-type-senders') ? cfg
      : url.includes('notification-recipients') ? NOTIF
      : {}
    const isWrite = (init?.method || 'GET') !== 'GET'
    return { ok: isWrite ? ok : true, status: isWrite && !ok ? 400 : 200, json: async () => json }
  }))
  const { NewLeadsSection } = await import('@/components/BeeHub')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<NewLeadsSection realLocId={LOC} />) })
  await act(async () => {})
  return container
}

const row = (label: string) => container.querySelector(`[data-handler-row="${label}"]`) as HTMLElement
const selects = (label: string) =>
  Array.from(row(label).querySelectorAll('select')) as HTMLSelectElement[]
const handlerSelect = (label: string) => selects(label)[0]
const sendsAsSelect = (label: string) => selects(label)[1]
const writes = () => calls.filter(c => c.method !== 'GET')

const change = async (el: HTMLSelectElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})
}

const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
  vi.unstubAllGlobals()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the two questions are asked as equals', () => {
  it('every job type row asks who handles it AND what it sends as', async () => {
    await mountSection()
    for (const label of ['Home or Office Organizing', 'Moving/Relocation']) {
      expect(selects(label), label).toHaveLength(2)
    }
  })

  it('neither question is labelled as an exception to the other', async () => {
    // The framing is the requirement: group inboxes are common, so this is one
    // of two normal answers, not an "advanced override" behind a toggle. If
    // someone later reframes it, this fails.
    await mountSection()
    const txt = container.textContent || ''
    expect(txt).toContain('Who handles it')
    expect(txt).toContain('What it sends as')
    expect(txt.toLowerCase()).not.toContain('advanced')
    expect(txt.toLowerCase()).not.toContain('override')
  })

  it('shows a typed sender back to the owner, address and reply-to', async () => {
    // Before 296 a saved typed sender would have been invisible on reload: the
    // only control read source_user_id, so a group inbox rendered identically
    // to no configuration at all.
    await mountSection()
    const txt = row('Moving/Relocation').textContent || ''
    expect(txt).toContain('moving@beeorganized-kc.com')
    expect(txt).toContain('carol@beeorganized-kc.com')
    expect(sendsAsSelect('Moving/Relocation').value).toBe('custom')
  })

  it('a person-mode row shows the handler and their own address', async () => {
    await mountSection()
    expect(sendsAsSelect('Home or Office Organizing').value).toBe('person')
    expect(row('Home or Office Organizing').textContent).toContain('lynette@beeorganized-kc.com')
  })

  it('a type on The location owner has no sender to set, and says so', async () => {
    // source_user_id is NOT NULL, so a typed sender lives ON a handler row. A
    // type with no row has nowhere to keep one — stated, not silently disabled.
    const cfg = CFG(); cfg.assignments = []
    await mountSection(cfg)
    const s = sendsAsSelect('Moving/Relocation')
    expect(s.disabled).toBe(true)
    expect(row('Moving/Relocation').textContent).toContain("Your location's sending address")
  })

  it('controls are capped, never stretched', async () => {
    await mountSection()
    for (const s of Array.from(container.querySelectorAll('select')) as HTMLSelectElement[]) {
      expect(s.style.maxWidth, 'each select carries an explicit cap').toBeTruthy()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('THE SILENT WIPE — the UI half', () => {
  it('re-picking a handler sends ONLY the person, never a sender identity', async () => {
    // The lib refuses to clobber a typed identity (see
    // project-type-senders-config.test.ts), but the payload is the other half:
    // the old UI posted sender_name/sender_email on every handler pick, which
    // is what made the wipe reachable in the first place. If a future edit puts
    // an identity back into this body, this fails.
    await mountSection()
    await change(handlerSelect('Moving/Relocation'), 'u-lynette')

    const post = writes().find(c => c.method === 'POST')!
    expect(post.body).toEqual({ source_user_id: 'u-lynette', project_types: ['Moving/Relocation'] })
    expect(post.body).not.toHaveProperty('sender_name')
    expect(post.body).not.toHaveProperty('sender_email')
    expect(post.body).not.toHaveProperty('sender_reply_to')
    expect(post.body).not.toHaveProperty('sender_is_custom')
  })

  it('choosing The location owner still DELETEs the row', async () => {
    await mountSection()
    await change(handlerSelect('Moving/Relocation'), '')
    const del = writes().find(c => c.method === 'DELETE')!
    expect(del.body).toEqual({ project_types: ['Moving/Relocation'] })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('sender_reply_to — the field that was never writable', () => {
  it('the typed-sender editor offers a reply-to and PUTs it', async () => {
    // It has had a column, a validator, a persist path and a send-path reader
    // since it was created, and zero non-null rows in production, because no UI
    // ever put it in a body. This is that UI.
    await mountSection()
    await change(sendsAsSelect('Home or Office Organizing'), 'custom')

    const editor = row('Home or Office Organizing')
      .querySelector('[data-sender-editor]') as HTMLElement
    expect(editor).toBeTruthy()

    const [name, email, replyTo] = Array.from(editor.querySelectorAll('input')) as HTMLInputElement[]
    await type(name, 'Bee Organized Organizing')
    await type(email, 'organizing@beeorganized-kc.com')
    await type(replyTo, 'lynette@beeorganized-kc.com')

    const save = Array.from(editor.querySelectorAll('button'))
      .find(b => b.textContent === 'Save') as HTMLButtonElement
    await act(async () => { save.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})

    const put = writes().find(c => c.method === 'PUT')!
    expect(put.body).toEqual({
      project_type: 'Home or Office Organizing',
      sender_is_custom: true,
      sender_name: 'Bee Organized Organizing',
      sender_email: 'organizing@beeorganized-kc.com',
      sender_reply_to: 'lynette@beeorganized-kc.com',
    })
  })

  it('a blank reply-to PUTs null rather than an empty string', async () => {
    await mountSection()
    await change(sendsAsSelect('Home or Office Organizing'), 'custom')
    const editor = row('Home or Office Organizing').querySelector('[data-sender-editor]') as HTMLElement
    const [name, email, replyTo] = Array.from(editor.querySelectorAll('input')) as HTMLInputElement[]
    await type(name, 'Shared')
    await type(email, 'shared@beeorganized-kc.com')
    await type(replyTo, '')
    const save = Array.from(editor.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLButtonElement
    await act(async () => { save.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})
    expect(writes().find(c => c.method === 'PUT')!.body.sender_reply_to).toBeNull()
  })

  it('switching back to the handler PUTs person mode and no addresses', async () => {
    await mountSection()
    await change(sendsAsSelect('Moving/Relocation'), 'person')
    const put = writes().find(c => c.method === 'PUT')!
    expect(put.body).toEqual({ project_type: 'Moving/Relocation', sender_is_custom: false })
  })

  it('the PUT never names a person — it cannot reassign the type', async () => {
    await mountSection()
    await change(sendsAsSelect('Moving/Relocation'), 'person')
    expect(writes().find(c => c.method === 'PUT')!.body).not.toHaveProperty('source_user_id')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the route file states the contract it enforces', () => {
  const route = readFileSync(
    join(process.cwd(), 'app/api/locations/[id]/project-type-senders/route.ts'),
    'utf8',
  )

  it('exports the PUT the UI calls', async () => {
    // beta-sender-toggle-retired-246c sweeps components/ for fetches whose verb
    // the route does not export — the defect that shipped in 246 step 2. This
    // is the same guarantee stated locally, so a deleted PUT fails here too.
    expect(route).toMatch(/export async function PUT/)
  })

  it('validates sender_reply_to with the same EMAIL_RE as every other address', async () => {
    // It was only ever trimmed. Harmless while nothing could write it; a
    // malformed value now reaches Resend and fails the send at delivery, which
    // reads as a broken drip rather than a typo in settings.
    expect(route).toMatch(/EMAIL_RE\.test\(senderReplyTo\)/)
  })

  it('POST no longer takes a sender identity off the request', async () => {
    // Person mode means "send as the handler", so the identity has exactly one
    // truthful source: their hub_users row. Reading it server-side also stops an
    // authenticated owner persisting an arbitrary address as someone's identity.
    const post = route.slice(route.indexOf('export async function POST'), route.indexOf('export async function PUT'))
    expect(post).not.toMatch(/body\?\.sender_name/)
    expect(post).not.toMatch(/body\?\.sender_email/)
    expect(post).toMatch(/getPickableHandler/)
  })
})
