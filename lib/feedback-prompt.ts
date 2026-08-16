// lib/feedback-prompt.ts
//
// Turning a triage row into a ready-to-paste prompt. Issue 308 step 4.
//
// ─── WHY THIS IS SMALL ────────────────────────────────────────────────
// Issue 307 already did the hard part. A probe carries a traced mechanism, the
// files involved, and a fleet count computed against production. This module
// is a renderer: it adds no judgement of its own and looks nothing up. If a
// fact is not on the item or the analysis, it does not appear in the prompt.
//
// ─── THE SHAPE IS COPIED FROM THE PROMPTS THAT WORKED ─────────────────
// Read against the briefs that produced issues 249, 306 and 307, every one of
// which had the same skeleton: verify the base yourself · the owner's own
// words verbatim · who and when · the analysis stated as a hypothesis · the
// fleet count · what NOT to build · the standing environment notes · establish
// the test baseline · build unpiped · report, and assume a premise is wrong.
//
// ─── NO STALE FACTS, BY CONSTRUCTION ──────────────────────────────────
// Two things are deliberately NOT interpolated, because this text may sit on a
// clipboard for a week before it is pasted:
//
//   A COMMIT HASH. The briefs that worked all named one ("origin/main should
//   be <sha> or later"), and they could, because a human wrote them at the
//   moment they were true. Generated text has no such moment. A quoted hash
//   that has since moved is worse than no hash at all — it reads as a fact and
//   sends the reader to a stale base — so the prompt says verify the tip and
//   names nothing. There is a test for the absence.
//
//   THE TEST BASELINE COUNT. Same argument, same fix: the prompt says to
//   establish the baseline and report it, which is what the working briefs
//   actually asked for too.
//
// ─── THE HAZARD THIS MODULE EXISTS TO AVOID ───────────────────────────
// A generated prompt that asserted its own analysis as fact would be worse
// than no button. Roughly twenty premises in this project have been asserted
// and then falsified by checking production — several from probes that looked
// solid at the time. So the diagnosis is always framed as something to VERIFY,
// in those words, and the framing is not a formality: it is the sentence that
// stops a wrong probe from becoming a wrong build.

import type { ItemAnalysis, AnalysisCluster } from './feedback-analysis'
import { feedbackAgeDays } from './feedback-queues'

export type PromptTier = 'full' | 'short'

export interface PromptItem {
  id: string
  type?: string | null
  title?: string | null
  description?: string | null
  status?: string | null
  created_at?: string | null
  submitter_name?: string | null
  location_name?: string | null
  is_internal?: boolean | null
  context?: { kind?: string; stage?: string; path?: string } | null
  context_client_name?: string | null
  attachments?: unknown[] | null
}

export interface BuildPromptInput {
  item: PromptItem
  /** From issue 307. Null or probe-less analysis ⇒ the short tier. */
  analysis?: ItemAnalysis | null
  /** The cluster this item belongs to, when it is in one. */
  cluster?: AnalysisCluster | null
  now?: number
}

/**
 * Which tier an item gets. Exported because the ROW shows it before Kevin
 * clicks — knowing whether a click yields a diagnosis or a starting point is
 * the difference between opening a session and asking a question first.
 */
export function promptTierFor(analysis?: ItemAnalysis | null): PromptTier {
  return analysis && analysis.probe ? 'full' : 'short'
}

