// @vitest-environment node
//
// How a placement should be PRINTED — issue 248 step 3, salvaged.
//
// The matcher (placeFeedbackItem) says 'confident' | 'possible' | 'none'.
// That is a statement about score margins. placementRender answers a different
// question — does the evidence under this shortlist support showing it to a
// reader at all — and it was written against Kevin's own verdict on the step-2
// brief: `clients, client` is noise, `guide` is real, and "Quo" should never
// have been placed. Three printed states:
//
//   placed    a distinctive word, corroborated — by a second matched word or by
//             the runner-up arriving on the same word
//   weak      rests only on common words (peak below DISTINCTIVE_MIN); show it,
//             but show the words with it
//   unplaced  nothing to print — including a LONE 'possible' candidate, which
//             is how "Thumbtack Integration → the notes box (matched: feed)"
//             was printed once and must not be again
//
// The consumer today is the copy-prompt (issue 308): an 'unplaced' shortlist
// no longer appears under WHICH SCREEN, PROBABLY, because a coincidence in a
// generated prompt becomes the first file the next session opens.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildPlacementIndex, placeFeedbackItem, placementRender, DISTINCTIVE_MIN,
  type ScreenMapEntry, type Placement, type PlacementCandidate,
} from '@/lib/feedback-placement'
import { buildCopyPrompt } from '@/lib/feedback-prompt'
import type { ItemAnalysis } from '@/lib/feedback-analysis'

const cand = (o: Partial<PlacementCandidate> & { matched: string[]; peak: number }): PlacementCandidate => ({
  id: o.id ?? 'x.y',
  surface: o.surface ?? 'Some surface',
  file: o.file ?? 'components/Some.jsx',
  lines: o.lines,
  score: o.score ?? 5,
  ...o,
})

// ─── The pure rule, state by state ────────────────────────────────────

describe('placementRender — unplaced', () => {
  it("'none' is unplaced, and so is an empty candidate list whatever the label says", () => {
    expect(placementRender({ confidence: 'none', candidates: [] })).toBe('unplaced')
    expect(placementRender({ confidence: 'possible', candidates: [] })).toBe('unplaced')
  })

  it('a LONE possible candidate is unplaced, even on a distinctive word (the Thumbtack case)', () => {
    // "feed" is in exactly one map entry — the activity feed — and scores 4.09.
    // It matched "leads feed directly into Jobber". A verb collided with a noun,
    // and no weight separates them; only the absence of corroboration does.
    const p: Placement = {
      confidence: 'possible',
      candidates: [cand({ id: 'record.notes', surface: 'the notes box', matched: ['feed'], peak: 4.09 })],
    }
    expect(placementRender(p)).toBe('unplaced')
  })

  it('two distinctive single-word candidates that AGREE ON NOTHING are unplaced (the Quo case)', () => {
    const p: Placement = {
      confidence: 'possible',
      candidates: [
        cand({ id: 'home.follow-ups', matched: ['set'], peak: 3.4 }),
        cand({ id: 'record.notes', matched: ['client', 'feed'], peak: 4.09 }),
      ],
    }
    expect(placementRender(p)).toBe('unplaced')
  })
})

describe('placementRender — weak', () => {
  it('a shortlist resting only on common words is weak, not unplaced and not placed (the Nuturing case)', () => {
    // "client" is in 19 of 120 entries — weight 1.79. It does not locate
    // anything; it reports that the word appears everywhere. Two candidates
    // pulled in by it is still worth showing, WITH the words, so the reader can
    // judge the evidence rather than the conclusion.
    const p: Placement = {
      confidence: 'possible',
      candidates: [
        cand({ id: 'a', matched: ['clients', 'client'], peak: 1.79 }),
        cand({ id: 'b', matched: ['client'], peak: 1.79 }),
      ],
    }
    expect(placementRender(p)).toBe('weak')
  })

  it('weak is decided by the TOP candidate\'s peak, below DISTINCTIVE_MIN', () => {
    const p: Placement = {
      confidence: 'possible',
      candidates: [
        cand({ id: 'a', matched: ['email', 'list'], peak: DISTINCTIVE_MIN - 0.01 }),
        cand({ id: 'b', matched: ['email'], peak: 2.0 }),
      ],
    }
    expect(placementRender(p)).toBe('weak')
  })
})

