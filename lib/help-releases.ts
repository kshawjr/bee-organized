// lib/help-releases.ts
//
// What's new — the weekly release note — shared, side-effect-free rules.
// Server-safe (no React, no 'use client') so the routes, the feedback PATCH
// hook, the screen and the tests read ONE definition of what a week is,
// what a line may hold, and what the Slack post says.
//
// THE SHAPE, in one paragraph. A release is a week (FRIDAY to THURSDAY; the
// note goes out on the Thursday). Exactly one release is 'draft' at a time
// and it fills itself: marking a feedback entry Fixed seeds one line into it
// — the group from the entry's type, the entry's title verbatim, an empty
// body, the entry's id as provenance. A seeded line has edited_at NULL,
// which means "still in the owner's words": it is greyed for the editor,
// never shown to owners, never posted to Slack. Kevin edits the ones worth
// telling, and publish sends the rest forward to next week's draft rather
// than refusing. Nothing here ever writes to feedback_items.
//
// TWO TABLES, not a new kind in help_entries: a release has a date and a
// lifecycle, its lines have a group and a provenance and an edit state, and
// none of that is a section, a topic or an item. The reasoning is in the
// scope note (/tmp/release-notes.md §5).

import { isHelpEditorRole } from './help-content'

export { isHelpEditorRole }

export type ReleaseStatus = 'draft' | 'published'
export type ReleaseGroup = 'new' | 'changed' | 'fixed' | 'question'

export type ReleaseRow = {
  id: string
  week_start: string
  publish_on: string
  status: ReleaseStatus
  summary?: string | null
  published_at?: string | null
  slack_text?: string | null
  slack_posted_at?: string | null
  slack_error?: string | null
  // sequential, assigned at publish, editors only — "that went out in 12".
  // Owners never see it and the post never carries it.
  number?: number | null
  created_by?: string | null
  updated_by?: string | null
  created_at?: string
  updated_at?: string
}

export type ReleaseItemRow = {
  id: string
  release_id: string
  group: ReleaseGroup
  title: string
  body?: string | null
  help_entry_id?: string | null
  feedback_item_id?: string | null
  edited_at?: string | null
  position?: number
  deleted_at?: string | null
  created_by?: string | null
  updated_by?: string | null
  created_at?: string
  updated_at?: string
}

// The editor's reference block: what the owner actually wrote, and what we
// told them. Only ever attached to DRAFT lines in an EDITOR's payload.
export type ReleaseItemSource = {
  title: string
  type: string | null
  description: string | null
  admin_response: string | null
}

export type ShapedItem = ReleaseItemRow & { unedited: boolean; source?: ReleaseItemSource | null }
export type ShapedRelease = Omit<ReleaseRow, 'slack_text'> & {
  groups: Record<ReleaseGroup, ShapedItem[]>
  item_count: number
  unedited_count: number
  week_label: string
  slack_text?: string | null
}

// ── the week ──────────────────────────────────────────────────────
// The week is a LABEL, computed once in one zone and stored as two dates.
// Friday → Thursday, so Thursday's publish closes the week and a fix on
// Friday opens the next. Eastern is a constant; if Kevin's Thursday is not
// an Eastern Thursday, this is the one line that changes.
export const RELEASE_TZ = 'America/New_York'
export const WEEK_ENDS_ON = 4 // Thursday (0 = Sunday)
const WEEK_STARTS_ON = (WEEK_ENDS_ON + 1) % 7 // Friday

export function ymdInZone(d: Date, tz: string = RELEASE_TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function utcFromYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function addDays(ymd: string, n: number): string {
  const d = utcFromYmd(ymd)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function weekForYmd(ymd: string): { week_start: string; publish_on: string } {
  const dow = utcFromYmd(ymd).getUTCDay()
  const sinceStart = (dow - WEEK_STARTS_ON + 7) % 7
  const week_start = addDays(ymd, -sinceStart)
  return { week_start, publish_on: addDays(week_start, 6) }
}

export function weekFor(now: Date = new Date(), tz: string = RELEASE_TZ): { week_start: string; publish_on: string } {
  return weekForYmd(ymdInZone(now, tz))
}

// The week the NEXT draft belongs to once `publish_on`'s release is out:
// the week after it — unless that week is already behind us (a late
// publish), in which case the current one.
export function nextWeekAfter(publish_on: string, now: Date = new Date(), tz: string = RELEASE_TZ): { week_start: string; publish_on: string } {
  const today = ymdInZone(now, tz)
  const dayAfter = addDays(publish_on, 1)
  return weekForYmd(dayAfter > today ? dayAfter : today)
}

// "Thu, Sep 4" — for headings and the Slack post. Deterministic (UTC on a
// date-only value), so the label never shifts with the reader's clock.
export function formatWeekLabel(publish_on: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(publish_on || ''))) return ''
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(utcFromYmd(publish_on))
}

