// @vitest-environment happy-dom
//
// issue 309 — Slack carries news, and a deploy drafts the reply. Step 5 of five.
//
// What is pinned:
//   · the nudge is FOUR LINES and carries nothing per-item — the constraint the
//     whole redesign turns on, after "I don't want it in Slack, that will just
//     be a massive message"
//   · a quiet day posts nothing
//   · each triggered alert fires on its condition AND NOT OTHERWISE
//   · top-level text is a one-line summary; colour lives in an attachment
//   · no interactive action_id is added anywhere — these are links, and the ops
//     webhook has no action handler behind it
//   · a draft HEDGES whenever the link is uncertain, which is the design: erring
//     toward asking costs a sentence, erring toward declaring cost seven weeks
//   · sending goes through the route, never a direct write
//   · no draft carries a hash, a filename or an issue number
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { buildNudge, buildAlert, buildAlerts, CLUSTER_ALERT_AT, UNOPENED_REPLY_DAYS } from '@/lib/feedback-nudge'
import {
  linkCommitToItems, buildReplyDraft, readTrailers, draftLeaksEngineering,
} from '@/lib/feedback-reply-draft'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const URL_ = 'https://hub.example.com/?feedback=1'
const summary = (over: any = {}) => ({
  open: 24, closed: 39, total: 63,
  counts: { new: 15, stale: 5, working: 0, inHand: 4 },
  oldestNewDays: 59, oldestStaleDays: 30, ...over,
})

// ─── PIECE ONE: the nudge ─────────────────────────────────────────────

describe('the weekday nudge is news, not work', () => {
  const n = buildNudge({ summary: summary(), oldestNewDays: 59, triageUrl: URL_ })

  it('is four lines — one top-level plus three in the attachment', () => {
    const lines = n.post!.attachments[0].text.split('\n')
    expect(lines).toHaveLength(3)
    expect(1 + lines.length).toBe(4)
  })

  it('carries counts and the oldest age, and NOTHING per-item', () => {
    const body = n.post!.attachments[0].text
    expect(body).toContain('24 open')
    expect(body).toContain('15 not looked at')
    expect(body).toContain('Oldest untouched: 59 days')
    // The failure mode: one title and it is a list again.
    expect(body).not.toContain('Mario')
    expect(body).not.toMatch(/^\s*[•·]/m)
  })

  it('links to triage rather than carrying the work', () => {
    expect(n.post!.attachments[0].text).toContain(`<${URL_}|Open triage>`)
  })

  // Same posture as the webhook digest: a message that says "no change" every
  // morning trains the reader to ignore it.
  it('a quiet day posts nothing', () => {
    const quiet = buildNudge({ summary: summary({ open: 0, counts: { new: 0, stale: 0, working: 0, inHand: 0 } }), oldestNewDays: null, triageUrl: URL_ })
    expect(quiet.suppressed).toBe(true)
    expect(quiet.post).toBeNull()
  })

  it('says so plainly when nothing is sitting untouched', () => {
    const n2 = buildNudge({ summary: summary(), oldestNewDays: null, triageUrl: URL_ })
    expect(n2.post!.attachments[0].text).toContain('Nothing is sitting untouched.')
  })
})

