// @vitest-environment happy-dom
//
// issue 308 — the copy-prompt button. Step 4 of five.
//
// The prompt text is the product here, so most of these read it rather than
// the DOM. The fixtures are the two real open items used to judge the output
// by eye before any of this was wired up: "Mario is closed out and paid"
// (probed, full tier) and "Email cut off" (no probe, short tier).
//
// What is pinned:
//   · the full tier carries the mechanism AND the instruction to verify it
//     rather than trust it — a generated prompt that asserted its own
//     diagnosis as fact would be worse than no button at all
//   · the short tier says the cause is NOT established, and is not padded out
//     to resemble the full one
//   · the owner's words appear VERBATIM, never paraphrased or truncated
//   · NO generated prompt contains a commit hash — it may sit on a clipboard
//     for a week, and a stale hash reads as a fact
//   · the clipboard failure path reveals selectable text rather than failing
//     silently
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { buildCopyPrompt, promptTierFor } from '@/lib/feedback-prompt'
import { analyseItem } from '@/lib/feedback-analysis'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-08-15T23:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString()

// ─── The two real items ───────────────────────────────────────────────

const MARIO = {
  id: 'mario', type: 'bug', title: 'Problem with Office Organization',
  description: 'Mario is closed out and paid.',
  status: 'submitted', created_at: daysAgo(3),
  submitter_name: 'Amy Kerr', location_name: 'Office Organization',
  context: { kind: 'engagement', stage: 'Final Processing', path: '/clients/d2bb1d4a?e=9eff1478' },
  context_client_name: 'Mario Rossi', attachments: [],
}
const MARIO_ANALYSIS = analyseItem({
  item: MARIO as any, index: null,
  evidence: {
    engagement: { id: 'e', stage: 'Final Processing', jobCount: 1, archivedJobCount: 1, quoteCount: 0, invoiceCount: 0, paidInvoiceCount: 0 },
    fleet: { 'stuck-final-processing': { count: 106, unit: 'engagements', basis: 'at Final Processing, with an archived job, and no fully-paid invoice to unlock Mark won' } },
  },
})

const EMAIL_CUT = {
  id: 'emailcut', type: 'bug', title: 'Email cut off',
  description: "Email address is cut off if it's too long",
  status: 'under_review', created_at: daysAgo(59),
  submitter_name: 'Lynette Ewy', location_name: 'Kansas City', attachments: [],
}
const EMAIL_CUT_ANALYSIS = analyseItem({ item: EMAIL_CUT as any, evidence: {}, index: null })

const fullText = buildCopyPrompt({ item: MARIO as any, analysis: MARIO_ANALYSIS, now: NOW })
const shortText = buildCopyPrompt({ item: EMAIL_CUT as any, analysis: EMAIL_CUT_ANALYSIS, now: NOW })

// ─── Tiers ────────────────────────────────────────────────────────────

describe('two tiers, chosen by whether a probe fired', () => {
  it('a probed item gets the full tier, an unprobed one the short tier', () => {
    expect(promptTierFor(MARIO_ANALYSIS)).toBe('full')
    expect(promptTierFor(EMAIL_CUT_ANALYSIS)).toBe('short')
    expect(promptTierFor(null)).toBe('short')
    expect(fullText.tier).toBe('full')
    expect(shortText.tier).toBe('short')
  })

  // Padding the short tier until it LOOKS like the full one is the exact
  // failure this step must avoid: length would then signal confidence that
  // does not exist.
  it('the short tier is materially shorter — length is an honest signal', () => {
    expect(shortText.text.length).toBeLessThan(fullText.text.length * 0.75)
  })
})

// ─── The full tier ────────────────────────────────────────────────────

