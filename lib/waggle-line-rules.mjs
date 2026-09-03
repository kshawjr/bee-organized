// lib/waggle-line-rules.mjs
//
// The mechanical half of "would an owner notice?" — the tells that a line
// was written for Kevin rather than for a franchise owner. Plain ESM with
// no imports so BOTH the route (app/api/help/releases/lines) and the
// command-line script (scripts/waggle-add.mjs) run the same checks: the
// script refuses before any network, the route refuses again regardless.
//
// This cannot judge whether a change is worth a line — that judgment is
// the rule in CLAUDE.md. It only catches the words that are never right:
// a commit hash, an issue number, a file name, a function call, a route
// path, engineering vocabulary, and the two phrases that mean "I could not
// say what changed". A line that trips one of these was not written for
// an owner, whatever it is about.

export const WAGGLE_GROUPS = ['new', 'changed', 'fixed']
export const WAGGLE_LIMITS = { title: 120, body: 300 }

// Words an owner does not use about their own week. Whole-word, case-
// insensitive. Deliberately short: this is a fence, not a thesaurus.
const JARGON = [
  'route', 'endpoint', 'api', 'sql', 'migration', 'rls', 'cron', 'webhook',
  'commit', 'refactor', 'refactored', 'deploy', 'deployed', 'regression',
  'null', 'undefined', 'schema', 'backend', 'frontend', 'prop', 'props',
  'component', 'middleware', 'token', 'oauth', 'payload', 'json',
]
const EMPTY_PHRASES = [
  'improved reliability', 'various fixes', 'minor fixes', 'bug fixes',
  'general improvements', 'under the hood', 'stability improvements',
  'performance improvements', 'code cleanup', 'housekeeping',
]

const HASH = /\b[0-9a-f]{7,40}\b/i
const ISSUE = /(\bissue\s*#?\d+\b|#\d{2,}\b)/i
const FILE = /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|sql|json|md|yml|yaml)\b/i
const PATH = /(?:^|\s)\/(?:api|app|lib|components|scripts)\b|\/[a-z0-9_-]+\/[a-z0-9_-]+\//i
const CALL = /\b[a-zA-Z_][\w]*\(\)/
const ENV = /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/

// Returns null when the line passes, or ONE sentence saying what to fix.
export function lintOwnerLine(input) {
  const src = input && typeof input === 'object' ? input : {}
  const group = String(src.group ?? '').trim().toLowerCase()
  const title = String(src.title ?? '').trim()
  const body = String(src.body ?? '').trim()

  if (!WAGGLE_GROUPS.includes(group)) return 'Group must be new, changed or fixed.'
  if (!title) return 'A headline is required.'
  if (!body) return 'One sentence is required — a headline alone says nothing to an owner.'
  if (title.length > WAGGLE_LIMITS.title) return `The headline is over ${WAGGLE_LIMITS.title} characters.`
  if (body.length > WAGGLE_LIMITS.body) return `The sentence is over ${WAGGLE_LIMITS.body} characters.`

  const both = `${title}\n${body}`
  if (HASH.test(both) && !/\b\d{7,}\b/.test(both)) return 'That looks like a commit hash. Owners never see hashes.'
  if (ISSUE.test(both)) return 'No issue numbers — say what changed, not where it was tracked.'
  if (FILE.test(both)) return 'That names a file. Say what the owner sees, not where the code lives.'
  if (PATH.test(both)) return 'That looks like a path or a route. Owners do not know what a route is.'
  if (CALL.test(both)) return 'That looks like a function. Say what it does for the owner.'
  if (ENV.test(both)) return 'That looks like a setting name. Owners never see those.'
  for (const p of EMPTY_PHRASES) {
    if (both.toLowerCase().includes(p)) return `"${p}" is not a change an owner can notice. If you cannot say what changed for them, skip the line.`
  }
  const words = both.toLowerCase().split(/[^a-z0-9']+/)
  const hit = JARGON.find(j => words.includes(j))
  if (hit) return `"${hit}" is engineering vocabulary. Say it the way an owner would.`
  return null
}
