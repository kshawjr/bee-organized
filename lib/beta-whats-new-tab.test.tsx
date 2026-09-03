// @vitest-environment happy-dom
//
// WHAT'S NEW, AS SEEN.
//
//   · Help has a third tab, and ?tab=new lands on it
//   · an owner sees published weeks grouped New / Changed / Fixed, and no
//     draft, no pencil, no plus, no preview button (the server sends none
//     of it; the screen draws none of it either)
//   · an editor sees the draft above the weeks, the count of lines still in
//     the owner's words, those lines greyed and flagged
//   · the pencil opens the sheet with the original report as reference;
//     Save PATCHes the line; Remove asks once, then DELETEs
//   · the plus row opens a blank sheet; Add POSTs a hand-written line
//   · Preview the Slack post shows the route's text in a textarea; what is
//     in the textarea is what "Post and publish" sends; the outcome line
//     says posted — or says the post didn't go and the week is still out
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import HelpScreen from '@/components/help/HelpScreen'
import WhatsNew from '@/components/help/WhatsNew'

const line = (over: any) => ({ id: 'x', release_id: 'r', group: 'fixed', title: 'Line', body: null, edited_at: '2026-09-01T00:00:00Z', unedited: false, ...over })
const PUB = {
  id: 'r-pub', week_start: '2026-08-21', publish_on: '2026-08-27', status: 'published', summary: 'A quieter week.', published_at: '2026-08-27T20:00:00Z', week_label: 'Thu, Aug 27',
  groups: {
    new: [line({ id: 'p1', group: 'new', title: 'Two addresses per client', body: 'A move adds an address; it never edits history.' })],
    changed: [],
    fixed: [line({ id: 'p2', title: 'The Inbox badge no longer counts hidden leads.', body: 'If they disagree, the Inbox says so.' })],
    question: [line({ id: 'p3', group: 'question', title: 'Do archived Jobber quotes close the deal?', body: 'Yes — archive it in Jobber and the deal goes to Closed Lost on its own.' })],
  },
  item_count: 3, unedited_count: 0,
}
const DRAFT = {
  id: 'r-draft', week_start: '2026-08-28', publish_on: '2026-09-03', status: 'draft', summary: null, published_at: null, week_label: 'Thu, Sep 3',
  groups: {
    new: [],
    changed: [],
    question: [],
    fixed: [
      line({ id: 'd1', title: 'Archiving a quote in Jobber closes the deal as Closed Lost.', body: 'No more moving it by hand.', feedback_item_id: 'fb-3', source: { title: 'Jobber - Quote Archive = Job Lost', type: 'bug', description: 'When we Archive a quote in Jobber...', admin_response: 'Shipped — this now works.' } }),
      line({ id: 'd2', title: 'Inbox has a circle 1', body: null, edited_at: null, unedited: true, feedback_item_id: 'fb-4', source: { title: 'Inbox has a circle 1', type: 'bug', description: 'A circle one is appearing in my inbox but it is empty', admin_response: 'Fixed. That lonely "1" was a lead your filters were hiding.' } }),
      line({ id: 'd3', title: 'Prefill Issue', body: null, edited_at: null, unedited: true, feedback_item_id: 'fb-5', source: { title: 'Prefill Issue', type: 'bug', description: 'After search, the name did not prefill', admin_response: null } }),
    ],
  },
  item_count: 3, unedited_count: 2,
}
const OWNER = { releases: [PUB], draft: null, canEdit: false }
const EDITOR = { releases: [PUB], draft: DRAFT, canEdit: true }
const PREVIEW = { text: '🐝 *The Waggle* · week ending Thu, Sep 3\nHere is what changed in Bee Hub this week.\n\n✅ *Fixed*\n• *Archiving a quote in Jobber closes the deal as Closed Lost.* — No more moving it by hand.\n\nThe full list lives in Bee Hub under Help › What’s new. 🍯', included: 1, left_out: [{ id: 'd2', title: 'Inbox has a circle 1', reason: 'their_words' }, { id: 'd3', title: 'Prefill Issue', reason: 'their_words' }], variant: 0, variants: 3, channel: { id: 'C0BTS6KGLNP', name: '#tech-updates-info' } }