// Was the note due before today? For the amber "was due Thursday" line.
export function isOverdue(publish_on: string, now: Date = new Date(), tz: string = RELEASE_TZ): boolean {
  return ymdInZone(now, tz) > publish_on
}

// ── groups ────────────────────────────────────────────────────────
// The three CHANGE groups, then the questions. A question line is "what
// was asked" (title) and "what we said" (body); it renders after the
// changes in Help and as its own short section at the end of the post.
export const CHANGE_GROUPS: ReleaseGroup[] = ['new', 'changed', 'fixed']
export const GROUP_ORDER: ReleaseGroup[] = ['new', 'changed', 'fixed', 'question']
export const GROUP_LABEL: Record<ReleaseGroup, string> = { new: 'New', changed: 'Changed', fixed: 'Fixed', question: 'You asked' }
export const GROUP_EMOJI: Record<ReleaseGroup, string> = { new: '✨', changed: '🔧', fixed: '✅', question: '💬' }
// The post carries at most this many questions, oldest first, so nothing
// waits forever and the post stays short. The rest are in Help and the
// preview names them. Kevin picks by what he rewrites: only edited lines
// are ever in the post.
export const WAGGLE_MAX_QUESTIONS = 3

// bug → Fixed, feature → New, anything else → Changed. Always editable.
export function groupForType(type: unknown): ReleaseGroup {
  const t = String(type ?? '')
  if (t === 'bug') return 'fixed'
  if (t === 'feature') return 'new'
  return 'changed'
}

export function isUnedited(item: { edited_at?: string | null }): boolean {
  return !item.edited_at
}

// ── line input, sanitised ─────────────────────────────────────────
export const RELEASE_LIMITS = { title: 120, body: 300, summary: 200 } as const

export type ReleaseItemInput = { group: ReleaseGroup; title: string; body: string | null }

export function normalizeReleaseItemInput(raw: unknown): { input: ReleaseItemInput; problem: null } | { input: null; problem: string } {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const group = String(src.group ?? '') as ReleaseGroup
  if (!GROUP_ORDER.includes(group)) return { input: null, problem: 'Pick New, Changed or Fixed.' }
  const title = String(src.title ?? '').trim().slice(0, RELEASE_LIMITS.title)
  if (!title) return { input: null, problem: 'A headline is required.' }
  const body = String(src.body ?? '').trim().slice(0, RELEASE_LIMITS.body) || null
  return { input: { group, title, body }, problem: null }
}

export function normalizeSummary(raw: unknown): string | null {
  return String(raw ?? '').trim().slice(0, RELEASE_LIMITS.summary) || null
}