describe('the transport contract', () => {
  const posts = [
    buildNudge({ summary: summary(), oldestNewDays: 3, triageUrl: URL_ }).post!,
    buildAlert({ kind: 'cluster-formed', probe: 'p', size: 3, what: 'One cause.' }, URL_)!,
    buildAlert({ kind: 'unopened-reply', count: 5, oldestDays: 49 }, URL_)!,
    buildAlert({ kind: 'shipped-with-waiters', waiting: 2, what: 'A change shipped.', uncertain: true }, URL_)!,
  ]

  it('top-level text is a ONE-LINE summary', () => {
    for (const p of posts) {
      expect(p.text).not.toContain('\n')
      expect(p.text.length).toBeLessThan(80)
    }
  })

  it('colour lives in the attachment, never in the text', () => {
    for (const p of posts) {
      expect(p.attachments).toHaveLength(1)
      expect(p.attachments[0].color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(p.attachments[0].fallback.length).toBeGreaterThan(0)
    }
  })

  // Buttons need an action handler in app/api/slack/interactivity, and adding
  // one is a separate decision. The lead card's log_call contract lives on a
  // different rail entirely and must not grow a sibling here.
  it('adds NO interactive action_id anywhere', () => {
    for (const f of ['lib/feedback-nudge.ts', 'lib/slack.ts', 'app/api/cron/feedback-brief/route.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} must not declare an action_id`).not.toContain('action_id')
      expect(src).not.toContain('"type": "button"')
      expect(src).not.toContain("type: 'button'")
    }
  })

  it('leaves the lead card\'s log_call contract untouched', () => {
    const card = readFileSync('lib/slack-bot.ts', 'utf8')
    expect(card).toContain("action_id: 'log_call'")
    expect(card).toContain('value: lead.id')
  })

  // Every pre-309 caller passes text alone and must post the identical body.
  it('omits the attachments key entirely when there are none', () => {
    const src = readFileSync('lib/slack.ts', 'utf8')
    expect(src).toContain('attachments && attachments.length ? { text, attachments } : { text }')
  })
})

describe('each alert fires on its condition and not otherwise', () => {
  it('a cluster alerts on the THIRD report, not the second', () => {
    expect(buildAlert({ kind: 'cluster-formed', probe: 'p', size: 2, what: 'x' }, URL_)).toBeNull()
    const three = buildAlert({ kind: 'cluster-formed', probe: 'p', size: CLUSTER_ALERT_AT, what: 'x' }, URL_)
    expect(three).toBeTruthy()
    expect(three!.attachments[0].text).toContain('3 reports now share one root cause')
  })

  it('a shipped alert needs someone actually waiting', () => {
    expect(buildAlert({ kind: 'shipped-with-waiters', waiting: 0, what: 'x', uncertain: false }, URL_)).toBeNull()
    const one = buildAlert({ kind: 'shipped-with-waiters', waiting: 1, what: 'x', uncertain: false }, URL_)!
    expect(one.attachments[0].text).toContain('addresses 1 open report')
  })

  it('a shipped alert says MAY when the link is uncertain', () => {
    const u = buildAlert({ kind: 'shipped-with-waiters', waiting: 2, what: 'x', uncertain: true }, URL_)!
    expect(u.attachments[0].text).toContain('MAY address 2 open reports')
    expect(u.attachments[0].text).toContain('The link is not certain')
  })

  it('an unopened-reply alert waits for the threshold', () => {
    expect(buildAlert({ kind: 'unopened-reply', count: 3, oldestDays: UNOPENED_REPLY_DAYS - 1 }, URL_)).toBeNull()
    expect(buildAlert({ kind: 'unopened-reply', count: 0, oldestDays: 90 }, URL_)).toBeNull()
    const fire = buildAlert({ kind: 'unopened-reply', count: 5, oldestDays: 49 }, URL_)!
    expect(fire.attachments[0].text).toContain('never been opened')
  })

  it('no events means no posts', () => {
    expect(buildAlerts([], URL_)).toEqual([])
    expect(buildAlerts([{ kind: 'cluster-formed', probe: 'p', size: 2, what: 'x' }], URL_)).toEqual([])
  })
})

// ─── PIECE TWO: the link and the draft ────────────────────────────────

const MARIO = { id: '8ea772a4-a6c9-4178-a632-7d688470d30d', title: 'Problem with Office Organization', description: 'Mario is closed out and paid.' }
const EMAIL_CUT = { id: '91561149-cdd7-4376-9736-e77677ad0bc3', title: 'Email cut off', description: "Email address is cut off if it's too long" }
const ITEMS = [MARIO, EMAIL_CUT]

const CONFIDENT_ANALYSIS: any = { itemId: MARIO.id, probe: 'stuck-final-processing', confidence: 'confident', what: 'x', files: [], fleet: null, size: null, question: null, placement: null }

describe('how a commit links to an item', () => {
  it('reads an explicit Feedback-Item trailer', () => {
    expect(readTrailers(`fix: a thing\n\nFeedback-Item: ${MARIO.id}`)).toEqual([MARIO.id])
    expect(readTrailers('fix: a thing')).toEqual([])
  })

  it('a trailer link is reliable; word overlap never is', () => {
    const viaTrailer = linkCommitToItems({ message: `fix: whatever\n\nFeedback-Item: ${MARIO.id}` }, ITEMS)
    expect(viaTrailer).toHaveLength(1)
    expect(viaTrailer[0]).toMatchObject({ itemId: MARIO.id, kind: 'trailer', reliable: true })

    const viaWords = linkCommitToItems({ message: 'fix(hive): email address cut off when too long' }, ITEMS)
    const hit = viaWords.find(l => l.itemId === EMAIL_CUT.id)!
    expect(hit).toBeTruthy()
    expect(hit.reliable).toBe(false)
    expect(hit.kind).toBe('word-overlap')
  })

  it('needs more than one shared distinctive word', () => {
    // "email" alone is one token, and one is not evidence.
    expect(linkCommitToItems({ message: 'chore: bump email dependency' }, ITEMS)
      .some(l => l.itemId === EMAIL_CUT.id)).toBe(false)
  })

  it('links nothing when the commit is unrelated — the ordinary case', () => {
    expect(linkCommitToItems({ message: 'chore(deps): bump stripe to 22.4.0' }, ITEMS)).toEqual([])
  })
})

describe('the draft hedges unless it is certain', () => {
  const reliable = { itemId: MARIO.id, kind: 'trailer' as const, reliable: true }
  const unreliable = { itemId: EMAIL_CUT.id, kind: 'word-overlap' as const, reliable: false, matched: ['email', 'cut'] }

  it('declares only with a reliable link AND a confident diagnosis', () => {
    const d = buildReplyDraft({ item: MARIO, link: reliable, analysis: CONFIDENT_ANALYSIS, whatChanged: 'Deals that were stuck can now be closed.' })
    expect(d.shape).toBe('confident')
    expect(d.text).toContain("it's now fixed")
  })

  it('hedges when the link is only word overlap', () => {
    const d = buildReplyDraft({ item: EMAIL_CUT, link: unreliable, analysis: CONFIDENT_ANALYSIS, whatChanged: 'Long email addresses now show in full on hover.' })
    expect(d.shape).toBe('hedged')
    expect(d.text).toContain('may cover')
    expect(d.text).toContain('tell us whether')
    expect(d.text).not.toContain('now fixed')
  })

  // The "Email cut off" case exactly: a reliable link, but nobody diagnosed the
  // report, so the change may not be what the owner meant.
  it('hedges when the link is reliable but the cause was never diagnosed', () => {
    const d = buildReplyDraft({ item: EMAIL_CUT, link: { ...reliable, itemId: EMAIL_CUT.id }, analysis: null, whatChanged: 'A tooltip now shows the full address.' })
    expect(d.shape).toBe('hedged')
    expect(d.because).toContain('never diagnosed')
  })

  it('hedges when there is no analysis and no reliable link', () => {
    expect(buildReplyDraft({ item: EMAIL_CUT, link: unreliable, analysis: null }).shape).toBe('hedged')
  })

  it('is three sentences of plain language', () => {
    for (const d of [
      buildReplyDraft({ item: MARIO, link: reliable, analysis: CONFIDENT_ANALYSIS, whatChanged: 'Stuck deals can be closed again.' }),
      buildReplyDraft({ item: EMAIL_CUT, link: unreliable, analysis: null }),
    ]) {
      expect(d.text.split(/(?<=[.?])\s+/).filter(Boolean).length).toBeLessThanOrEqual(4)
      expect(d.text.length).toBeLessThan(400)
    }
  })
})

describe('a draft never leaks engineering vocabulary', () => {
  const drafts = [
    buildReplyDraft({ item: MARIO, link: { itemId: MARIO.id, kind: 'trailer', reliable: true }, analysis: CONFIDENT_ANALYSIS, whatChanged: 'Stuck deals can be closed again.' }),
    buildReplyDraft({ item: EMAIL_CUT, link: { itemId: EMAIL_CUT.id, kind: 'word-overlap', reliable: false }, analysis: null }),
  ]

  it('contains no hash, filename or issue number', () => {
    for (const d of drafts) expect(draftLeaksEngineering(d.text)).toBeNull()
  })

  it('the guard actually catches each kind', () => {
    expect(draftLeaksEngineering('We changed lib/engagements.ts today.')).toBe('filename')
    expect(draftLeaksEngineering('Fixed in issue 307.')).toBe('issue reference')
    expect(draftLeaksEngineering('Shipped as 3d0cbaf today.')).toBe('commit hash')
    expect(draftLeaksEngineering('Your report is fixed, thank you.')).toBeNull()
  })
})

// ─── The send path ────────────────────────────────────────────────────

const ROWS = [
  { ...MARIO, id: MARIO.id, type: 'bug', status: 'submitted', user_id: 'u2', submitter_name: 'Amy', submitter_email: 'amy@oo.com', location_id: 'l1', location_name: 'OO', created_at: new Date(Date.now() - 3 * 86400000).toISOString(), updated_at: new Date().toISOString(), attachments: [] },
]
const DRAFT = { itemId: MARIO.id, shape: 'hedged', text: 'Thanks for reporting this. We have made a change that may cover it. Could you take a look and tell us whether it is sorted?', because: 'matched by wording alone' }

const WRITES: Array<{ url: string; method: string; body: any }> = []
const stubFetch = () => {
  WRITES.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/api/admin/feedback/analysis')) {
      return { ok: true, status: 200, json: async () => ({ analyses: [], clusters: [], drafts: [DRAFT] }) }
    }
    if (init?.method && init.method !== 'GET') {
      WRITES.push({ url: u, method: init.method, body: init.body ? JSON.parse(init.body) : null })
      return { ok: true, status: 200, json: async () => ({ ...ROWS[0], reply_email: { sent: true, to: 'amy@oo.com', kind: 'reply' } }) }
    }
    return { ok: true, status: 200, json: async () => ({ items: ROWS }) }
  }))
}
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {}); await act(async () => {})
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const screenFor = (props: any = {}) => mount(
  <CurrentUserContext.Provider value={{ id: 'u1', email: 'kevin@bmave.com' } as any}>
    <AdminFeedbackScreen onOpenCountChange={() => {}} {...props} />
  </CurrentUserContext.Provider>,
)
const btn = (host: Element, prefix: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith(prefix))

