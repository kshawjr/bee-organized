// @vitest-environment happy-dom
//
// THE NAV SWAP — "What you've told us" is retired; Help is the only door.
//
//   · the old nav item is gone for every role, and no screen() branch mounts
//     the owner screen from BeeHub any more — HelpScreen's My requests tab is
//     its only mount
//   · /?feedback=1 (every reply email already sent, and a bookmark of it)
//     lands on Help, My requests — the legacy redirect, and the shell wiring
//   · the reply email now links to /help?tab=requests, and that address
//     survives the login bounce with its tab intact
//   · an owner's existing items and threads render there unchanged — the same
//     fixture the owner-screen tests use, mounted through HelpScreen
//   · the chat still cannot name a control that does not exist: the three
//     fixed affordances it may name are exactly the three links under it
//   · nothing that was silent before now sends — My requests makes the same
//     two calls the old screen made, and the reply email module sends
//     through the same path with only the link changed
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The reply-email module pulls in the service client and Resend at import;
// neither is exercised here — the same stubs its own tests use.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: async () => ({}) }))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: vi.fn(), sendEmail: vi.fn() }))

import HelpScreen from '@/components/help/HelpScreen'
import AskBeeHubPanel from '@/components/hive/AskBeeHubPanel'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { legacyFeedbackRedirect, HELP_REQUESTS_PATH, NAV_TO_URL, ROUTE_TO_NAV } from '@/components/hive/shared/hubUrl'
import { feedbackReplyLink, FEEDBACK_REPLY_PATH } from '@/lib/feedback-reply-email'
import { hubReturnTo, safeNextPath } from '@/lib/safe-next'
import { loginRedirectTarget } from '@/lib/auth'
import { buildSystem } from '@/lib/help-chat-prompt'

const readSrc = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
const BEEHUB = readSrc('components/BeeHub.jsx')
const PANEL = readSrc('components/hive/AskBeeHubPanel.jsx')
const PROMPT = readSrc('lib/help-chat-prompt.ts')

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const item = (over: any) => ({
  id: 'x', title: 'A report', description: 'Something happened.', type: 'bug',
  status: 'submitted', user_id: 'u1', submitter_name: 'Ankur Patel',
  submitter_email: 'ankur@pb.com', location_id: 'loc-1', location_name: 'Palm Beach',
  created_at: daysAgo(10), updated_at: daysAgo(10),
  admin_response: null, admin_response_at: null, reply_seen_at: null,
  attachments: [], replies: [], is_internal: false, ...over,
})
const teamReply = { id: 'r-team', author_id: 'admin-1', author_role: 'team', body: 'We found the cause and a fix is queued.', created_at: daysAgo(3) }
const ownerReply = { id: 'r-owner', author_id: 'u1', author_role: 'owner', body: 'It happened again this morning.', created_at: daysAgo(1) }

function stubFetch(routes: Record<string, any>) {
  const f = vi.fn(async (url: any) => {
    const u = String(url)
    for (const [prefix, payload] of Object.entries(routes)) {
      if (u.startsWith(prefix)) return { ok: true, status: 200, json: async () => payload } as any
    }
    return { ok: true, status: 200, json: async () => ({}) } as any
  })
  ;(globalThis as any).fetch = f
  return f
}
async function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(node) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const asUser = (id: string, node: React.ReactNode) => (
  <CurrentUserContext.Provider value={{ id, email: 'x@y.com' } as any}>{node}</CurrentUserContext.Provider>
)
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, '', '/') })

// ─── the old door is gone ─────────────────────────────────────────────

describe('the old nav item is gone for every role', () => {
  it('BeeHub no longer lists a feedback nav item, for any role branch', () => {
    // the navItems array is the one place nav entries are declared
    const navBlock = BEEHUB.slice(BEEHUB.indexOf('const navItems = ['), BEEHUB.indexOf('const navItems = [') + 2500)
    expect(navBlock).not.toContain("key:'feedback'")
    expect(navBlock).not.toContain(`label:"What you've told us"`)
    expect(navBlock).toContain("key:'help'")
  })

  it('no screen() branch renders the feedback nav, and BeeHub does not mount the owner screen itself', () => {
    expect(BEEHUB).not.toContain("activeNav==='feedback'")
    expect(BEEHUB).not.toContain('<OwnerFeedbackScreen')
    expect(BEEHUB).not.toContain('import OwnerFeedbackScreen')
    // …HelpScreen is the one mount
    expect(readSrc('components/help/HelpScreen.jsx')).toContain('<OwnerFeedbackScreen')
  })

  it('the nav vocabulary never had a URL for it — so there is no bookmarkable old address to break', () => {
    expect((NAV_TO_URL as any).feedback).toBeUndefined()
    expect((ROUTE_TO_NAV as any).feedback).toBeUndefined()
  })
})

