// @vitest-environment happy-dom
//
// THE GUIDED INTAKE — design A.
//
//   · all three doors open the form with the right type preselected, and a
//     seeded type skips the door
//   · each type asks its own three questions, one screen at a time, with a
//     progress bar
//   · the review step shows what was entered and can be edited
//   · context is attached without the owner typing it — screen and path
//     from the mount, device from the browser, shown as a line not a field
//   · answers 2 and 3 fold into the description under fixed headings; an
//     existing entry (a plain description) still renders in triage exactly
//     as before, because nothing about the column changed
//   · nothing that was silent before now sends — the only calls are the
//     upload(s) and POST /api/feedback, with the same body keys as the old
//     form
//   · on a phone the modal is a top-anchored sheet sized to the visual
//     viewport, and the field being answered is 16px
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import FeedbackModal from '@/components/feedback/FeedbackModal'
import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import OwnerFeedbackScreen from '@/components/feedback/OwnerFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import {
  INTAKE_DOORS, INTAKE_QUESTIONS, composeDescription, missingAnswers, deviceLabel, contextSentence,
} from '@/lib/feedback-intake'
import { buildSafeContext } from '@/lib/feedback-context'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Call = { url: string; method: string; body: any }
let calls: Call[] = []
const installFetch = () => {
  calls = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
    if (method !== 'GET') calls.push({ url: u, method, body: u.includes('/upload') ? '<form>' : (opts.body ? JSON.parse(opts.body) : null) })
    if (u.includes('/api/feedback/upload')) return json({ path: 'u1/uuid-shot.png', name: 'shot.png', size: 10, type: 'image/png' })
    if (u.includes('/api/feedback') && method === 'POST') return json({ id: 'fb-1', status: 'submitted' }, 201)
    if (u.includes('/api/admin/feedback')) return json({ items: [] })
    if (u.includes('/api/feedback')) return json({ items: [] })
    return json({})
  })
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element | null) => { expect(el, 'element to click').toBeTruthy(); return act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) }) }
const typeIn = (el: Element | null, value: string) => {
  expect(el, 'field to type in').toBeTruthy()
  return act(async () => {
    const proto = el!.tagName === 'TEXTAREA' ? (globalThis as any).window.HTMLTextAreaElement.prototype : (globalThis as any).window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const $ = (host: Element, sel: string) => host.querySelector(sel)
const stepOf = (host: Element) => $(host, '[data-intake-step]')?.getAttribute('data-intake-step')
const typeOf = (host: Element) => $(host, '[data-intake-step]')?.getAttribute('data-intake-type')
const prompt = (host: Element) => $(host, 'label[for^="intake-"]')?.textContent
const next = (host: Element) => click($(host, '[data-intake-next]'))
const post = () => calls.find(c => c.method === 'POST' && c.url.includes('/api/feedback') && !c.url.includes('/upload'))

// useIsMobile reads window.innerWidth after mount, so a mounted test sets the
// real width, not only the SSR seed flag.
const setWidth = (w: number) => {
  ;(globalThis as any).__BEE_TEST_WIDTH__ = w
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true })
}
beforeEach(() => { document.body.innerHTML = ''; installFetch(); setWidth(1024) })
afterEach(() => { vi.restoreAllMocks() })

// ─── the doors ────────────────────────────────────────────────────────

describe('the three doors', () => {
  it('are Report a bug · Ask a question · Suggest a feature, in that order', () => {
    expect(INTAKE_DOORS.map(d => [d.type, d.label])).toEqual([
      ['bug', 'Report a bug'], ['question', 'Ask a question'], ['feature', 'Suggest a feature'],
    ])
  })

  for (const d of INTAKE_DOORS) {
    it(`"${d.label}" opens the form on question 1 with type ${d.type}`, async () => {
      const { host, unmount } = await mount(<FeedbackModal initialTab="submit" onClose={() => {}} />)
      expect(stepOf(host)).toBe('door')
      await click($(host, `[data-intake-door="${d.type}"]`))
      expect(stepOf(host)).toBe('1')
      expect(typeOf(host)).toBe(d.type)
      expect(prompt(host)).toBe(INTAKE_QUESTIONS[d.type][0].prompt)
      await unmount()
    })
  }

  it('a seeded type (the Help ask strip, the record menus) skips the door', async () => {
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={{ type: 'question' }} onClose={() => {}} />)
    expect(stepOf(host)).toBe('1')
    expect(typeOf(host)).toBe('question')
    expect($(host, '[data-intake-door]')).toBeNull()
    await unmount()
  })
})

