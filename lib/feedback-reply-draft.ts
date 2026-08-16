// lib/feedback-reply-draft.ts
//
// When something ships, draft the reply. Issue 309 step 5.
//
// ─── THE FAILURE THIS EXISTS FOR ──────────────────────────────────────
// Five owners waited seven weeks on work that had already shipped. Nothing in
// the system connected a deploy to the people waiting on it, so the news
// simply never travelled.
//
// ─── HOW AN ITEM LINKS TO A COMMIT — MEASURED, NOT ASSUMED ────────────
// The brief said "two commits this week name a feedback id in the message".
// They do not. NO commit in the entire history of this repository names a
// feedback item id — the search returns zero over every branch. What commits
// carry is Kevin's own ISSUE numbers ("issue 308", "(#118)"), and there is no
// stored mapping from an issue number to a feedback item. The fix for "Email
// cut off" is a real example: it shipped as (#118), and the only place that
// connects (#118) to that report is Kevin's memory.
//
// So there is no existing link, reliable or otherwise, and this module must not
// pretend otherwise. It supports exactly two, and their reliability is the
// thing that decides how the draft is written:
//
//   1. AN EXPLICIT TRAILER — `Feedback-Item: <uuid>` in the commit message.
//      RELIABLE, and it requires Kevin to remember nothing, because he is not
//      the one who writes it: the copy-prompt from issue 308 is what opens the
//      session that makes the fix, so the PROMPT carries the instruction and
//      the agent writes the trailer. The convention costs one line in a
//      generated file and nothing in anybody's head.
//
//   2. WORD OVERLAP between the commit subject and the report. NOT RELIABLE,
//      offered anyway because it is the only thing that works retroactively —
//      for every commit written before the trailer existed. It uses the issue
//      248 tokenizer, which already strips generic and ambient words, and needs
//      at least two distinctive shared tokens.
//
// A link of kind 2 NEVER produces a confident draft. That is the whole point of
// separating them.
//
// ─── WHY THE DRAFT MUST BE ABLE TO HEDGE ──────────────────────────────
// A commit proves the code changed. It does NOT prove the owner's problem is
// solved. "Email cut off" was fixed as a hover tooltip; the owner may still be
// unhappy, and had already been told once that it was handled. A draft that
// always declared victory would have got that same person wrong twice.
//
// Erring toward asking costs a sentence. Erring toward declaring cost seven
// weeks. So the hedge is the DEFAULT and confidence is the exception: any
// uncertainty anywhere — an unreliable link, a probe that only guessed, a
// report nobody diagnosed — produces the asking shape.

import { tokenize } from './feedback-placement'
import type { ItemAnalysis } from './feedback-analysis'

export type LinkKind = 'trailer' | 'word-overlap'

export interface CommitInfo {
  /** Full commit message — subject and body. */
  message: string
  /** Present for logging only. It NEVER reaches a draft. */
  sha?: string | null
}

export interface ItemLink {
  itemId: string
  kind: LinkKind
  /** Only a trailer link is reliable. Word overlap never is. */
  reliable: boolean
  /** The shared tokens, for a word-overlap link — so a human can audit it. */
  matched?: string[]
}

export interface LinkableItem {
  id: string
  title?: string | null
  description?: string | null
}

// `Feedback-Item: <uuid>` — a git trailer, one per line, case-insensitive on
// the key. Several may appear; one commit can answer more than one report.
const TRAILER = /^[ \t]*Feedback-Item:[ \t]*([0-9a-fA-F-]{8,})[ \t]*$/gim