// ─── the legacy deep link ─────────────────────────────────────────────

describe('/?feedback=1 lands on Help, My requests', () => {
  it('legacyFeedbackRedirect maps the old param to the new address and nothing else', () => {
    expect(legacyFeedbackRedirect('?feedback=1')).toBe('/help?tab=requests')
    expect(legacyFeedbackRedirect('?foo=1&feedback=1')).toBe(HELP_REQUESTS_PATH)
    expect(legacyFeedbackRedirect('?foo=1')).toBeNull()
    expect(legacyFeedbackRedirect('')).toBeNull()
    expect(legacyFeedbackRedirect(null as any)).toBeNull()
  })

  it('BeeHub applies it on mount — the old modal-open is gone', () => {
    expect(BEEHUB).toContain('legacyFeedbackRedirect(window.location.search)')
    expect(BEEHUB).toContain("goToHelp('requests')")
    expect(BEEHUB).not.toContain("get('feedback')) setShowFeedback(true)")
    // and the Help mount receives the intent
    expect(BEEHUB).toMatch(/<HelpScreen[\s\S]*?intent=\{helpIntent\}/)
  })

  it('HelpScreen honours the requests intent even when already mounted', async () => {
    stubFetch({ '/api/help/entries': { sections: [], deleted: [], canEdit: false }, '/api/admin/feedback': { items: [] }, '/api/feedback/seen': { marked: 0, supported: true } })
    const consumed = vi.fn()
    const { host, unmount } = await mount(asUser('u1', <HelpScreen role="franchise" franchiseRole="owner" intent="requests" onIntentConsumed={consumed} />))
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('My requests')
    expect(consumed).toHaveBeenCalled()
    await unmount()
  })
})

// ─── the reply email ──────────────────────────────────────────────────

describe('the reply email link opens Help, My requests', () => {
  it('builds the new address, absolute', () => {
    expect(FEEDBACK_REPLY_PATH).toBe('/help?tab=requests')
    expect(feedbackReplyLink({ NEXT_PUBLIC_APP_URL: 'https://hub.example.com/' } as any)).toBe('https://hub.example.com/help?tab=requests')
    expect(feedbackReplyLink({} as any)).toBe('')
  })

  it('the address survives the login bounce with its tab intact', () => {
    const returnTo = hubReturnTo({ initialRoute: 'help', searchParams: { tab: 'requests' } })
    expect(returnTo).toBe('/help?tab=requests')
    expect(loginRedirectTarget(returnTo)).toBe('/auth/login?next=%2Fhelp%3Ftab%3Drequests')
    expect(safeNextPath('/help?tab=requests')).toBe('/help?tab=requests')
    // a route with no query is unchanged
    expect(hubReturnTo({ initialRoute: 'reports' })).toBe('/reports')
    // and the legacy home deep link still bounces the way issue 235 fixed it
    expect(hubReturnTo({ searchParams: { feedback: '1' } })).toBe('/?feedback=1')
  })

  it('the help page hands its searchParams to the shell', () => {
    expect(readSrc('app/help/page.tsx')).toContain('initialSearchParams={searchParams}')
  })
})

// ─── the owner's items, unchanged, at the new address ─────────────────