// ─── each type asks its own three questions ───────────────────────────

describe('each type asks its own three questions, one per screen', () => {
  const EXPECTED = {
    bug: ['What went wrong?', 'What did you expect, and what happened instead?', 'Where were you?'],
    question: ['What do you want to know?', 'What are you trying to do?', 'Anything else?'],
    feature: ['What would you like to be able to do?', 'What would that save you?', 'How do you handle it today?'],
  } as const

  for (const [type, prompts] of Object.entries(EXPECTED)) {
    it(`${type}: ${prompts.join(' → ')}`, async () => {
      const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={{ type }} onClose={() => {}} />)
      const seen: string[] = []
      for (let i = 1; i <= 3; i++) {
        expect(stepOf(host)).toBe(String(i))
        expect($(host, `[data-intake-progress="${i}"]`)).toBeTruthy()
        expect(host.textContent).toContain(`Step ${i} of 3`)
        seen.push(prompt(host) || '')
        // exactly one field on screen
        expect(host.querySelectorAll('[data-intake-field]').length).toBe(1)
        await typeIn($(host, '[data-intake-field]'), `answer ${i}`)
        await next(host)
      }
      expect(seen).toEqual([...prompts])
      expect(stepOf(host)).toBe('review')
      await unmount()
    })
  }

  it('a required question will not advance empty; an optional one offers Skip', async () => {
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={{ type: 'feature' }} onClose={() => {}} />)
    await next(host)
    expect(stepOf(host)).toBe('1')
    expect($(host, '[data-intake-missing]')).toBeTruthy()
    await typeIn($(host, '[data-intake-field="q1"]'), 'Text from the record')
    await next(host)
    await typeIn($(host, '[data-intake-field="q2"]'), 'Ten minutes a day')
    await next(host)
    expect(stepOf(host)).toBe('3')
    expect($(host, '[data-intake-next]')?.textContent).toBe('Skip')
    await next(host)
    expect(stepOf(host)).toBe('review')
    expect(host.textContent).toContain('Skipped')
    await unmount()
  })
})

// ─── the review step ──────────────────────────────────────────────────

describe('the review step', () => {
  it('shows every answer back and can edit one, then returns to the review', async () => {
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={{ type: 'bug' }} onClose={() => {}} />)
    await typeIn($(host, '[data-intake-field="q1"]'), 'Texts not sending')
    await next(host)
    await typeIn($(host, '[data-intake-field="q2"]'), 'Tapped Send, nothing happened')
    await next(host)
    await typeIn($(host, '[data-intake-field="q3"]'), 'Dana Whitfield, Emails tab')
    await next(host)
    expect(stepOf(host)).toBe('review')
    expect(host.textContent).toContain('Read it back')
    expect(host.textContent).toContain('Texts not sending')
    expect(host.textContent).toContain('Tapped Send, nothing happened')
    expect(host.textContent).toContain('Dana Whitfield, Emails tab')

    await click($(host, '[aria-label="Edit: What did you expect, and what happened instead?"]'))
    expect(stepOf(host)).toBe('2')
    expect(($(host, '[data-intake-field="q2"]') as HTMLTextAreaElement).value).toBe('Tapped Send, nothing happened')
    await typeIn($(host, '[data-intake-field="q2"]'), 'Tapped Send, spinner forever')
    expect($(host, '[data-intake-next]')?.textContent).toBe('Review')
    await next(host)
    expect(stepOf(host)).toBe('review')
    expect(host.textContent).toContain('Tapped Send, spinner forever')
    expect(host.textContent).not.toContain('nothing happened')

    await click($(host, '[data-intake-send]'))
    expect(post()!.body.title).toBe('Texts not sending')
    expect(post()!.body.description).toBe(
      'What I expected, and what happened instead:\nTapped Send, spinner forever\n\nWhere I was:\nDana Whitfield, Emails tab',
    )
    await unmount()
  })
})

// ─── context, without typing it ───────────────────────────────────────