describe('the full prompt carries the diagnosis AND its caveat', () => {
  it('states the traced mechanism', () => {
    expect(fullText.text).toContain('Final Processing')
    expect(fullText.text).toContain('jobUnbooked')
    expect(fullText.text).toContain('canCloseWon')
  })

  // THE SENTENCE THAT MATTERS. Without it the prompt hands a hypothesis over
  // as a fact, and roughly twenty premises in this project have been asserted
  // and then falsified by checking production.
  it('frames the diagnosis as something to VERIFY, in those words', () => {
    expect(fullText.text).toContain('HYPOTHESIS TO VERIFY')
    expect(fullText.text).toContain('VERIFY THIS BEFORE YOU BUILD ANYTHING ON IT')
    expect(fullText.text).toContain('probes have been wrong')
    expect(fullText.text.toLowerCase()).toContain('if it is wrong, say so')
  })

  it('carries the fleet count with its basis, and tells the reader to re-run it', () => {
    expect(fullText.text).toContain('106 engagements')
    expect(fullText.text).toContain('basis:')
    expect(fullText.text).toContain('Re-run this count yourself')
  })

  it('names the files as starting points rather than conclusions', () => {
    expect(fullText.text).toContain('lib/engagements.ts:105')
    expect(fullText.text).toContain('starting points, not conclusions')
  })

  it('gives a size, never an hours figure', () => {
    expect(fullText.text).toContain('ROUGH SIZE:')
    expect(fullText.text).not.toMatch(/\b\d+\s*(hours?|hrs?|days? of work)\b/i)
  })

  it('says what NOT to do, including stopping before a migration', () => {
    expect(fullText.text).toContain('SCOPE — what NOT to do')
    expect(fullText.text).toContain('STOP and say so rather than writing a migration')
  })

  it('mentions the related reports when the item is in a cluster', () => {
    const withCluster = buildCopyPrompt({
      item: MARIO as any, analysis: MARIO_ANALYSIS, now: NOW,
      cluster: { probe: 'stuck-final-processing', itemIds: ['mario', 'other'], what: 'x', fleet: null },
    })
    expect(withCluster.text).toContain('2 items were grouped under this same root cause')
    expect(withCluster.text).toContain('do')
    // Absent when there is no cluster, rather than an empty heading.
    expect(fullText.text).not.toContain('RELATED REPORTS')
  })
})

// ─── The short tier ───────────────────────────────────────────────────

describe('the short prompt admits the cause is unknown', () => {
  it('says so explicitly', () => {
    expect(shortText.text).toContain('THE CAUSE IS NOT ESTABLISHED. START BY FINDING IT.')
    expect(shortText.text).toContain('No diagnosis exists for this report')
  })

  it('asks for the diagnosis as the deliverable, not a fix', () => {
    expect(shortText.text).toContain('the first deliverable is the diagnosis, not a fix')
    expect(shortText.text).toContain('Do not build a fix on an unverified theory')
  })

  // A missing diagnosis is a fact about our analysis, not a judgement on the
  // owner's report — the prompt has to say which, or the reader discounts it.
  it('does not blame the report for being unplaceable', () => {
    expect(shortText.text).toContain('a statement about the analysis, not evidence that the report is')
  })

  it('carries none of the full tier\'s diagnosis furniture', () => {
    expect(shortText.text).not.toContain('HYPOTHESIS TO VERIFY')
    expect(shortText.text).not.toContain('FLEET IMPACT')
    expect(shortText.text).not.toContain('ROUGH SIZE')
    expect(shortText.text).not.toContain('WHERE TO LOOK')
  })
})

// ─── Shared guarantees ────────────────────────────────────────────────

describe('the owner\'s words are verbatim', () => {
  it('quotes the description exactly, in both tiers', () => {
    expect(fullText.text).toContain('Mario is closed out and paid.')
    expect(shortText.text).toContain("Email address is cut off if it's too long")
  })

  it('keeps the apostrophe and the original casing — no cleanup', () => {
    // A "smart quote" rewrite or a capitalisation fix would both be paraphrase.
    expect(shortText.text).toContain("it's")
    expect(shortText.text).not.toContain('it’s')
  })

  it('does not truncate a long description', () => {
    const long = 'A'.repeat(600) + ' END-OF-REPORT-MARKER'
    const p = buildCopyPrompt({ item: { ...EMAIL_CUT, description: long } as any, analysis: null, now: NOW })
    expect(p.text).toContain('END-OF-REPORT-MARKER')
    expect(p.text).not.toContain('...')
  })

  it('says the words are the primary evidence and warns against paraphrase', () => {
    for (const t of [fullText.text, shortText.text]) {
      expect(t).toContain('verbatim')
      expect(t).toContain('do not work from a')
    }
  })
})

describe('nothing in a generated prompt goes stale', () => {
  // A hash quoted here may be a week old by the time it is pasted. The briefs
  // that worked could name one because a human wrote them at the moment it was
  // true; generated text has no such moment.
  it('contains no commit hash, in either tier', () => {
    const hashLike = /\b[0-9a-f]{7,40}\b/
    for (const t of [fullText.text, shortText.text]) {
      const hit = t.split(/\s+/).find(w => hashLike.test(w.replace(/[^0-9a-f]/gi, '')) && /^[0-9a-f]{7,40}$/.test(w))
      expect(hit, `unexpected hash-like token: ${hit}`).toBeUndefined()
    }
  })

  it('tells the reader to verify the tip instead', () => {
    for (const t of [fullText.text, shortText.text]) {
      expect(t).toContain('verify the tip yourself')
      expect(t).toContain('names NO commit hash')
    }
  })

  // Same staleness argument as the hash: the count would be wrong by morning.
  it('asks for the test baseline to be measured, never quoting one', () => {
    for (const t of [fullText.text, shortText.text]) {
      expect(t).toContain('Run the suite BEFORE changing anything')
      expect(t).not.toMatch(/\b4\d{3} (tests|passed)\b/)
    }
  })

  it('carries the standing environment notes, which do not go stale', () => {
    for (const t of [fullText.text, shortText.text]) {
      expect(t).toContain('.env.local EXISTS')
      expect(t).toContain('OWN node_modules')
      expect(t).toContain('UNPIPED')
      expect(t).toContain('.jsx is NOT type-checked')
    }
  })

  it('ends by asking which premise is wrong', () => {
    for (const t of [fullText.text, shortText.text]) {
      expect(t).toContain('Assume a premise in this prompt is wrong and say which.')
    }
  })
})