beforeEach(() => { document.body.innerHTML = ''; stubFetch() })
afterEach(() => { vi.unstubAllGlobals() })

// The queues redesign moved the draft button off the row and into the modal's
// corporate-only block; the reply box it fills is in the same modal.
const openMario = (host: Element) => click(btn(host, MARIO.title)!)

describe('a draft reaches the owner only through the route', () => {
  it('shows the draft affordance, labelled with its shape, inside the item', async () => {
    const { host, unmount } = await screenFor()
    expect(btn(host, 'Draft reply')).toBeUndefined() // nothing corporate on the list
    await openMario(host)
    expect(btn(host, 'Draft reply — may be fixed, asks them')).toBeTruthy()
    await unmount()
  })

  it('fills the reply box with the draft', async () => {
    const { host, unmount } = await screenFor()
    await openMario(host)
    await click(btn(host, 'Draft reply')!)
    const area = [...host.querySelectorAll('textarea')].find(t => (t as HTMLTextAreaElement).value.includes('Thanks for reporting this'))
    expect(area, 'composer not seeded with the draft').toBeTruthy()
    await unmount()
  })

  // Tonight five replies were written by direct SQL and NOBODY was notified:
  // the email fires from the route on save, not from the database.
  it('saving PATCHes the route — the only thing that sends an email', async () => {
    const { host, unmount } = await screenFor()
    await openMario(host)
    await click(btn(host, 'Draft reply')!)
    const save = [...host.querySelectorAll('button')].find(b => /^Save/.test((b.textContent || '').trim()))
    expect(save, 'no Save button in the composer').toBeTruthy()
    await click(save!)
    expect(WRITES).toHaveLength(1)
    expect(WRITES[0].method).toBe('PATCH')
    expect(WRITES[0].url).toBe(`/api/admin/feedback/${MARIO.id}`)
    expect(WRITES[0].body.admin_response).toContain('Thanks for reporting this')
    await unmount()
  })

  it('nothing sends without that press — the draft alone writes nothing', async () => {
    const { host, unmount } = await screenFor()
    await openMario(host)
    await click(btn(host, 'Draft reply')!)
    expect(WRITES).toEqual([])
    await unmount()
  })
})

// ─── The brief is retired from Slack, not deleted ─────────────────────

describe('the long brief no longer posts, but nothing was deleted', () => {
  const cron = readFileSync('app/api/cron/feedback-brief/route.ts', 'utf8')

  it('posts the nudge, not brief.text', () => {
    expect(cron).toContain('buildNudge')
    expect(cron).toContain('postSlackMessage(nudge.post.text, nudge.post.attachments)')
    expect(cron).not.toContain('postSlackMessage(brief.text)')
  })

  it('still builds the brief — issue 307 depends on what is underneath it', () => {
    expect(cron).toContain('buildFeedbackBrief')
    expect(() => readFileSync('lib/feedback-brief.ts', 'utf8')).not.toThrow()
    expect(() => readFileSync('lib/feedback-placement.ts', 'utf8')).not.toThrow()
  })

  it('runs on weekday mornings only', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'))
    const cronEntry = vercel.crons.find((c: any) => c.path === '/api/cron/feedback-brief')
    expect(cronEntry.schedule).toBe('0 11 * * 1-5')
  })
})