describe('context is attached without the owner typing it', () => {
  it('screen and path ride from the mount, device from the browser, shown as a line', async () => {
    const ua = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', configurable: true })
    const ambient = { origin: 'feedback_modal', screen: 'Clients', path: '/clients/lead-9', lead_id: 'lead-9' }
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" ambientContext={ambient} onClose={() => {}} />)
    expect($(host, '[data-intake-context]')?.textContent).toContain('Sent from Clients on an iPhone')
    // there is no "where were you" field on the door, and the bug's question
    // 3 asks only for what the app cannot know
    expect(host.querySelectorAll('[data-intake-field]').length).toBe(0)
    await click($(host, '[data-intake-door="question"]'))
    await typeIn($(host, '[data-intake-field="q1"]'), 'How do I reassign?')
    await next(host)
    await typeIn($(host, '[data-intake-field="q2"]'), 'Handing a lead to Sam')
    await next(host)
    await next(host)
    expect($(host, '[data-intake-context]')?.textContent).toContain('Sent from Clients on an iPhone')
    await click($(host, '[data-intake-send]'))
    const ctx = post()!.body.context
    expect(ctx).toEqual({ ...ambient, device: 'iPhone' })
    // and every key survives the server's whitelist
    expect(buildSafeContext(ctx)).toEqual(ctx)
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
    await unmount()
  })

  it('a record seed still wins every collision, device included in neither direction', async () => {
    const recordCtx = { kind: 'client', lead_id: 'lead-9', location_id: 'loc-1', screen: 'Clients', path: '/clients/lead-9', origin: 'client_profile_menu' }
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={{ type: 'bug', title: 'Problem', context: recordCtx }} ambientContext={{ origin: 'feedback_modal', screen: 'Clients', path: '/clients' }} onClose={() => {}} />)
    await next(host)
    await typeIn($(host, '[data-intake-field="q2"]'), 'x')
    await next(host)
    await typeIn($(host, '[data-intake-field="q3"]'), 'y')
    await next(host)
    await click($(host, '[data-intake-send]'))
    const ctx = post()!.body.context
    for (const [k, v] of Object.entries(recordCtx)) expect(ctx[k]).toBe(v)
    await unmount()
  })

  it('the Help ask strip breadcrumb lands as an About: line, in words', async () => {
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={{ type: 'question', about: 'Getting started › Connect Jobber', context: { origin: 'help_ask_strip', screen: 'Help', help_entry_id: 't1' } }} onClose={() => {}} />)
    await typeIn($(host, '[data-intake-field="q1"]'), 'Where is the connect button?')
    await next(host)
    await typeIn($(host, '[data-intake-field="q2"]'), 'Linking my Jobber')
    await next(host)
    await next(host)
    expect(host.textContent).toContain('About: Getting started › Connect Jobber')
    await click($(host, '[data-intake-send]'))
    expect(post()!.body.description).toBe('What I’m trying to do:\nLinking my Jobber\n\nAbout: Getting started › Connect Jobber')
    expect(post()!.body.context.help_entry_id).toBe('t1')
    await unmount()
  })

  it('deviceLabel is a fixed vocabulary, never the user-agent string', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone')
    expect(deviceLabel('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)')).toBe('iPad')
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('Android')
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('Mac')
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('iPad')
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows')
    expect(deviceLabel('HappyDOM/1.0')).toBeNull()
    expect(deviceLabel('')).toBeNull()
    expect(contextSentence({ screen: 'Clients', device: 'iPhone' })).toBe('Sent from Clients on an iPhone')
    expect(contextSentence({ screen: 'Reports', device: 'Mac' })).toBe('Sent from Reports on a Mac')
    expect(contextSentence({ screen: 'Help' })).toBe('Sent from Help')
    expect(contextSentence({})).toBeNull()
  })
})

// ─── the description convention, and old entries ──────────────────────