export function readTrailers(message: string): string[] {
  const out: string[] = []
  const re = new RegExp(TRAILER.source, TRAILER.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(String(message || '')))) {
    const id = m[1].toLowerCase()
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** Distinctive tokens shared between the commit subject and the report. */
const MIN_SHARED_TOKENS = 2

function wordOverlap(commitMessage: string, item: LinkableItem): string[] {
  // The SUBJECT only. A commit body in this repo runs to twenty lines of
  // rationale and would collide with almost anything.
  const subject = String(commitMessage || '').split('\n')[0]
  const a = new Set(tokenize(subject))
  if (a.size === 0) return []
  const b = tokenize(`${item.title || ''} ${item.description || ''}`)
  const shared: string[] = []
  for (const t of b) if (a.has(t) && !shared.includes(t)) shared.push(t)
  return shared
}

/**
 * Which open items this commit appears to answer.
 *
 * Returns ONLY links it can justify. An empty array is the ordinary result and
 * must stay cheap — most commits answer nothing anybody reported.
 */
export function linkCommitToItems(commit: CommitInfo, items: LinkableItem[]): ItemLink[] {
  const message = String(commit?.message || '')
  const out: ItemLink[] = []

  const trailers = readTrailers(message)
  for (const item of items || []) {
    if (trailers.includes(String(item.id).toLowerCase())) {
      out.push({ itemId: item.id, kind: 'trailer', reliable: true })
    }
  }

  const alreadyLinked = new Set(out.map(l => l.itemId))
  for (const item of items || []) {
    if (alreadyLinked.has(item.id)) continue
    const matched = wordOverlap(message, item)
    if (matched.length >= MIN_SHARED_TOKENS) {
      out.push({ itemId: item.id, kind: 'word-overlap', reliable: false, matched })
    }
  }

  return out
}

// ─── The draft ────────────────────────────────────────────────────────

export type DraftShape = 'confident' | 'hedged'

export interface ReplyDraft {
  itemId: string
  shape: DraftShape
  /** The reply text, exactly as it would be sent. Three sentences, plain. */
  text: string
  /** Why it came out this shape — shown to Kevin, never to the owner. */
  because: string
}

export interface BuildDraftInput {
  item: LinkableItem
  link: ItemLink
  /** The issue 307 analysis, when one exists. */
  analysis?: ItemAnalysis | null
  /** Plain-language description of what changed. NEVER a hash or a filename. */
  whatChanged?: string | null
}

// Anything that would leak engineering vocabulary into an owner's inbox. The
// draft is read by a franchise owner, not by us; a commit hash or a file path
// in it is at best noise and at worst alarming.
const SHIPPED_OPENER = 'Thanks for reporting this'

/**
 * The reply, in three sentences: what was wrong, what happens now, what they
 * should do. No hash, no filename, no issue number — asserted by test.
 *
 * THE SHAPE IS DECIDED CONSERVATIVELY. Confidence requires BOTH a reliable
 * link AND a confident diagnosis; anything less hedges. There is no path that
 * upgrades an uncertain input into a confident sentence.
 */
export function buildReplyDraft({ item, link, analysis, whatChanged }: BuildDraftInput): ReplyDraft {
  const diagnosed = analysis?.confidence === 'confident' && !!analysis?.probe
  const confident = link.reliable && diagnosed

  const changed = (whatChanged || '').trim()

  if (confident) {
    // What was wrong — in the owner's terms, not the mechanism's. The probe's
    // `what` is written for an engineer, so it is deliberately NOT pasted in.
    const text = [
      `${SHIPPED_OPENER} — you were right, and it's now fixed.`,
      changed
        ? `${changed}`
        : `The problem you described was real, and the change has gone live.`,
      `You shouldn't need to do anything; if you still see it, tell us here and we'll take another look.`,
    ].join(' ')
    return {
      itemId: item.id,
      shape: 'confident',
      text,
      because: 'the commit names this item explicitly, and the cause was diagnosed with confidence',
    }
  }

  // THE HEDGE. Note what it does NOT say: it never claims the report is
  // resolved, and it asks a question the owner can actually answer. This is the
  // shape that would have been right for "Email cut off", where the fix was a
  // hover tooltip and the person had already been told once it was handled.
  const why = !link.reliable
    ? 'the change was matched to this report by wording alone, which is not reliable'
    : 'the cause of this report was never diagnosed with confidence'

  const text = [
    `${SHIPPED_OPENER}.`,
    changed
      ? `We've made a change that may cover it — ${lowerFirst(changed)}`
      : `We've made a change in this area that may cover what you described.`,
    `Could you take a look and tell us whether it's sorted? If it isn't, we'd rather know than assume.`,
  ].join(' ')

  return { itemId: item.id, shape: 'hedged', text, because: why }
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s)

// ─── The guard ────────────────────────────────────────────────────────
//
// A last check before a draft is shown. Engineering vocabulary reaching an
// owner is a specific, recognisable failure, so it is tested for by shape
// rather than trusted to authorship.
const HASH = /\b[0-9a-f]{7,40}\b/i
const FILENAME = /\b[\w/.-]+\.(ts|tsx|js|jsx|sql|json|md)\b/i
const ISSUE_REF = /\b(issue\s*\d+|#\d+)\b/i

export function draftLeaksEngineering(text: string): string | null {
  const s = String(text || '')
  if (FILENAME.test(s)) return 'filename'
  if (ISSUE_REF.test(s)) return 'issue reference'
  // Checked last: a bare hex run is the weakest signal and the most likely to
  // false-positive on ordinary prose.
  const words = s.split(/\s+/).filter(w => /^[0-9a-f]{7,40}$/i.test(w))
  if (words.length > 0 && HASH.test(words[0])) return 'commit hash'
  return null
}