// ─── Mounted: the button and its failure path ─────────────────────────

const ROWS = [MARIO, EMAIL_CUT]
const ANALYSES = [
  { ...MARIO_ANALYSIS, itemId: 'mario' },
  { ...EMAIL_CUT_ANALYSIS, itemId: 'emailcut' },
]

const stubFetch = () => {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/api/admin/feedback/analysis')) {
      return { ok: true, status: 200, json: async () => ({ analyses: ANALYSES, clusters: [] }) }
    }
    if (init?.method === 'PATCH') return { ok: true, status: 200, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ items: ROWS }) }
  }))
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {})
  await act(async () => {})
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const screenFor = (props: any = {}) =>
  mount(
    <CurrentUserContext.Provider value={{ id: 'u1', email: 'kevin@bmave.com' } as any}>
      <AdminFeedbackScreen onOpenCountChange={() => {}} {...props} />
    </CurrentUserContext.Provider>,
  )
const copyButtons = (host: Element) =>
  [...host.querySelectorAll('button')].filter(b => (b.textContent || '').trim().startsWith('Copy prompt'))
// Target by ROW, not by index: the list is in the issue-306 work order (bugs
// oldest first), so "Email cut off" at 59 days precedes Mario at 3, and a
// positional index would silently test the wrong row. Walking UP from a button
// is no good either — every row shares the list container — so this picks the
// SMALLEST element that contains both the marker and a copy button, which is
// the row itself.
const copyButtonIn = (host: Element, marker: string) => {
  const candidates = [...host.querySelectorAll('*')].filter(el => {
    const t = el.textContent || ''
    if (!t.includes(marker)) return false
    return [...el.querySelectorAll('button')].some(b => (b.textContent || '').trim().startsWith('Copy prompt'))
  })
  if (candidates.length === 0) throw new Error(`no row containing "${marker}" has a Copy prompt button`)
  const row = candidates.reduce((a, b) => ((a.textContent || '').length <= (b.textContent || '').length ? a : b))
  return [...row.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith('Copy prompt'))!
}

beforeEach(() => { document.body.innerHTML = ''; stubFetch() })
afterEach(() => { vi.unstubAllGlobals() })

describe('the button', () => {
  it('says which tier a row will produce, BEFORE the click', async () => {
    const { host, unmount } = await screenFor()
    const t = host.textContent || ''
    expect(t).toContain('full — carries the diagnosis')
    expect(t).toContain('short — cause not established')
    await unmount()
  })

  it('writes the prompt to the clipboard on click', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { host, unmount } = await screenFor()
    await click(copyButtonIn(host, 'Mario is closed out and paid.'))
    expect(writeText).toHaveBeenCalledTimes(1)
    const written = writeText.mock.calls[0][0] as unknown as string
    expect(written).toContain('Mario is closed out and paid.')
    expect(written).toContain('HYPOTHESIS TO VERIFY')
    expect(host.textContent).toContain('Copied')
    await unmount()
  })

  // A copy button that fails quietly is worse than a text box: the reader
  // pastes whatever was on the clipboard already and finds out minutes later.
  it('reveals selectable text when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const { host, unmount } = await screenFor()
    await click(copyButtonIn(host, 'Mario is closed out and paid.'))
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    expect(area, 'no fallback textarea rendered').toBeTruthy()
    expect(area.value).toContain('Mario is closed out and paid.')
    expect(host.textContent).toContain('Couldn’t reach the clipboard')
    await unmount()
  })

  it('falls back the same way when writeText rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('denied by policy') }) },
      configurable: true,
    })
    const { host, unmount } = await screenFor()
    await click(copyButtonIn(host, 'Mario is closed out and paid.'))
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    expect(area).toBeTruthy()
    expect(area.value).toContain('Mario is closed out and paid.')
    await unmount()
  })

  it('is absent on the franchise mount', async () => {
    const { host, unmount } = await screenFor({ onReportFeedback: () => {} })
    expect(copyButtons(host)).toHaveLength(0)
    await unmount()
  })
})