function stubFetch(routes: Record<string, any>) {
  const f = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    for (const [prefix, payload] of Object.entries(routes)) {
      if (u.startsWith(prefix)) {
        const out = typeof payload === 'function' ? payload(u, init) : payload
        return { ok: true, status: 200, json: async () => out } as any
      }
    }
    return { ok: true, status: 200, json: async () => ({}) } as any
  })
  ;(globalThis as any).fetch = f
  return f
}

async function mount(el: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(el) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = async (el: Element | null) => { expect(el, 'element to click').toBeTruthy(); await act(async () => { (el as HTMLElement).click() }); await act(async () => { await Promise.resolve() }) }
const type = async (el: Element | null, value: string) => {
  expect(el, 'field to type into').toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })) })
}
const q = (host: HTMLElement, sel: string) => host.querySelector(sel)
const qa = (host: HTMLElement, sel: string) => Array.from(host.querySelectorAll(sel))
const calls = (f: any, method: string) => f.mock.calls.filter((c: any[]) => (c[1]?.method || 'GET') === method).map((c: any[]) => ({ url: String(c[0]), body: c[1]?.body ? JSON.parse(c[1].body) : null }))

afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, '', '/help'); document.body.innerHTML = '' })

// ─── the tab ───────────────────────────────────────────────────────────

describe('the tab', () => {
  it('Help has a third tab, and ?tab=new lands on it', async () => {
    window.history.replaceState({}, '', '/help?tab=new')
    const f = stubFetch({ '/api/help/releases': OWNER, '/api/help/entries': { sections: [], deleted: [], canEdit: false } })
    const { host, unmount } = await mount(<HelpScreen canEdit={false} role="franchise" franchiseRole="owner" />)
    const tabs = qa(host, '[role="tab"]').map(t => [t.textContent, t.getAttribute('aria-selected')])
    expect(tabs).toEqual([['Help', 'false'], ['What’s new', 'true'], ['My requests', 'false']])
    expect(f.mock.calls.some(c => String(c[0]).startsWith('/api/help/releases'))).toBe(true)
    expect(host.textContent).toContain('Week ending Thu, Aug 27')
    await unmount()
  })
})

describe('an owner', () => {
  it('sees the published weeks grouped, and nothing to edit', async () => {
    stubFetch({ '/api/help/releases': OWNER })
    const { host, unmount } = await mount(<WhatsNew canEdit={false} />)
    expect(qa(host, '[data-whatsnew-release]').map(r => r.getAttribute('data-whatsnew-release'))).toEqual(['r-pub'])
    expect(host.textContent).toContain('A quieter week.')
    expect(qa(host, '[data-whatsnew-group]').map(g => g.getAttribute('data-whatsnew-group'))).toEqual(['new', 'fixed', 'question'])
    expect(host.textContent).toContain('💬 You asked')
    expect(host.textContent).toContain('“Do archived Jobber quotes close the deal?”')
    expect(host.querySelector('[data-whatsnew-number]')).toBeNull() // owners never see the number
    expect(host.textContent).toContain('Two addresses per client')
    expect(host.textContent).toContain('A move adds an address; it never edits history.')
    expect(q(host, '[data-whatsnew-draft]')).toBeNull()
    expect(q(host, '[aria-label^="Edit "]')).toBeNull()
    expect(q(host, '[data-whatsnew-add]')).toBeNull()
    expect(q(host, '[data-whatsnew-preview]')).toBeNull()
    await unmount()
  })
  it('with nothing published yet, sees one plain line', async () => {
    stubFetch({ '/api/help/releases': { releases: [], draft: null, canEdit: false } })
    const { host, unmount } = await mount(<WhatsNew canEdit={false} />)
    expect(host.textContent).toContain('Nothing here yet')
    await unmount()
  })
})