// ── shaping for the wire ──────────────────────────────────────────
// forOwner=true is the OWNER view: deleted lines go, and so does every line
// still in the owner's words — an owner never meets a headline that is a
// bug report. Editors get everything undeleted, flagged.
export function shapeRelease(
  release: ReleaseRow,
  items: ReleaseItemRow[],
  opts: { forOwner: boolean; sources?: Map<string, ReleaseItemSource> },
): ShapedRelease {
  const groups: Record<ReleaseGroup, ShapedItem[]> = { new: [], changed: [], fixed: [], question: [] }
  let unedited = 0
  const ordered = items
    .filter(i => i.release_id === release.id && !i.deleted_at)
    .sort((a, b) => (Number(a.position ?? 0) - Number(b.position ?? 0)) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
  for (const i of ordered) {
    const un = isUnedited(i)
    if (un) unedited++
    if (opts.forOwner && un) continue
    const g: ReleaseGroup = GROUP_ORDER.includes(i.group) ? i.group : 'changed'
    const shaped: ShapedItem = { ...i, group: g, unedited: un }
    if (!opts.forOwner) shaped.source = (i.feedback_item_id && opts.sources?.get(i.feedback_item_id)) || null
    else { delete (shaped as any).feedback_item_id; delete (shaped as any).created_by; delete (shaped as any).updated_by }
    groups[g].push(shaped)
  }
  const { slack_text, ...rest } = release
  const out: ShapedRelease = {
    ...rest,
    groups,
    item_count: GROUP_ORDER.reduce((n, g) => n + groups[g].length, 0),
    unedited_count: opts.forOwner ? 0 : unedited,
    week_label: formatWeekLabel(release.publish_on),
  }
  if (!opts.forOwner) out.slack_text = slack_text ?? null
  else { delete (out as any).slack_error; delete (out as any).slack_posted_at; delete (out as any).created_by; delete (out as any).updated_by; delete (out as any).number }
  return out
}

// ── the Slack post ────────────────────────────────────────────────
// ASSEMBLED, NOT WRITTEN. Every fact in the post is a line Kevin edited;
// the only words that are not his are the header, one opener (used only
// when the week has no summary line), the group headings, and one closer.
// "Different version" cycles the opener and closer through the short lists
// below. No model writes any of it, and Kevin reads it in a textarea before
// anything is sent.
export const WAGGLE_CHANNEL = { id: 'C0BTS6KGLNP', name: '#tech-updates-info' } as const

const OPENERS = [
  'Here is what changed in Bee Hub this week.',
  'A quick look at what the hive has been up to this week.',
  'Fresh from the hive — here is what is new in Bee Hub.',
]
const CLOSERS = [
  'The full list lives in Bee Hub under Help › What’s new. 🍯',
  'Spot something that still isn’t right? Tell us from Help — a person reads every one. 🐝',
  'That’s the week. Everything above is live in Bee Hub now. 🍯',
]
export const WAGGLE_VARIANTS = Math.max(OPENERS.length, CLOSERS.length)

// Slack's mrkdwn treats these three as control characters in text.
export function slackEscape(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export type WaggleLeftOut = { id: string; title: string; reason: 'their_words' | 'no_sentence' | 'over_cap' }

// NO NAMES, NO NUMBER. The builder reads title, body and group — never a
// submitter, never the release number. A question line is the question
// and the answer, both in Kevin's rewrite; "a few of you asked" is his to
// write, and the seed never carries who asked.
export function buildWaggleMessage(
  release: Pick<ReleaseRow, 'publish_on' | 'summary'>,
  items: Array<Pick<ReleaseItemRow, 'id' | 'group' | 'title' | 'body' | 'edited_at' | 'deleted_at'> & { created_at?: string; position?: number }>,
  opts: { variant?: number } = {},
): { text: string; included: number; leftOut: WaggleLeftOut[]; variant: number } {
  const v = ((Number(opts.variant) || 0) % WAGGLE_VARIANTS + WAGGLE_VARIANTS) % WAGGLE_VARIANTS
  const order = (a: { created_at?: string; position?: number }, b: { created_at?: string; position?: number }) =>
    (Number(a.position ?? 0) - Number(b.position ?? 0)) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
  const live = items.filter(i => !i.deleted_at).slice().sort(order)
  const leftOut: WaggleLeftOut[] = []
  const byGroup: Record<ReleaseGroup, typeof live> = { new: [], changed: [], fixed: [], question: [] }
  for (const i of live) {
    if (isUnedited(i)) { leftOut.push({ id: i.id, title: i.title, reason: 'their_words' }); continue }
    if (!String(i.body ?? '').trim()) { leftOut.push({ id: i.id, title: i.title, reason: 'no_sentence' }); continue }
    const g: ReleaseGroup = GROUP_ORDER.includes(i.group) ? i.group : 'changed'
    if (g === 'question' && byGroup.question.length >= WAGGLE_MAX_QUESTIONS) { leftOut.push({ id: i.id, title: i.title, reason: 'over_cap' }); continue }
    byGroup[g].push(i)
  }
  const included = GROUP_ORDER.reduce((n, g) => n + byGroup[g].length, 0)

  const lines: string[] = []
  lines.push(`🐝 *The Waggle* · week ending ${formatWeekLabel(release.publish_on)}`)
  const summary = String(release.summary ?? '').trim()
  lines.push(slackEscape(summary || OPENERS[v % OPENERS.length]))
  for (const g of CHANGE_GROUPS) {
    if (byGroup[g].length === 0) continue
    lines.push('')
    lines.push(`${GROUP_EMOJI[g]} *${GROUP_LABEL[g]}*`)
    for (const i of byGroup[g]) {
      lines.push(`• *${slackEscape(i.title.trim())}* — ${slackEscape(String(i.body).trim())}`)
    }
  }
  if (byGroup.question.length > 0) {
    lines.push('')
    lines.push(`${GROUP_EMOJI.question} *A few things you asked this week*`)
    for (const i of byGroup.question) {
      lines.push(`• *${slackEscape(i.title.trim())}*`)
      lines.push(`  ${slackEscape(String(i.body).trim())}`)
    }
  }
  lines.push('')
  lines.push(slackEscape(CLOSERS[v % CLOSERS.length]))
  return { text: lines.join('\n'), included, leftOut, variant: v }
}

// ── the seed ──────────────────────────────────────────────────────
// Called from the feedback PATCH route when an entry moves INTO shipped.
// NEVER THROWS: the save has already landed and the Fixed email must still
// go, so every failure here is a warning in the log and nothing else. The
// unique index on feedback_item_id makes a repeat a no-op (23505), so a
// re-save, an un-fix-and-re-fix, or two admins racing cannot seed twice.
//
// `service` is the service-role client (the caller passes it in; this
// module imports no I/O so it stays testable and tree-shakeable).
type MinimalClient = { from: (table: string) => any }

export async function getOrCreateDraft(
  service: MinimalClient,
  userId: string | null,
  now: Date = new Date(),
): Promise<{ draft: ReleaseRow | null; error: unknown }> {
  const { data: existing, error: selErr } = await service
    .from('help_releases').select('*').eq('status', 'draft').limit(1).maybeSingle()
  if (selErr) return { draft: null, error: selErr }
  if (existing) return { draft: existing as ReleaseRow, error: null }

  const week = weekFor(now)
  const { data: created, error: insErr } = await service
    .from('help_releases')
    .insert({ ...week, status: 'draft', created_by: userId, updated_by: userId })
    .select('*').single()
  if (created) return { draft: created as ReleaseRow, error: null }
  // Lost a race to another draft: read the winner.
  if (insErr && String((insErr as any).code) === '23505') {
    const { data: again, error: againErr } = await service
      .from('help_releases').select('*').eq('status', 'draft').limit(1).maybeSingle()
    return { draft: (again as ReleaseRow) ?? null, error: againErr }
  }
  return { draft: null, error: insErr ?? new Error('draft_insert_returned_nothing') }
}

export type SeedResult = { added: true } | { added: false; reason: string }

// TWO KINDS OF SEED, ONE LINE PER ENTRY EVER.
//   'change'   (marked Fixed)    → group from the type, title verbatim, no body
//   'question' (marked Answered) → group 'question', the entry's title as the
//                                  question, our latest reply as the answer
// Both land with edited_at NULL: "their words", hidden from owners and the
// post until Kevin rewrites them. The reply is a STARTING POINT — it is in
// Kevin's voice with hashes and personal detail — which is exactly why it
// stays unpublished until edited. Neither seed carries who asked: no name,
// no email, no user id. The unique index on feedback_item_id means an entry
// answered and later fixed (or the reverse) seeds once, not twice.
export async function seedReleaseItemFromFeedback(
  service: MinimalClient,
  feedback: { id: string; type: unknown; title: unknown; answer?: unknown },
  userId: string | null,
  now: Date = new Date(),
  opts: { as?: 'change' | 'question' } = {},
): Promise<SeedResult> {
  const asQuestion = opts.as === 'question'
  try {
    const { draft, error } = await getOrCreateDraft(service, userId, now)
    if (!draft) {
      if (isMissingReleasesTable(error)) return { added: false, reason: 'not_set_up' }
      console.warn('[whats-new seed] no draft:', (error as any)?.message ?? error)
      return { added: false, reason: 'no_draft' }
    }
    const title = String(feedback.title ?? '').trim().slice(0, RELEASE_LIMITS.title) || (asQuestion ? 'Untitled question' : 'Untitled report')
    const answer = asQuestion ? (String(feedback.answer ?? '').trim().slice(0, RELEASE_LIMITS.body) || null) : null
    const { error: insErr } = await service
      .from('help_release_items')
      .insert({
        release_id: draft.id,
        group: asQuestion ? 'question' : groupForType(feedback.type),
        title,
        body: answer,
        feedback_item_id: feedback.id,
        edited_at: null,
        created_by: userId,
        updated_by: userId,
      })
      .select('id').single()
    if (insErr) {
      if (String((insErr as any).code) === '23505') return { added: false, reason: 'already_seeded' }
      if (isMissingReleasesTable(insErr)) return { added: false, reason: 'not_set_up' }
      console.warn('[whats-new seed] insert failed:', (insErr as any)?.message ?? insErr)
      return { added: false, reason: String((insErr as any)?.message ?? 'insert_failed') }
    }
    return { added: true }
  } catch (err) {
    console.warn('[whats-new seed] threw:', (err as any)?.message ?? err)
    return { added: false, reason: String((err as any)?.message ?? err) }
  }
}

// ── missing-table detection ───────────────────────────────────────
// The migration is HELD (Kevin runs it). Until then the tab reads as empty
// and the writers say so in words.
export function isMissingReleasesTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  const code = String(e.code ?? '')
  if (code === 'PGRST205' || code === '42P01' || code === 'PGRST204') return true
  const msg = String(e.message ?? '').toLowerCase()
  return msg.includes('help_release') && (msg.includes('not find') || msg.includes('does not exist') || msg.includes('schema cache'))
}

export const RELEASES_NOT_SET_UP = "What's new isn't set up yet — the help_releases migration hasn't been run."