describe('placementRender — placed', () => {
  it("a 'confident' placement is placed — it already dominated the field 2:1 and was corroborated", () => {
    const p: Placement = {
      confidence: 'confident',
      candidates: [cand({ id: 'clients.inbox', matched: ['inbox', 'assessment'], peak: 3.9 })],
    }
    expect(placementRender(p)).toBe('placed')
  })

  it('a distinctive word corroborated by a SECOND matched word is placed', () => {
    const p: Placement = {
      confidence: 'possible',
      candidates: [
        cand({ id: 'a', matched: ['kanban', 'column'], peak: 4.08 }),
        cand({ id: 'b', matched: ['column'], peak: 2.5 }),
      ],
    }
    expect(placementRender(p)).toBe('placed')
  })

  it('a distinctive single word that the RUNNER-UP also arrived on is placed (the Guide case)', () => {
    // shell.guide (guide) + admin.content (guide): when two different surfaces
    // are pulled in by the same word, that word is doing real work.
    const p: Placement = {
      confidence: 'possible',
      candidates: [
        cand({ id: 'shell.guide', matched: ['guide'], peak: 3.4 }),
        cand({ id: 'admin.content', matched: ['guide'], peak: 3.4 }),
      ],
    }
    expect(placementRender(p)).toBe('placed')
  })

  it('peak exactly at DISTINCTIVE_MIN counts as distinctive (the boundary is strict-less-than)', () => {
    const p: Placement = {
      confidence: 'possible',
      candidates: [
        cand({ id: 'a', matched: ['notifications', 'bell'], peak: DISTINCTIVE_MIN }),
        cand({ id: 'b', matched: ['bell'], peak: 2.0 }),
      ],
    }
    expect(placementRender(p)).toBe('placed')
  })
})

// ─── Against the real matcher and the real map ────────────────────────

describe('placementRender over the real matcher', () => {
  const map = JSON.parse(readFileSync('docs/screen-map.json', 'utf8')) as { entries: ScreenMapEntry[] }
  const index = buildPlacementIndex(map.entries)

  it('every candidate the matcher returns carries a finite positive peak', () => {
    const p = placeFeedbackItem({
      title: 'Additional Address',
      description:
        'I would like to add an additional/new address for an existing client, and I do not see ' +
        'an option to add a new address for her. She is moving soon.',
    }, index)
    expect(p.candidates.length).toBeGreaterThan(0)
    for (const c of p.candidates) {
      expect(Number.isFinite(c.peak)).toBe(true)
      expect(c.peak).toBeGreaterThan(0)
      // peak is the weight of the rarest matched word, so it can never exceed
      // the whole accumulated score.
      expect(c.peak).toBeLessThanOrEqual(c.score + 1e-9)
    }
  })

  it('a description that places nothing renders unplaced; a rich one that the matcher places renders placed', () => {
    const nothing = placeFeedbackItem({ title: 'hello', description: 'hmm ok thanks' }, index)
    expect(placementRender(nothing)).toBe('unplaced')

    const rich = placeFeedbackItem({
      title: 'Problem with Engagement – Aug 2026',
      description:
        "This file went to the main hive, was put into my book, but it's showing up in the " +
        'assessment/request column in the engagement tab. This should be in the inbox (new) tab',
    }, index)
    expect(rich.candidates.map(c => c.id)).toContain('clients.inbox')
    expect(placementRender(rich)).toBe('placed')
  })

  it('the rule is total — every real placement lands in exactly one of the three states', () => {
    const samples = [
      'Returning client - request showing as Engagement not New',
      'Client was pushed an appreciation email that I never created',
      'Mario is closed out and paid.',
      'leads feed directly into Jobber from Thumbtack',
      'I want a guide for new owners',
      'the nurturing clients list is wrong',
    ]
    for (const description of samples) {
      const p = placeFeedbackItem({ title: 'x', description }, index)
      const r = placementRender(p)
      expect(['placed', 'weak', 'unplaced']).toContain(r)
      if (p.confidence === 'none') expect(r).toBe('unplaced')
      if (p.confidence === 'confident') expect(r).toBe('placed')
      if (p.confidence === 'possible' && p.candidates.length === 1) expect(r).toBe('unplaced')
    }
  })
})