describe('answers fold into the description; old entries render unchanged', () => {
  it('composeDescription puts answers 2 and 3 under fixed headings and omits an empty optional', () => {
    expect(composeDescription('feature', { q1: 'x', q2: 'An hour a week', q3: '' })).toBe('What it would save me:\nAn hour a week')
    expect(composeDescription('question', { q2: 'A', q3: 'B' })).toBe('What I’m trying to do:\nA\n\nAnything else:\nB')
    expect(composeDescription('bug', { q2: 'A', q3: 'B' }, 'Help › Clients')).toBe('What I expected, and what happened instead:\nA\n\nWhere I was:\nB\n\nAbout: Help › Clients')
    expect(missingAnswers('bug', { q1: 'x', q2: '', q3: ' ' })).toEqual(['q2', 'q3'])
    expect(missingAnswers('feature', { q1: 'x', q2: 'y' })).toEqual([])
  })

  const legacy = {
    id: 'old-1', title: 'The messages are not downloading', type: 'bug', status: 'under_review', is_internal: false,
    description: 'The messages are not downloading when a client receives them',
    user_id: 'u1', submitter_name: 'Casey Lee', submitter_email: 'c@x.com', location_id: 'loc-1', location_name: 'Palm Beach',
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', admin_response: null, admin_response_at: null,
    reply_seen_at: null, attachments: [], replies: [], context: null,
  }
  const asUser = (id: string, el: React.ReactNode) => <CurrentUserContext.Provider value={{ id, email: 'x@y.com', role: 'super_admin' } as any}>{el}</CurrentUserContext.Provider>

  it('an existing entry with a plain description still renders in triage exactly as before', async () => {
    ;(globalThis as any).fetch = vi.fn(async (url: any) => {
      const u = String(url)
      if (u.startsWith('/api/admin/feedback')) return { ok: true, status: 200, json: async () => ({ items: [legacy] }) }
      return { ok: true, status: 200, json: async () => ({ items: [] }) }
    })
    const { host, unmount } = await mount(asUser('admin-1', <AdminFeedbackScreen />))
    expect(host.textContent).toContain('The messages are not downloading')
    expect(host.textContent).toContain('The messages are not downloading when a client receives them')
    // the description is printed as-is: no heading was invented for it
    expect(host.textContent).not.toContain('What I expected')
    expect(host.textContent).not.toContain('Where I was')
    await unmount()
  })

  it('…and on the owner screen', async () => {
    ;(globalThis as any).fetch = vi.fn(async (url: any) => {
      const u = String(url)
      if (u.startsWith('/api/admin/feedback')) return { ok: true, status: 200, json: async () => ({ items: [legacy] }) }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    expect(host.textContent).toContain('The messages are not downloading when a client receives them')
    expect(host.textContent).not.toContain('Where I was')
    await unmount()
  })
})

// ─── nothing new sends ────────────────────────────────────────────────

describe('nothing that was silent before now sends', () => {
  it('a full submission makes exactly the upload(s) and one POST /api/feedback, with the same body keys as the old form', async () => {
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={{ type: 'bug' }} onClose={() => {}} />)
    await typeIn($(host, '[data-intake-field="q1"]'), 'Broken')
    await next(host)
    // attach a screenshot on question 2
    const fileInput = $(host, 'input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()
    Object.defineProperty(fileInput, 'files', { value: [new File(['x'], 'shot.png', { type: 'image/png' })], configurable: true })
    Object.defineProperty(fileInput, 'value', { value: '', writable: true, configurable: true })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })) })
    await typeIn($(host, '[data-intake-field="q2"]'), 'Expected a text, got nothing')
    await next(host)
    await typeIn($(host, '[data-intake-field="q3"]'), 'Clients tab')
    await next(host)
    await click($(host, '[data-intake-send]'))

    const nonGet = calls.map(c => `${c.method} ${c.url}`)
    expect(nonGet).toEqual(['POST /api/feedback/upload', 'POST /api/feedback'])
    expect(Object.keys(post()!.body).sort()).toEqual(['attachments', 'description', 'title', 'type'])
    expect(post()!.body.attachments).toHaveLength(1)
    // no slack, no email, no notification route was called
    expect((globalThis as any).fetch.mock.calls.some((c: any[]) => /slack|notify|email|resend/i.test(String(c[0])))).toBe(false)
    await unmount()
  })
})

// ─── the phone ────────────────────────────────────────────────────────

describe('on a phone', () => {
  it('the modal is a top-anchored sheet and the field is 16px, with Next in flow under it', async () => {
    setWidth(390)
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" seed={{ type: 'bug' }} onClose={() => {}} />)
    const shell = $(host, '[data-feedback-modal]')!
    expect(shell.getAttribute('data-feedback-modal')).toBe('sheet')
    expect((shell as HTMLElement).style.alignItems).toBe('flex-start')
    const f = $(host, '[data-intake-field="q1"]') as HTMLElement
    expect(f.style.fontSize).toBe('16px')
    // Next comes after the field in document order — under it, not pinned
    // to the bottom edge the keyboard covers
    const nextBtn = $(host, '[data-intake-next]')!
    expect(f.compareDocumentPosition(nextBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((nextBtn as HTMLElement).style.position).not.toBe('fixed')
    await unmount()
  })

  it('on desktop it stays the centred modal', async () => {
    setWidth(1280)
    const { host, unmount } = await mount(<FeedbackModal initialTab="submit" onClose={() => {}} />)
    expect($(host, '[data-feedback-modal]')?.getAttribute('data-feedback-modal')).toBe('modal')
    await unmount()
  })
})