// ─── the editor ────────────────────────────────────────────────────────

describe('an editor', () => {
  it('sees the draft above the weeks, the count, and the lines in the owner’s words greyed and flagged', async () => {
    stubFetch({ '/api/help/releases': EDITOR })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    const draft = q(host, '[data-whatsnew-draft="r-draft"]') as HTMLElement
    expect(draft).toBeTruthy()
    expect(draft.compareDocumentPosition(q(host, '[data-whatsnew-release="r-pub"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(q(host, '[data-whatsnew-unedited-count]')!.textContent).toContain('2 lines are still in the owner’s words')
    expect(qa(draft, '[data-whatsnew-unedited="true"]').map(e => e.getAttribute('data-whatsnew-item'))).toEqual(['d2', 'd3'])
    expect(qa(draft, '[data-whatsnew-flag]').map(e => e.textContent)).toEqual(['Their words', 'Their words'])
    expect((q(draft, '[data-whatsnew-item="d2"]') as HTMLElement).style.opacity).toBe('0.55')
    expect((q(draft, '[data-whatsnew-item="d1"]') as HTMLElement).style.opacity).toBe('1')
    expect(qa(draft, '[aria-label^="Edit "]').length).toBe(4) // three lines + the summary
    expect(q(draft, '[data-whatsnew-add]')).toBeTruthy()
    expect(q(draft, '[data-whatsnew-preview]')).toBeTruthy()
    await unmount()
  })

  it('the pencil opens the sheet with the original report as reference; Save PATCHes the line', async () => {
    const f = stubFetch({ '/api/help/releases/items/d2': { id: 'd2', unedited: false }, '/api/help/releases': EDITOR })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    await click(q(host, '[aria-label="Edit Inbox has a circle 1"]'))
    const sheet = q(document.body, '[data-whatsnew-sheet="edit"]') as HTMLElement
    expect(sheet).toBeTruthy()
    expect(q(sheet, '[data-whatsnew-source]')!.textContent).toContain('A circle one is appearing in my inbox but it is empty')
    expect(q(sheet, '[data-whatsnew-source]')!.textContent).toContain('That lonely "1" was a lead your filters were hiding.')
    expect((q(sheet, '#wn-title') as HTMLInputElement).value).toBe('Inbox has a circle 1')
    expect((q(sheet, '#wn-title') as HTMLElement).style.fontSize).toBe('16px')
    expect((q(sheet, '#wn-body') as HTMLElement).style.fontSize).toBe('16px')
    await type(q(sheet, '#wn-title'), 'The Inbox badge no longer counts hidden leads.')
    await type(q(sheet, '#wn-body'), 'If the badge and the list disagree, the Inbox says a filter is hiding one.')
    await click(q(sheet, '[data-whatsnew-group-pick="changed"]'))
    await click(q(sheet, '[data-whatsnew-save]'))
    const patches = calls(f, 'PATCH')
    expect(patches).toEqual([{ url: '/api/help/releases/items/d2', body: { group: 'changed', title: 'The Inbox badge no longer counts hidden leads.', body: 'If the badge and the list disagree, the Inbox says a filter is hiding one.' } }])
    expect(q(document.body, '[data-whatsnew-sheet]')).toBeNull() // closed, list reloaded
    await unmount()
  })

  it('Remove asks once, then DELETEs the line and nothing else', async () => {
    const f = stubFetch({ '/api/help/releases/items/d3': { ok: true }, '/api/help/releases': EDITOR })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    await click(q(host, '[aria-label="Edit Prefill Issue"]'))
    const sheet = q(document.body, '[data-whatsnew-sheet="edit"]') as HTMLElement
    await click(q(sheet, '[data-whatsnew-remove]'))
    expect(sheet.textContent).toContain('The report stays Fixed.')
    expect(calls(f, 'DELETE')).toEqual([])
    await click(q(sheet, '[data-whatsnew-remove-confirm]'))
    expect(calls(f, 'DELETE')).toEqual([{ url: '/api/help/releases/items/d3', body: null }])
    expect(calls(f, 'PATCH')).toEqual([])
    await unmount()
  })

  it('the plus row opens a blank sheet; Add POSTs a hand-written line', async () => {
    const f = stubFetch({ '/api/help/releases/items': { id: 'new' }, '/api/help/releases': EDITOR })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    await click(q(host, '[data-whatsnew-add]'))
    const sheet = q(document.body, '[data-whatsnew-sheet="add"]') as HTMLElement
    expect(sheet).toBeTruthy()
    expect(q(sheet, '[data-whatsnew-source]')).toBeNull()
    expect(q(sheet, '[data-whatsnew-remove]')).toBeNull()
    expect((q(sheet, '[data-whatsnew-save]') as HTMLButtonElement).disabled).toBe(true)
    await click(q(sheet, '[data-whatsnew-group-pick="new"]'))
    await type(q(sheet, '#wn-title'), 'Timezone is a dropdown everywhere')
    await type(q(sheet, '#wn-body'), 'Arizona is its own entry.')
    await click(q(sheet, '[data-whatsnew-save]'))
    expect(calls(f, 'POST')).toEqual([{ url: '/api/help/releases/items', body: { group: 'new', title: 'Timezone is a dropdown everywhere', body: 'Arizona is its own entry.' } }])
    await unmount()
  })

  it('the summary pencil saves the week’s one line', async () => {
    const f = stubFetch({ '/api/help/releases/r-draft': { id: 'r-draft' }, '/api/help/releases': EDITOR })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    await click(q(host, '[data-whatsnew-edit-summary]'))
    const sheet = q(document.body, '[data-whatsnew-sheet="summary"]') as HTMLElement
    await type(q(sheet, '#wn-summary'), 'Two fixes and a faster Inbox.')
    await click(q(sheet, '[data-whatsnew-save]'))
    expect(calls(f, 'PATCH')).toEqual([{ url: '/api/help/releases/r-draft', body: { summary: 'Two fixes and a faster Inbox.' } }])
    await unmount()
  })
})

// ─── the Slack post ────────────────────────────────────────────────────

describe('the Slack post', () => {
  it('the preview shows the route’s text, names what is left out, and posts the textarea — publishing the week', async () => {
    const f = stubFetch({
      '/api/help/releases/r-draft/slack': PREVIEW,
      '/api/help/releases/r-draft': { release: { id: 'r-draft', status: 'published' }, published_count: 1, left_out: 2, carried_to: { week_start: '2026-09-04', publish_on: '2026-09-10' }, slack: { posted: true, problem: null, skipped: false } },
      '/api/help/releases': EDITOR,
    })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    await click(q(host, '[data-whatsnew-preview]'))
    const sheet = q(document.body, '[data-whatsnew-waggle]') as HTMLElement
    expect(sheet).toBeTruthy()
    expect(calls(f, 'GET').some(c => c.url === '/api/help/releases/r-draft/slack?variant=0')).toBe(true)
    const ta = q(sheet, '[data-whatsnew-slack-text]') as HTMLTextAreaElement
    expect(ta.value).toBe(PREVIEW.text)
    expect(ta.style.fontSize).toBe('16px')
    expect(sheet.textContent).toContain('Goes to #tech-updates-info')
    expect(q(sheet, '[data-whatsnew-left-out]')!.textContent).toContain('Left out of the post (2)')
    expect(q(sheet, '[data-whatsnew-left-out]')!.textContent).toContain('Prefill Issue')
    expect((q(sheet, '[data-whatsnew-post]') as HTMLElement).textContent).toBe('Post to #tech-updates-info and publish')

    // edit, then post: the edited words are what goes, with publish:true
    const mine = PREVIEW.text.replace('Here is what changed in Bee Hub this week.', 'Three things this week, all from your reports. 🐝')
    await type(ta, mine)
    await click(q(sheet, '[data-whatsnew-post]'))
    expect(calls(f, 'PATCH')).toEqual([{ url: '/api/help/releases/r-draft', body: { publish: true, post_slack: true, slack_text: mine, variant: 0 } }])
    const out = q(sheet, '[data-whatsnew-outcome]') as HTMLElement
    expect(out.getAttribute('data-tone')).toBe('ok')
    expect(out.textContent).toContain('Published to Help and posted to #tech-updates-info.')
    expect(out.textContent).toContain('2 lines still in the owner’s words moved to next week’s draft.')
    expect(q(sheet, '[data-whatsnew-post]')).toBeNull() // no second post
    await unmount()
  })

  it('"Different version" fetches the next variant into the box', async () => {
    const f = stubFetch({
      '/api/help/releases/r-draft/slack': (u: string) => ({ ...PREVIEW, text: u.endsWith('variant=1') ? 'VERSION TWO' : PREVIEW.text, variant: u.endsWith('variant=1') ? 1 : 0 }),
      '/api/help/releases': EDITOR,
    })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    await click(q(host, '[data-whatsnew-preview]'))
    const sheet = q(document.body, '[data-whatsnew-waggle]') as HTMLElement
    await click(q(sheet, '[data-whatsnew-different]'))
    expect(calls(f, 'GET').some(c => c.url === '/api/help/releases/r-draft/slack?variant=1')).toBe(true)
    expect((q(sheet, '[data-whatsnew-slack-text]') as HTMLTextAreaElement).value).toBe('VERSION TWO')
    await unmount()
  })

  it('a Slack failure: the week is published, the sheet says the post didn’t go, and the text is still there to copy', async () => {
    stubFetch({
      '/api/help/releases/r-draft/slack': PREVIEW,
      '/api/help/releases/r-draft': { release: { id: 'r-draft', status: 'published' }, published_count: 1, left_out: 0, carried_to: null, slack: { posted: false, problem: 'The Slack link isn’t set up yet (SLACK_WAGGLE_WEBHOOK_URL is missing in Vercel).', skipped: false } },
      '/api/help/releases': EDITOR,
    })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    await click(q(host, '[data-whatsnew-preview]'))
    const sheet = q(document.body, '[data-whatsnew-waggle]') as HTMLElement
    await click(q(sheet, '[data-whatsnew-post]'))
    const out = q(sheet, '[data-whatsnew-outcome]') as HTMLElement
    expect(out.getAttribute('data-tone')).toBe('bad')
    expect(out.textContent).toContain('Published to Help. The Slack post didn’t go: The Slack link isn’t set up yet')
    expect(out.textContent).toContain('copy it into #tech-updates-info by hand')
    expect((q(sheet, '[data-whatsnew-slack-text]') as HTMLTextAreaElement).value).toBe(PREVIEW.text)
    await unmount()
  })

  it('"Publish to Help only" publishes without posting', async () => {
    const f = stubFetch({
      '/api/help/releases/r-draft/slack': PREVIEW,
      '/api/help/releases/r-draft': { release: { id: 'r-draft', status: 'published' }, published_count: 1, left_out: 0, carried_to: null, slack: { posted: false, problem: null, skipped: true } },
      '/api/help/releases': EDITOR,
    })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    await click(q(host, '[data-whatsnew-preview]'))
    const sheet = q(document.body, '[data-whatsnew-waggle]') as HTMLElement
    await click(q(sheet, '[data-whatsnew-publish-only]'))
    expect(calls(f, 'PATCH')[0].body).toEqual({ publish: true, post_slack: false, slack_text: null, variant: 0 })
    expect(q(sheet, '[data-whatsnew-outcome]')!.textContent).toBe('Published to Help.')
    await unmount()
  })
})