// ─── Wired into the copy-prompt (issue 308) ───────────────────────────

const NOW = Date.parse('2026-08-15T23:00:00Z')
const ITEM = {
  id: 'thumbtack', type: 'feature', title: 'Thumbtack Integration',
  description: 'leads feed directly into Jobber from Thumbtack',
  status: 'submitted', created_at: new Date(NOW - 5 * 86400000).toISOString(),
  submitter_name: 'Amy Kerr', location_name: 'Office Organization', attachments: [],
}
const analysisWith = (placement: Placement | null): ItemAnalysis => ({
  itemId: ITEM.id, probe: null, confidence: 'none', what: '', files: [], fleet: null, size: null,
  question: 'Not enough to place — needs a follow-up question to the owner.', placement,
})

describe('the copy-prompt drops an unplaced shortlist and labels a weak one', () => {
  it('a lone single-word "possible" candidate no longer appears under WHICH SCREEN, PROBABLY', () => {
    const lone: Placement = {
      confidence: 'possible',
      candidates: [cand({ id: 'record.notes', surface: 'the notes box', file: 'components/hive/NotesBox.jsx', matched: ['feed'], peak: 4.09 })],
    }
    const text = buildCopyPrompt({ item: ITEM as any, analysis: analysisWith(lone), now: NOW }).text
    expect(text).not.toContain('WHICH SCREEN, PROBABLY')
    expect(text).not.toContain('the notes box')
    expect(text).not.toContain('NotesBox.jsx')
  })

  it('a placed shortlist still prints, candidates and matched words intact', () => {
    const placed: Placement = {
      confidence: 'possible',
      candidates: [
        cand({ id: 'shell.guide', surface: 'the owner guide', file: 'components/Guide.jsx', lines: [10, 40], matched: ['guide'], peak: 3.4 }),
        cand({ id: 'admin.content', surface: 'admin content', file: 'components/admin/Content.jsx', matched: ['guide'], peak: 3.4 }),
      ],
    }
    const text = buildCopyPrompt({ item: ITEM as any, analysis: analysisWith(placed), now: NOW }).text
    expect(text).toContain('WHICH SCREEN, PROBABLY (2 candidates, not certain which)')
    expect(text).toContain('components/Guide.jsx:10')
    expect(text).toContain("matched on the owner's words: guide")
    expect(text).not.toContain('WEAK')
  })

  it('a weak shortlist prints, and the heading says it is weak', () => {
    const weak: Placement = {
      confidence: 'possible',
      candidates: [
        cand({ id: 'a', surface: 'clients list', file: 'components/Clients.jsx', matched: ['clients', 'client'], peak: 1.79 }),
        cand({ id: 'b', surface: 'client record', file: 'components/Record.jsx', matched: ['client'], peak: 1.79 }),
      ],
    }
    const text = buildCopyPrompt({ item: ITEM as any, analysis: analysisWith(weak), now: NOW }).text
    expect(text).toContain('WHICH SCREEN, PROBABLY (2 candidates, not certain which — WEAK')
    expect(text).toContain('components/Clients.jsx')
  })

  it('a confident shortlist is unchanged: "one candidate"', () => {
    const confident: Placement = {
      confidence: 'confident',
      candidates: [cand({ id: 'clients.inbox', surface: 'the Inbox', file: 'components/hive/InboxScreen.jsx', matched: ['inbox', 'assessment'], peak: 3.9 })],
    }
    const text = buildCopyPrompt({ item: ITEM as any, analysis: analysisWith(confident), now: NOW }).text
    expect(text).toContain('WHICH SCREEN, PROBABLY (one candidate)')
  })
})