describe("an owner's existing items and threads render in Help › My requests unchanged", () => {
  it('same route, same thread, same composer offer, no second heading', async () => {
    window.history.replaceState({}, '', '/help?tab=requests')
    const f = stubFetch({
      '/api/help/entries': { sections: [], deleted: [], canEdit: false },
      '/api/feedback/seen': { marked: 1, supported: true },
      '/api/admin/feedback': { items: [item({ admin_response: teamReply.body, admin_response_at: daysAgo(3), replies: [teamReply, ownerReply] })] },
    })
    const { host, unmount } = await mount(asUser('u1', <HelpScreen role="franchise" franchiseRole="owner" onReportSomething={() => {}} />))
    const text = host.textContent || ''
    expect(text).toContain('A report')
    expect(text).toContain('The team replied')
    expect(text).toContain('We found the cause and a fix is queued.')
    expect(text).toContain('You replied')
    expect(text).toContain('It happened again this morning.')
    expect(text.indexOf('We found the cause')).toBeLessThan(text.indexOf('It happened again'))
    expect(text).toContain('Reply to the team')
    expect(text).toContain('Report something')
    // the heading is the tab's, not a second one
    expect(text).not.toContain('What you’ve told us')
    expect(host.querySelectorAll('h1').length).toBe(1)
    // the same two calls the old screen made — the list, and the seen stamp
    const urls = f.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.startsWith('/api/admin/feedback'))).toBe(true)
    expect(urls.some(u => u === '/api/feedback/seen')).toBe(true)
    await unmount()
  })
})

// ─── the chat's licence ───────────────────────────────────────────────

describe('the chat still cannot name a control that does not exist', () => {
  it('the three fixed affordances in the prompt are exactly the three links under the chat', () => {
    const sys = buildSystem({ name: 'Clients', detail: 'Clients · Inbox' })
    // what the prompt permits
    expect(sys).toContain('"Quick Start Guide"')
    expect(sys).toContain('"Manual"')
    expect(sys).toContain('"Ask the team in\nHelp" link')
    expect(sys).not.toContain('Report Bug or')
    // what the footer renders
    expect(PANEL).toContain('Quick Start Guide')
    expect(PANEL).toContain('Manual')
    expect(PANEL).toContain('Ask the team in Help')
    expect(PANEL).not.toContain('Report Bug or Feature')
    // the hard rule still travels
    expect(sys).toContain('NEVER name or describe a button, menu')
    expect(sys).not.toMatch(/suggest where/i)
  })

  it('the footer link is rendered with that exact label, and BeeHub routes it into Help', async () => {
    const onOpenHelpAsk = vi.fn()
    const { host, unmount } = await mount(<AskBeeHubPanel isMobile={false} onClose={() => {}} onOpenGuide={() => {}} onOpenManual={() => {}} onOpenHelpAsk={onOpenHelpAsk} />)
    const link = host.querySelector('[data-ask-help]') as HTMLButtonElement
    expect(link?.textContent?.trim()).toBe('Ask the team in Help')
    expect(host.textContent).toContain('Still stuck?')
    expect(host.textContent).toContain('Prefer a walkthrough?')
    await act(async () => { link.click() })
    expect(onOpenHelpAsk).toHaveBeenCalled()
    expect(BEEHUB).toContain("onOpenHelpAsk={() => { setShowHelpChat(false); goToHelp('ask') }}")
    expect(BEEHUB).not.toContain('onOpenFeedback=')
    await unmount()
  })

  it('the ask intent lands on the Help list with the ask strip, not on My requests', async () => {
    stubFetch({ '/api/help/entries': { sections: [], deleted: [], canEdit: false } })
    const { host, unmount } = await mount(<HelpScreen role="franchise" franchiseRole="owner" intent="ask" onIntentConsumed={() => {}} />)
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Help')
    expect(host.querySelector('[data-help-ask-strip]')).toBeTruthy()
    await unmount()
  })
})

// ─── nothing new sends ────────────────────────────────────────────────

describe('nothing that was silent before now sends', () => {
  it('the reply email module still has one send path and only the link text changed', () => {
    const src = readSrc('lib/feedback-reply-email.ts')
    expect((src.match(/resend|sendEmail|\.emails\.send/g) || []).length).toBeGreaterThan(0)
    expect(src).toContain("FEEDBACK_REPLY_PATH = '/help?tab=requests'")
    expect(src).not.toContain('/?feedback=1`')
  })

  it('the swap added no fetch, no email and no Slack call to the shell or the panel', () => {
    for (const [name, src] of [['BeeHub', BEEHUB], ['panel', PANEL], ['prompt', PROMPT]] as const) {
      const region = name === 'BeeHub' ? BEEHUB.slice(BEEHUB.indexOf('function goToHelp'), BEEHUB.indexOf('function goToHelp') + 900) : src
      expect(region, name).not.toMatch(/\/api\/(slack|notify|email)|resend|sendSlack/)
    }
  })
})