const agePhrase = (days: number | null): string => {
  if (days == null) return 'age unknown'
  if (days <= 0) return 'today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

// The owner's words, VERBATIM. Not summarised, not cleaned up, not truncated:
// the exact text is the primary evidence, and every paraphrase in this project
// has lost the one detail that mattered. Indented as a block so it is visibly
// quotation rather than instruction — a description containing something that
// reads like a command must not be mistakable for one.
const quoteBlock = (text: string): string =>
  String(text || '')
    .split('\n')
    .map(l => `  | ${l}`)
    .join('\n')

// Standing environment notes. These do not go stale, so they CAN be stated.
const ENVIRONMENT = `ENVIRONMENT — standing notes, all verified
  Repo: /Users/flightdeck/projects/clients/bee-organized/repo
  .env.local EXISTS in the main checkout. Worktrees do not inherit it —
    ln -s ../../../.env.local .env.local  before the first build.
  Use an isolated worktree, and give it its OWN node_modules (npm install
    inside it). Sharing the main checkout's silently stops 133 mount-test
    files from loading at all, and the run still reports green.
  npm run build UNPIPED — a piped build hides the real exit code.
  .jsx is NOT type-checked (tsconfig includes only **/*.ts and **/*.tsx), so
    any guard on a .jsx change must be a test that mounts the component.
  components/admin/** and components/BeeHub.jsx are under a token sweep that
    reads COMMENTS as well as code: no hex or rgba literal anywhere, and write
    issue numbers as "issue 123", never with a hash prefix the sweep reads as
    a hex colour.`

const CLOSING = `BUILD AND PUSH
  npm run build UNPIPED, real exit code. git push origin HEAD:main.

REPORT
  Pushed SHA, diff stat, what you verified and what you changed your mind
  about, and the test baseline you measured.
  Assume a premise in this prompt is wrong and say which.`

const BASE = `Base: verify the tip yourself. Check origin/main and work from it.
This prompt deliberately names NO commit hash — it may have been on the
clipboard for a while, and a stale hash reads as a fact.`

function reportBlock(item: PromptItem, now: number): string {
  const who = item.submitter_name || 'unknown'
  const where = item.location_name ? ` · ${item.location_name}` : ''
  const age = agePhrase(feedbackAgeDays(item.created_at, now))
  const lines = [
    'THE REPORT',
    `  ${who}${where} · filed ${age} · status ${item.status || 'unknown'} · type ${item.type || 'unknown'}`,
    ...(item.is_internal ? ['  [internal item — filed by the team, not by an owner]'] : []),
    '',
    'Their words, verbatim — the title they chose, then what they wrote. This is',
    'the primary evidence; do not work from a paraphrase of it. (Reports filed',
    'from a record get an auto-generated title, so the title may carry nothing.)',
    quoteBlock(item.title || ''),
    '  |',
    quoteBlock(item.description || ''),
  ]

  // The issue-249 pointer, where the report was filed FROM a record. It is the
  // difference between "a client is wrong" and "this client, on this screen".
  if (item.context?.path) {
    const bits = [
      `  path: ${item.context.path}`,
      item.context.kind ? `  record: ${item.context.kind}` : null,
      item.context_client_name ? `  client: ${item.context_client_name}` : null,
      item.context.stage ? `  stage at the time it was filed: ${item.context.stage}` : null,
    ].filter(Boolean)
    lines.push('', 'FILED FROM THIS RECORD (captured at submit time):', ...(bits as string[]))
  }

  const n = Array.isArray(item.attachments) ? item.attachments.length : 0
  if (n > 0) {
    lines.push('', `  ${n} attachment${n === 1 ? '' : 's'} on the item — open the triage screen to see ${n === 1 ? 'it' : 'them'}.`)
  }

  return lines.join('\n')
}

// The shortlist from issue 248's word matcher. Carried WITH its caveat: it
// matches an owner's vocabulary against a map of surfaces, so it says which
// screen, never which bug, and it has placed things confidently wrong before.
function shortlistBlock(analysis?: ItemAnalysis | null): string | null {
  const p = analysis?.placement
  if (!p || p.confidence === 'none' || !p.candidates?.length) return null
  const rows = p.candidates.map(c => {
    const ref = c.lines && c.lines.length === 2 ? `${c.file}:${c.lines[0]}` : c.file
    return `  · ${c.surface}\n    ${ref}   (matched on the owner's words: ${c.matched.join(', ')})`
  })
  return [
    `WHICH SCREEN, PROBABLY (${p.confidence === 'confident' ? 'one candidate' : `${p.candidates.length} candidates, not certain which`})`,
    ...rows,
    '',
    '  This comes from matching the owner\'s vocabulary against a map of surfaces.',
    '  It says WHERE, never WHAT, and it has been confidently wrong before — one',
    '  report was placed on Settings by the word "business". Check the matched',
    '  words above before trusting any of these.',
  ].join('\n')
}

function clusterBlock(cluster?: AnalysisCluster | null): string | null {
  if (!cluster || cluster.itemIds.length < 2) return null
  return [
    `RELATED REPORTS — ${cluster.itemIds.length} items were grouped under this same root cause.`,
    '  They are separate rows on the triage screen. If this diagnosis holds, one',
    '  fix should answer all of them — so check them before closing any, and do',
    '  NOT fix them separately.',
  ].join('\n')
}

// ─── The full tier ────────────────────────────────────────────────────
// An item a probe recognised. Everything the short tier carries, plus the
// mechanism, the files, the size, and the fleet count — each with the caveat
// that belongs to it.
function fullPrompt(input: Required<Pick<BuildPromptInput, 'item'>> & BuildPromptInput, now: number): string {
  const { item, analysis, cluster } = input
  const a = analysis as ItemAnalysis
  const out: string[] = []

  out.push(`Issue — ${item.title || '(untitled report)'}`)
  out.push('')
  out.push(BASE)
  out.push('')
  out.push(reportBlock(item, now))
  out.push('')

  out.push('WHAT THE ANALYSIS THINKS IS WRONG — THIS IS A HYPOTHESIS TO VERIFY,')
  out.push('NOT A FACT TO BUILD ON.')
  out.push('')
  out.push(a.what.split('. ').join('.\n'))
  out.push('')
  out.push(`  confidence as stated by the analysis: ${a.confidence}`)
  out.push('')
  out.push('  VERIFY THIS BEFORE YOU BUILD ANYTHING ON IT. It was produced by a probe')
  out.push('  that pattern-matches production state, and probes have been wrong.')
  out.push('  Roughly twenty premises in this project have been asserted and then')
  out.push('  falsified by checking production — several of them from diagnoses that')
  out.push('  looked at least this solid. Read the code and check the data yourself.')
  out.push('  If it is wrong, say so plainly and say what is actually happening; that')
  out.push('  is a more valuable outcome than a fix built on a wrong model.')

  if (a.fleet) {
    out.push('')
    out.push('FLEET IMPACT — computed against production, not estimated')
    out.push(`  ${a.fleet.count} ${a.fleet.unit}`)
    out.push(`  basis: ${a.fleet.basis}`)
    out.push('  Re-run this count yourself before quoting it anywhere. It moves, and it')
    out.push('  is only as good as the predicate above.')
  }

  if (a.files.length) {
    out.push('')
    out.push('WHERE TO LOOK — starting points, not conclusions')
    for (const f of a.files) out.push(`  ${f}`)
  }

  if (a.size) {
    out.push('')
    out.push(`ROUGH SIZE: ${a.size}`)
    out.push('  A size, deliberately, and not an hours figure — an hours estimate on a')
    out.push('  bug nobody has reproduced yet looks precise and is not.')
  }

  const cl = clusterBlock(cluster)
  if (cl) { out.push(''); out.push(cl) }

  const sl = shortlistBlock(analysis)
  if (sl) { out.push(''); out.push(sl) }

  out.push('')
  out.push('SCOPE — what NOT to do')
  out.push('  Fix the mechanism described above and nothing adjacent to it. Do not')
  out.push('  refactor the surrounding code, do not widen this into the related reports')
  out.push('  (they are their own rows), and if the fix seems to need a schema change,')
  out.push('  STOP and say so rather than writing a migration — migrations are run by')
  out.push('  hand here, against a live system.')
  out.push('')
  out.push(ENVIRONMENT)
  out.push('')
  out.push('TESTS')
  out.push('  Run the suite BEFORE changing anything and report that baseline — it is')
  out.push('  the only way a later number means something. Then: a test that fails')
  out.push('  without your fix and passes with it, and a check that the fleet count')
  out.push('  above actually drops.')
  out.push('')
  out.push(CLOSING)

  return out.join('\n')
}

// ─── The short tier ───────────────────────────────────────────────────
// No probe recognised this one — which is the case for most items. It gets the
// report, the record pointer, the shortlist, and an explicit statement that
// the cause is NOT established.
//
// DELIBERATELY NOT PADDED. The temptation is to bulk this out so it looks as
// substantial as the full tier; that would be exactly the confident-empty
// prompt this step exists to avoid. Short IS the honest signal: it tells the
// reader at a glance that nobody has diagnosed this yet.
function shortPrompt(input: BuildPromptInput, now: number): string {
  const { item, analysis } = input
  const out: string[] = []

  out.push(`Issue — ${item.title || '(untitled report)'}`)
  out.push('')
  out.push(BASE)
  out.push('')
  out.push(reportBlock(item, now))
  out.push('')
  out.push('THE CAUSE IS NOT ESTABLISHED. START BY FINDING IT.')
  out.push('')
  out.push('  No diagnosis exists for this report. Nothing in this project has traced')
  out.push('  it to a mechanism, and the automated analysis did not recognise it —')
  out.push('  which is a statement about the analysis, not evidence that the report is')
  out.push('  vague or minor.')
  out.push('')
  out.push('  So the first deliverable is the diagnosis, not a fix. Reproduce it or')
  out.push('  find it in the data, then say what is actually happening and how much of')
  out.push('  the fleet it touches. If the report does not carry enough to place it,')
  out.push('  say exactly what you would need to ask the owner — that is a real answer')
  out.push('  and a useful one, and it is better than a plausible guess.')

  const sl = shortlistBlock(analysis)
  if (sl) { out.push(''); out.push(sl) }

  out.push('')
  out.push('SCOPE — what NOT to do')
  out.push('  Do not build a fix on an unverified theory. If diagnosing it turns out to')
  out.push('  be the whole job, that is a complete and successful outcome — report the')
  out.push('  mechanism and the blast radius and stop there.')
  out.push('')
  out.push(ENVIRONMENT)
  out.push('')
  out.push('TESTS')
  out.push('  Run the suite BEFORE changing anything and report that baseline. If this')
  out.push('  turns out to be diagnosis only, there may be nothing to test — say so')
  out.push('  rather than adding a test that asserts the bug.')
  out.push('')
  out.push(CLOSING)

  return out.join('\n')
}

export interface BuiltPrompt {
  tier: PromptTier
  text: string
}

export function buildCopyPrompt(input: BuildPromptInput): BuiltPrompt {
  const now = input.now ?? Date.now()
  const tier = promptTierFor(input.analysis)
  return {
    tier,
    text: tier === 'full'
      ? fullPrompt(input as any, now)
      : shortPrompt(input, now),
  }
}
