// lib/property-backfill.ts
//
// THE BACKFILL SWEEP for property drift — the same rule the webhook applies
// forwards, pointed backwards at what is already there.
//
// e0d0451 stopped NEW drift: a property Jobber has that Bee Hub has never seen
// now becomes one of that client's other addresses. It did nothing about the
// backlog — the clients whose extra Jobber properties were created before the
// fix and were never recorded. This sweep finds those.
//
// ─────────────────────────────────────────────────────────────────────────
// IT ASKS lib/property-drift, IT DOES NOT ANSWER. Every "is this address
// already known" decision here is planDriftAddress, the exact function the
// webhook calls. That is the whole point of that module existing: a sweep with
// its own opinion of "already known" would write the duplicates the webhook
// refuses to write, onto the same card, with the same label. There is one
// answer to that question and it lives over there.
// ─────────────────────────────────────────────────────────────────────────
//
// ONE JOBBER CALL PER CLIENT PAGE, NEVER PER CLIENT. 40,748 clients hold a
// Jobber id across 36 live franchise accounts that are not expecting this
// traffic. Jobber's Client type carries the properties inline, so a page of
// clients brings its properties with it: ~1,630 calls at 25 clients a page
// instead of 40,748. See CLIENT_PROPERTIES_QUERY for the field trap.
//
// PURE, AND DELIBERATELY IMPORT-LIGHT. No Supabase, no fetch, no clock, no
// sleep — all injected. Two reasons: every rule below is unit-testable without
// standing up a franchise account, and the CLI (scripts/backfill-property-drift.mjs)
// can import this straight from Node without dragging supabase-service and an
// env file in behind it. That is also why the Jobber id decode is local rather
// than imported from jobber-import, which pulls Supabase in at module load.
//
// READ-ONLY AGAINST JOBBER. Queries only. There is no mutation in this file
// and there must never be one.

import {
  parseFormerAddresses,
  formatLeadAddress,
  type FormerAddress,
  type LeadAddressParts,
} from './lead-address'
import {
  planDriftAddress,
  parseLooseAddress,
  compareLoose,
  describeLooseDifference,
  type JobberPropertyAddress,
  type LooseAddress,
} from './property-drift'

// ── scope ────────────────────────────────────────────────────────────────

// Philadelphia Suburbs re-imported all 18,889 of its clients at 06:12 UTC on
// 2026-09-09, so its properties are already current — and at ~46% of every
// client we hold, sweeping it again would be most of the run's cost for the
// least likely yield. Skipped by default, --include-philly when Kevin wants it.
export const PHILLY_SLUG = 'loc_phillysuburbs'

export type SweepMode = 'dry-run' | 'commit'

export interface BackfillLocationRow {
  location_id: string
  name?: string | null
  jobber_account_id?: string | null
}

/**
 * Which locations this sweep touches.
 *
 * A location without a jobber_account_id has nothing to read. Philadelphia
 * Suburbs is excluded unless asked for. Sorted by location_id so two runs
 * visit the same locations in the same order — resumability depends on the
 * order being stable, not on it being any order in particular.
 */
export function selectLocations(
  rows: BackfillLocationRow[] | null | undefined,
  opts: { includePhilly?: boolean } = {},
): BackfillLocationRow[] {
  const list = Array.isArray(rows) ? rows : []
  return list
    .filter((r) => !!r && !!String(r.jobber_account_id ?? '').trim())
    .filter((r) => (opts.includePhilly ? true : r.location_id !== PHILLY_SLUG))
    .slice()
    .sort((a, b) => (a.location_id < b.location_id ? -1 : a.location_id > b.location_id ? 1 : 0))
}

/**
 * A --location slug that names nothing this run would have swept.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. Before validation, a typo'd slug
 * filtered the list to nothing and the sweep reported a clean run: "0 locations
 * in scope", no errors, exit 0. That reads exactly like success. Kevin is going
 * to commit one franchise at a time and check the cards afterwards, so a run
 * that quietly did nothing is the single most expensive way this can fail — he
 * would go and look at a location that was never touched and conclude the sweep
 * does not work.
 */
export class UnknownLocationError extends Error {
  readonly unknown: string[]
  readonly outOfScope: string[]
  readonly available: string[]
  constructor(unknown: string[], outOfScope: string[], available: string[]) {
    const lines: string[] = ['--location named something this run would not sweep:']
    for (const s of outOfScope) {
      lines.push(`  ${s} — that location exists, but it is skipped by default; add --include-philly to sweep it`)
    }
    for (const s of unknown) {
      lines.push(`  ${s} — no location with that slug has a Jobber account`)
    }
    lines.push('', `in scope for this run (${available.length}):`, ...available.map((s) => `  ${s}`))
    super(lines.join('\n'))
    this.name = 'UnknownLocationError'
    this.unknown = unknown
    this.outOfScope = outOfScope
    this.available = available
  }
}

/**
 * The locations this run will actually sweep, after --location.
 *
 * NAMING PHILLY DOES NOT OVERRIDE --include-philly. Two flags must not both
 * control the same thing with the quieter one able to sidestep the louder:
 * --include-philly is the switch that says "yes, sweep the 18,889-client
 * account", and --location is scope selection, not permission. So
 * `--location=loc_phillysuburbs` on its own FAILS — loudly, naming the flag
 * that would allow it — rather than silently sweeping nothing.
 *
 * Order follows selectLocations, not the order the slugs were typed, so a
 * resumed run visits them the same way whatever the command line looked like.
 */
export function selectRequestedLocations(
  rows: BackfillLocationRow[] | null | undefined,
  opts: { includePhilly?: boolean; only?: string[] | null } = {},
): BackfillLocationRow[] {
  const inScope = selectLocations(rows, { includePhilly: opts.includePhilly })
  const asked = (opts.only ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (!asked.length) return inScope

  const inScopeIds = new Set(inScope.map((r) => r.location_id))
  // Everything with a Jobber account, Philly included — so a slug that is out
  // of scope only because of the Philly rule can be told apart from a typo.
  const anyConnected = new Set(
    selectLocations(rows, { includePhilly: true }).map((r) => r.location_id),
  )

  const unknown: string[] = []
  const outOfScope: string[] = []
  for (const slug of asked) {
    if (inScopeIds.has(slug)) continue
    if (anyConnected.has(slug)) outOfScope.push(slug)
    else unknown.push(slug)
  }
  if (unknown.length || outOfScope.length) {
    throw new UnknownLocationError(unknown, outOfScope, inScope.map((r) => r.location_id))
  }

  const wanted = new Set(asked)
  return inScope.filter((r) => wanted.has(r.location_id))
}

// ── the query ────────────────────────────────────────────────────────────

// THE FIELD TRAP. Jobber's Client type has TWO property-bearing fields: a
// legacy `properties` list that does NOT accept pagination arguments (sending
// it `(first: N)` fails with "Field 'properties' doesn't accept argument
// 'first'"), and the current `clientProperties` connection, which does. The
// connection is the supported shape — same one send-to-jobber and
// jobber-address-sync already use, both confirmed against live introspection.
//
// The address subfields are byte-identical to SINGLE_PROPERTY_QUERY, the
// query the WEBHOOK reads a property with, because the two must feed
// planDriftAddress the same shape or they can disagree about the same
// property. Jobber's `street` is the combined street1+street2 (see
// jobberAddressKey in jobber-address-writeback), which is what the webhook
// passes, so it is what this passes.
//
// totalCount rides along so a client holding more properties than one nested
// page can carry is COUNTED AND REPORTED rather than silently truncated. The
// nested connection is not drained: draining would reintroduce a per-client
// call, and a client with 20+ properties is rare enough that naming it in the
// report is the honest trade. If the report shows any, Kevin knows the sweep
// did not see everything for those clients.
export const CLIENT_PROPERTIES_QUERY = `
  query BackfillClientProperties($after: String, $first: Int!, $props: Int!) {
    clients(first: $first, after: $after) {
      nodes {
        id
        firstName
        lastName
        companyName
        clientProperties(first: $props) {
          totalCount
          nodes {
            id
            address { street city province postalCode }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

// Conservative on purpose. Jobber prices a query by the nodes it asks for, and
// a nested connection multiplies: 25 clients x 8 properties is ~200 nodes a
// call, comfortably inside the smallest account budget with room for the
// pre-check in the caller's throttle wrapper to do its job.
export const DEFAULT_CLIENT_PAGE = 25
export const DEFAULT_PROPERTY_PAGE = 8

// ── the dry-run guard ────────────────────────────────────────────────────

/**
 * THE ONE PLACE that decides whether this sweep is allowed to write.
 *
 * Every write in the sweep is behind this call and there is no second path to
 * the database. It is a function rather than an inline `mode === 'commit'` so
 * that the guard has a name, one definition, and a test that fails the moment
 * it stops meaning what it says — see the mutation test in
 * lib/beta-property-backfill.test.ts, which flips this to `true` and proves
 * the suite goes red.
 *
 * Default-deny: anything that is not exactly 'commit' is a dry run. A typo in
 * a flag, an undefined, a half-parsed argument — all of them read as "do not
 * write", which is the only safe way for this to fail.
 */
export function shouldWrite(mode: SweepMode | string | null | undefined): boolean {
  return mode === 'commit'
}

// ── rate limiting ────────────────────────────────────────────────────────

export class RateLimitExhaustedError extends Error {
  readonly locationId: string
  constructor(locationId: string, detail?: string) {
    super(`Jobber rate limit not clearing for ${locationId}${detail ? ` — ${detail}` : ''}`)
    this.name = 'RateLimitExhaustedError'
    this.locationId = locationId
  }
}

/**
 * Rate limiting arrives in two unrelated shapes and both have to count.
 *
 *   · HTTP 429 — the transport refused it. Surfaces as a thrown error carrying
 *     a status, or as a Response-ish object.
 *   · GraphQL THROTTLED — HTTP 200 with an errors array. Jobber's usual shape;
 *     a sweep that only checked the status code would read this as a hard
 *     failure and abandon a location that just needed to wait.
 */
export function isRateLimited(x: any): boolean {
  if (!x) return false
  const status = Number(x.status ?? x.statusCode ?? x.response?.status ?? NaN)
  if (status === 429) return true
  if (String(x.code ?? '') === 'RATE_LIMITED') return true
  const errors = x.errors ?? x.response?.errors
  if (Array.isArray(errors)) {
    return errors.some(
      (e: any) =>
        String(e?.extensions?.code ?? '').toUpperCase() === 'THROTTLED' ||
        /throttl|rate limit|too many requests/i.test(String(e?.message ?? '')),
    )
  }
  return false
}

/** Jobber's Retry-After when it sends one, in ms. Seconds or an HTTP date. */
export function retryAfterMs(x: any): number | null {
  const raw =
    x?.retryAfter ??
    x?.headers?.get?.('retry-after') ??
    x?.response?.headers?.get?.('retry-after') ??
    null
  if (raw === null || raw === undefined || raw === '') return null
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000))
  const at = Date.parse(String(raw))
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

// Exponential with a ceiling. Capped at a minute because past that we are no
// longer backing off politely, we are hanging — better to stop, checkpoint,
// and let Kevin resume than to sit on a franchise account for ten minutes.
export const MAX_BACKOFF_MS = 60_000
export function backoffMs(attempt: number, retryAfter?: number | null): number {
  if (retryAfter !== null && retryAfter !== undefined && retryAfter > 0) {
    return Math.min(retryAfter, MAX_BACKOFF_MS)
  }
  return Math.min(1_000 * Math.pow(2, Math.max(0, attempt)), MAX_BACKOFF_MS)
}

// ── counts and progress ──────────────────────────────────────────────────

export interface SweepCounts {
  clients_scanned: number
  clients_without_lead: number
  properties_seen: number
  properties_without_lead: number
  already_primary: number
  already_listed_active: number
  already_listed_retired: number
  no_usable_address: number
  would_create: number
  // The would_create split. These three sum to would_create, and they are
  // REPORTING ONLY — every one of them is still a create as far as
  // planDriftAddress and --commit are concerned. would_create_new is the
  // number Kevin is after.
  would_create_near_duplicate: number
  would_create_different_unit: number
  would_create_new: number
  // Withheld by --skip-near-duplicates. Its own counter on purpose: folding it
  // into another one would hide the number Kevin chose to leave behind.
  near_duplicates_skipped_by_flag: number
  created: number
  write_failed: number
  clients_with_more_properties_than_fetched: number
}

export function emptyCounts(): SweepCounts {
  return {
    clients_scanned: 0,
    clients_without_lead: 0,
    properties_seen: 0,
    properties_without_lead: 0,
    already_primary: 0,
    already_listed_active: 0,
    already_listed_retired: 0,
    no_usable_address: 0,
    would_create: 0,
    would_create_near_duplicate: 0,
    would_create_different_unit: 0,
    would_create_new: 0,
    near_duplicates_skipped_by_flag: 0,
    created: 0,
    write_failed: 0,
    clients_with_more_properties_than_fetched: 0,
  }
}

export function addCounts(a: SweepCounts, b: SweepCounts): SweepCounts {
  const out = emptyCounts()
  for (const k of Object.keys(out) as (keyof SweepCounts)[]) out[k] = a[k] + b[k]
  return out
}

/** One would-create, in the form Kevin reviews it in. */
export interface DriftFinding {
  location_id: string
  location_name: string
  lead_id: string
  client: string
  jobber_client_id: string
  jobber_property_id: string | null
  address: string
  why: string
  /** Reporting only — see classifyWouldCreate. Never affects the write. */
  label: DuplicateLabel
  /**
   * True when --skip-near-duplicates withheld this row. The row is still
   * listed: a review that silently loses rows is not a review.
   */
  skipped_by_flag: boolean
}

export interface SweepError {
  location_id: string
  message: string
}

export const PROGRESS_VERSION = 1

export interface Progress {
  version: number
  mode: SweepMode
  include_philly: boolean
  /**
   * The --location slugs this checkpoint was written for, sorted. Empty means
   * "everything in scope". Recorded so a resume cannot be pointed at a
   * checkpoint from a different scope — see assertResumable.
   *
   * Optional in the type: a checkpoint written before this field existed had
   * no --location, which is exactly what an absent value reads as.
   */
  scope?: string[]
  started_at: string
  updated_at: string
  /** Locations swept to the last page. Resume skips these outright. */
  completed: string[]
  /** Location → the endCursor of the last page fully processed. */
  cursors: Record<string, string | null>
  counts: Record<string, SweepCounts>
  findings: DriftFinding[]
  errors: SweepError[]
}

/** Sorted and de-duplicated, so two runs naming the same set agree. */
export function normalizeScope(only: string[] | null | undefined): string[] {
  return Array.from(new Set((only ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))).sort()
}

export function emptyProgress(
  mode: SweepMode,
  includePhilly: boolean,
  nowIso: string,
  only?: string[] | null,
): Progress {
  return {
    version: PROGRESS_VERSION,
    mode,
    include_philly: includePhilly,
    scope: normalizeScope(only),
    started_at: nowIso,
    updated_at: nowIso,
    completed: [],
    cursors: {},
    counts: {},
    findings: [],
    errors: [],
  }
}

/**
 * A checkpoint may only be resumed by a run of the SAME mode.
 *
 * Resuming a half-finished dry run with --commit would write the locations it
 * had not reached and silently skip the ones it had — a partial apply whose
 * boundary is wherever the first run happened to die. That is the worst
 * possible shape for a production write, so it is refused rather than
 * reconciled.
 */
export function assertResumable(
  p: Progress,
  mode: SweepMode,
  includePhilly: boolean,
  scope?: string[] | null,
): void {
  if (p.version !== PROGRESS_VERSION) {
    throw new Error(`checkpoint is version ${p.version}, this build writes ${PROGRESS_VERSION} — start a fresh run`)
  }
  if (p.mode !== mode) {
    throw new Error(
      `checkpoint was written by a ${p.mode} run; you asked for ${mode}. ` +
        `Resuming across modes would apply part of the plan and skip the rest — start a fresh run instead.`,
    )
  }
  if (p.include_philly !== includePhilly) {
    throw new Error(
      `checkpoint was written ${p.include_philly ? 'including' : 'excluding'} ${PHILLY_SLUG}; ` +
        `this run does the opposite — start a fresh run instead.`,
    )
  }
  // A checkpoint remembers which locations it already COMPLETED, so resuming
  // one under a different --location would skip a franchise Kevin has just
  // asked for and report it as done. Refused rather than reconciled, for the
  // same reason as the mode check above.
  const was = normalizeScope(p.scope)
  const now = normalizeScope(scope)
  if (was.join('|') !== now.join('|')) {
    const name = (s: string[]) => (s.length ? s.join(', ') : 'every location in scope')
    throw new Error(
      `checkpoint was written for ${name(was)}; this run is for ${name(now)}. ` +
        `Resuming across a scope change would skip a location you asked for — start a fresh run instead.`,
    )
  }
}

// ── Jobber ids ───────────────────────────────────────────────────────────

// Jobber global ids are base64 "gid://Jobber/Client/136289662"; leads store the
// trailing number. Same decode as extractJobberId in jobber-import, kept local
// because importing that module would pull supabase-service — and an env file —
// into a script whose whole point is to run without one.
export function jobberNumericId(globalId: string | null | undefined): string | null {
  if (!globalId) return null
  const s = String(globalId)
  if (/^\d+$/.test(s)) return s
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8')
    const m = decoded.match(/\/(\d+)$/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// ── the sweep ────────────────────────────────────────────────────────────

export interface BackfillLead {
  id: string
  jobber_client_id: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  former_addresses?: unknown
}

export interface SweepDeps {
  /** Read-only Jobber GraphQL. Throws, or resolves a { data, errors } body. */
  runQuery(locationId: string, query: string, variables: Record<string, any>): Promise<any>
  /** Every lead for this location that carries a jobber_client_id. */
  loadLeads(locationId: string): Promise<BackfillLead[]>
  /** Append-only: writes leads.former_addresses and nothing else. */
  appendAddress(leadId: string, nextFormerAddresses: FormerAddress[]): Promise<void>
  saveProgress(progress: Progress): Promise<void>
  now(): string
  sleep(ms: number): Promise<void>
  log(line: string): void
}

export interface SweepOptions {
  mode: SweepMode
  includePhilly?: boolean
  clientPage?: number
  propertyPage?: number
  maxRateLimitRetries?: number
  /** --skip-near-duplicates. Default off; see isWithheldByFlag. */
  skipNearDuplicates?: boolean
  /**
   * --location. Empty or absent sweeps everything in scope. A slug that names
   * nothing this run would sweep throws — see selectRequestedLocations.
   */
  only?: string[] | null
}

/**
 * THE WRITE FILTER — separate from the dry-run guard, and narrower.
 *
 * The labelled dry run found 1,342 would-creates: 1,107 genuinely new, 19 a
 * different unit in a building we already hold, and 216 near-duplicates of an
 * address already on the card. Writing those 216 would put a second address on
 * ~216 owners' cards that is the same place written differently. This is how
 * Kevin leaves them out.
 *
 * ONLY 'near-duplicate'. A different-unit row is a REAL second property — that
 * is the entire reason it has its own label instead of being folded in — and
 * filtering it here would silently drop 19 properties an owner wants. That
 * mistake would leave no trace in the output, which is why it is the one this
 * function is mutation-tested against.
 *
 * It sits ALONGSIDE shouldWrite, not inside it: the mode gate decides whether
 * this run writes at all, and this decides whether a particular row is one of
 * the rows it writes. Two questions, two names, each failing on its own.
 */
export function isWithheldByFlag(
  label: DuplicateLabel,
  skipNearDuplicates: boolean | null | undefined,
): boolean {
  if (!skipNearDuplicates) return false
  return label === 'near-duplicate'
}

/**
 * Why planDriftAddress judged this property new — as a description of what it
 * was shown, never as a second opinion about it. The decision above is the
 * decision; this only says what the card looked like when it was taken.
 */
export function describeWhyNew(input: {
  lead: LeadAddressParts
  formerAddresses: FormerAddress[]
  jobberPropertyId: string | null
}): string {
  const primary = formatLeadAddress(input.lead)
  const n = input.formerAddresses.length
  return [
    primary ? `not the lead's primary address (${primary})` : 'the lead has no primary address on file',
    input.jobberPropertyId
      ? `no address on the card carries Jobber property id ${input.jobberPropertyId}`
      : 'Jobber gave no property id for it',
    n === 0
      ? 'the card lists no other addresses'
      : `no match among the ${n} other address${n === 1 ? '' : 'es'} already listed`,
  ].join('; ')
}

// ── near-duplicate classification (REPORTING ONLY) ────────────────────────
//
// The first dry run produced 1,336 would-creates against an expected ~137, and
// reading it by eye showed a large share were the same address written
// differently rather than a second property. This puts a number on that split
// so the fix can be chosen from evidence rather than from an impression.
//
// IT CHANGES NOTHING. planDriftAddress still decides create-or-skip on its own
// strict key; --commit still writes every would-create, near-duplicates
// included. This only labels them. When Kevin has the split he can decide
// whether the loose key should become the real matcher — and that is a change
// to property-drift, not to this file.
//
// THREE LABELS, because two would lose the case that matters most. A second
// unit in the same building is a genuinely different property an owner wants
// on the card, and folding it into "near-duplicate" would quietly discard
// exactly the rows the sweep exists to find.

export type DuplicateLabel = 'near-duplicate' | 'different-unit' | 'new'

export interface WouldCreateClassification {
  label: DuplicateLabel
  /** Short phrase for the row's "why" line. Empty for a genuine new. */
  reason: string
}

/**
 * Compare one would-create against the primary AND every address already on
 * the card, and say which it near-matches and on what basis.
 *
 * PRECEDENCE. A near-duplicate anywhere on the card wins, because one
 * confident "we already hold this" settles the row however many other
 * addresses it fails to match. Only if nothing near-matches does a
 * unit difference decide it. Failing both, it is new.
 *
 * The primary is checked first and named first, since that is where the
 * defects in the run mostly are — a stored primary missing its zip, or
 * carrying its own city/state/zip tail twice.
 */
export function classifyWouldCreate(input: {
  lead: LeadAddressParts
  formerAddresses: FormerAddress[]
  entry: FormerAddress
}): WouldCreateClassification {
  const candidate = parseLooseAddress(input.entry?.display ?? '')
  if (!candidate.street) return { label: 'new', reason: '' }

  const against: Array<{ what: string; loose: LooseAddress }> = []
  const primary = formatLeadAddress(input.lead)
  if (primary) against.push({ what: 'the primary', loose: parseLooseAddress(primary) })
  const list = Array.isArray(input.formerAddresses) ? input.formerAddresses : []
  list.forEach((e, i) => {
    const display = String(e?.display ?? '')
    if (display) against.push({ what: `other address #${i + 1}`, loose: parseLooseAddress(display) })
  })

  let unitHit: string | null = null
  for (const c of against) {
    const verdict = compareLoose(candidate, c.loose)
    if (verdict === 'match') {
      return {
        label: 'near-duplicate',
        reason: `near-duplicate of ${c.what} — differs ${describeLooseDifference(candidate, c.loose)}`,
      }
    }
    if (verdict === 'unit_differs' && !unitHit) unitHit = c.what
  }

  if (unitHit) {
    return { label: 'different-unit', reason: `a different unit in the same building as ${unitHit}` }
  }
  return { label: 'new', reason: '' }
}

function clientLabel(node: any): string {
  const name = [node?.firstName, node?.lastName].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ')
  const company = String(node?.companyName ?? '').trim()
  return name || company || '(unnamed client)'
}

/**
 * One Jobber page, with the rate-limit retry around it.
 *
 * Retries in place while the limit is what is wrong; anything else throws
 * straight out to the caller, which checkpoints before it lets the error go.
 */
async function fetchClientPage(
  deps: SweepDeps,
  locationId: string,
  after: string | null,
  clientPage: number,
  propertyPage: number,
  maxRetries: number,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let result: any
    try {
      result = await deps.runQuery(locationId, CLIENT_PROPERTIES_QUERY, {
        after,
        first: clientPage,
        props: propertyPage,
      })
    } catch (err: any) {
      if (isRateLimited(err) && attempt < maxRetries) {
        const wait = backoffMs(attempt, retryAfterMs(err))
        deps.log(`  rate limited (HTTP) — waiting ${wait}ms, attempt ${attempt + 1}/${maxRetries}`)
        await deps.sleep(wait)
        continue
      }
      if (isRateLimited(err)) throw new RateLimitExhaustedError(locationId, String(err?.message ?? err))
      throw err
    }

    if (isRateLimited(result)) {
      if (attempt < maxRetries) {
        const wait = backoffMs(attempt, retryAfterMs(result))
        deps.log(`  throttled by Jobber — waiting ${wait}ms, attempt ${attempt + 1}/${maxRetries}`)
        await deps.sleep(wait)
        continue
      }
      throw new RateLimitExhaustedError(locationId, 'THROTTLED after every retry')
    }

    if (Array.isArray(result?.errors) && result.errors.length) {
      throw new Error(`jobber query failed for ${locationId}: ${JSON.stringify(result.errors)}`)
    }
    return result
  }
}

/**
 * Sweep one location, mutating `progress` in place and checkpointing after
 * every page — so a death, a 429 or a Ctrl-C costs at most the page in flight.
 */
export async function sweepLocation(
  location: BackfillLocationRow,
  deps: SweepDeps,
  progress: Progress,
  opts: SweepOptions,
): Promise<SweepCounts> {
  const locId = location.location_id
  const locName = String(location.name ?? '').trim() || locId
  const clientPage = opts.clientPage ?? DEFAULT_CLIENT_PAGE
  const propertyPage = opts.propertyPage ?? DEFAULT_PROPERTY_PAGE
  const maxRetries = opts.maxRateLimitRetries ?? 5

  const counts = progress.counts[locId] ?? emptyCounts()
  progress.counts[locId] = counts

  // Re-read every time, resume included. That re-read is what makes a commit
  // run idempotent: anything a previous attempt already appended is on the
  // card now, so planDriftAddress sees it and skips it as already known.
  const leads = await deps.loadLeads(locId)
  const byClient = new Map<string, { lead: BackfillLead; formerAddresses: FormerAddress[] }>()
  for (const lead of leads) {
    const key = String(lead?.jobber_client_id ?? '').trim()
    if (!key) continue
    byClient.set(key, { lead, formerAddresses: parseFormerAddresses(lead.former_addresses) })
  }
  deps.log(`  ${byClient.size} lead${byClient.size === 1 ? '' : 's'} with a Jobber client id`)

  let after: string | null = progress.cursors[locId] ?? null
  if (after) deps.log(`  resuming after cursor ${after}`)

  for (;;) {
    const page = await fetchClientPage(deps, locId, after, clientPage, propertyPage, maxRetries)
    const conn = page?.data?.clients
    const nodes: any[] = Array.isArray(conn?.nodes) ? conn.nodes : []

    for (const node of nodes) {
      counts.clients_scanned++
      const numeric = jobberNumericId(node?.id)
      const held = numeric ? byClient.get(numeric) : undefined
      const props: any[] = Array.isArray(node?.clientProperties?.nodes) ? node.clientProperties.nodes : []

      const total = Number(node?.clientProperties?.totalCount ?? props.length)
      if (Number.isFinite(total) && total > props.length) {
        counts.clients_with_more_properties_than_fetched++
      }

      // KEVIN'S STANDING RULING: a property whose client has no lead here is
      // left alone. It is not drift — it is a client we do not have, and
      // inventing a lead for it would put a record with no owner, no source
      // and no consent into someone's worklist.
      if (!held) {
        counts.clients_without_lead++
        counts.properties_seen += props.length
        counts.properties_without_lead += props.length
        continue
      }

      for (const prop of props) {
        counts.properties_seen++
        const propNumeric = jobberNumericId(prop?.id)
        const address = (prop?.address ?? null) as JobberPropertyAddress | null

        const plan = planDriftAddress({
          lead: held.lead as LeadAddressParts,
          formerAddresses: held.formerAddresses,
          address,
          jobberPropertyId: propNumeric,
          nowIso: deps.now(),
        })

        if (plan.action === 'skip') {
          if (plan.reason === 'no_address') counts.no_usable_address++
          else if (plan.reason === 'matches_primary') counts.already_primary++
          else if (plan.retired) counts.already_listed_retired++
          else counts.already_listed_active++
          continue
        }

        counts.would_create++

        // REPORTING ONLY, and after the decision, never before it. The label
        // is attached to the row and counted; it does not gate the write below
        // and it did not gate the plan above.
        const classified = classifyWouldCreate({
          lead: held.lead as LeadAddressParts,
          formerAddresses: held.formerAddresses,
          entry: plan.entry,
        })
        if (classified.label === 'near-duplicate') counts.would_create_near_duplicate++
        else if (classified.label === 'different-unit') counts.would_create_different_unit++
        else counts.would_create_new++

        const withheld = isWithheldByFlag(classified.label, opts.skipNearDuplicates)
        if (withheld) counts.near_duplicates_skipped_by_flag++

        const why = describeWhyNew({
          lead: held.lead as LeadAddressParts,
          formerAddresses: held.formerAddresses,
          jobberPropertyId: propNumeric,
        })
        progress.findings.push({
          location_id: locId,
          location_name: locName,
          lead_id: held.lead.id,
          client: clientLabel(node),
          jobber_client_id: numeric ?? '',
          jobber_property_id: propNumeric,
          address: plan.entry.display,
          why: classified.reason ? `${why} — BUT ${classified.reason}` : why,
          label: classified.label,
          skipped_by_flag: withheld,
        })

        // Withheld by the flag: counted, listed, and not written. Nothing
        // below runs for it — including the in-memory update, because the card
        // does not hold this address and must not be treated as if it does.
        if (withheld) continue

        const next = [...held.formerAddresses, plan.entry]

        // ── THE GUARD ──────────────────────────────────────────────────────
        // The only write in this file, and the only branch that reaches the
        // database. A dry run falls straight past it having counted and
        // recorded the finding, and touches nothing.
        if (shouldWrite(opts.mode)) {
          try {
            await deps.appendAddress(held.lead.id, next)
            counts.created++
          } catch (err: any) {
            counts.write_failed++
            progress.errors.push({
              location_id: locId,
              message: `lead ${held.lead.id}: ${String(err?.message ?? err)}`,
            })
            continue // the card is unchanged, so do not pretend it holds this
          }
        }

        // Kept in step whether or not we wrote. In a commit run this is the
        // card as it now stands; in a dry run it is the card as it WOULD
        // stand, which is what makes the projection honest — two Jobber
        // properties at the same address on one client count once, exactly as
        // a real run would record them.
        held.formerAddresses = next
      }
    }

    after = conn?.pageInfo?.endCursor ?? after
    progress.cursors[locId] = after ?? null
    progress.updated_at = deps.now()
    await deps.saveProgress(progress)

    if (!conn?.pageInfo?.hasNextPage) break
  }

  if (!progress.completed.includes(locId)) progress.completed.push(locId)
  progress.updated_at = deps.now()
  await deps.saveProgress(progress)
  return counts
}

/**
 * The whole sweep.
 *
 * A location that fails for its own reasons (a dead token, a disconnected
 * account) is recorded and stepped over — one broken franchise must not cost
 * the other 35. Rate-limit exhaustion is different and stops the run: it means
 * Jobber is asking us to go away, and the polite response is to checkpoint and
 * let Kevin resume, not to keep knocking on the next account.
 */
export async function runBackfill(
  locations: BackfillLocationRow[],
  deps: SweepDeps,
  opts: SweepOptions,
  existing?: Progress,
): Promise<Progress> {
  const includePhilly = !!opts.includePhilly
  const scope = normalizeScope(opts.only)

  // FIRST, and before anything touches Jobber. An unrecognised --location
  // throws here, so a typo cannot reach a franchise account and cannot be
  // mistaken for a run that found nothing to do.
  const targets = selectRequestedLocations(locations, { includePhilly, only: scope })

  const progress = existing ?? emptyProgress(opts.mode, includePhilly, deps.now(), scope)
  if (existing) assertResumable(existing, opts.mode, includePhilly, scope)

  deps.log(
    scope.length
      ? `${targets.length} location${targets.length === 1 ? '' : 's'} in scope, limited by --location to: ${scope.join(', ')}`
      : `${targets.length} location${targets.length === 1 ? '' : 's'} in scope` +
          (includePhilly ? ` (including ${PHILLY_SLUG})` : ` (${PHILLY_SLUG} skipped)`),
  )

  for (const loc of targets) {
    if (progress.completed.includes(loc.location_id)) {
      deps.log(`- ${loc.location_id}: already done, skipping`)
      continue
    }
    deps.log(`- ${loc.location_id}${loc.name ? ` (${loc.name})` : ''}`)
    try {
      await sweepLocation(loc, deps, progress, opts)
    } catch (err: any) {
      progress.updated_at = deps.now()
      if (err instanceof RateLimitExhaustedError) {
        progress.errors.push({ location_id: loc.location_id, message: err.message })
        await deps.saveProgress(progress)
        throw err
      }
      progress.errors.push({ location_id: loc.location_id, message: String(err?.message ?? err) })
      deps.log(`  FAILED: ${String(err?.message ?? err)} — moving on`)
      await deps.saveProgress(progress)
    }
  }

  progress.updated_at = deps.now()
  await deps.saveProgress(progress)
  return progress
}

// ── the report ───────────────────────────────────────────────────────────

export function totalCounts(progress: Progress): SweepCounts {
  return Object.values(progress.counts).reduce(addCounts, emptyCounts())
}

function countLines(c: SweepCounts): string[] {
  return [
    `clients scanned                      ${c.clients_scanned}`,
    `  of those, no lead in Bee Hub       ${c.clients_without_lead}   (left alone)`,
    `properties seen                      ${c.properties_seen}`,
    `  on clients with no lead            ${c.properties_without_lead}   (left alone)`,
    `already known — is the primary       ${c.already_primary}`,
    `already known — listed, active       ${c.already_listed_active}`,
    `already known — listed, retired      ${c.already_listed_retired}`,
    `skipped — no usable address          ${c.no_usable_address}`,
    `WOULD CREATE                         ${c.would_create}`,
    `  · near-duplicate of one we hold    ${c.would_create_near_duplicate}   (same place, written differently)`,
    `  · different unit, same building    ${c.would_create_different_unit}   (a real second property)`,
    `  · GENUINELY NEW                    ${c.would_create_new}`,
    `withheld by --skip-near-duplicates   ${c.near_duplicates_skipped_by_flag}`,
    `written                              ${c.created}`,
    `write failed                         ${c.write_failed}`,
    `clients with more properties than one page carried  ${c.clients_with_more_properties_than_fetched}`,
  ]
}

/**
 * The reviewable output. Every would-create names its location, its client,
 * the address, and what the card looked like when the call was made — because
 * this is the thing Kevin reads BEFORE anything is written, and a summary line
 * cannot be reviewed, only believed.
 */
export function formatReport(progress: Progress): string {
  const out: string[] = []
  const banner =
    progress.mode === 'commit'
      ? '*** COMMIT MODE — THIS RUN WROTE TO THE DATABASE ***'
      : '*** DRY RUN — NOTHING WAS WRITTEN ***'
  out.push(banner, '')

  const locIds = Object.keys(progress.counts).sort()
  for (const locId of locIds) {
    out.push(`── ${locId} ${progress.completed.includes(locId) ? '' : '(INCOMPLETE)'}`.trim())
    for (const line of countLines(progress.counts[locId])) out.push(`   ${line}`)
    out.push('')
  }

  out.push('══ TOTAL')
  for (const line of countLines(totalCounts(progress))) out.push(`   ${line}`)
  out.push('')

  if (progress.findings.length) {
    // Grouped, and the genuinely-new ones first: that is the list Kevin is
    // actually deciding about. The other two groups are printed in full rather
    // than summarised away, because the classifier is new and its calls have
    // to be checkable by eye before anyone trusts the totals.
    const groups: Array<[DuplicateLabel, string]> = [
      ['new', 'GENUINELY NEW — no address on the card looks like these'],
      ['different-unit', 'DIFFERENT UNIT — same building as one we hold, but a different unit'],
      ['near-duplicate', 'NEAR-DUPLICATE — looks like an address the card already holds'],
    ]
    out.push(
      `══ ${progress.findings.length} address${progress.findings.length === 1 ? '' : 'es'} the sweep would add — review before committing`,
      '',
    )
    for (const [label, heading] of groups) {
      const rows = progress.findings.filter((f) => f.label === label)
      if (!rows.length) continue
      // Withheld rows are STILL LISTED, and said so on every line. The flag
      // changes what gets written, never what Kevin gets to look at — a row
      // that vanishes from the review is a row nobody can disagree with.
      const withheld = rows.filter((f) => f.skipped_by_flag).length
      out.push(`── ${rows.length} ${heading}${withheld ? ` — ${withheld} WOULD BE SKIPPED by --skip-near-duplicates` : ''}`, '')
      for (const f of rows) {
        out.push(
          `  ${f.skipped_by_flag ? '[WOULD BE SKIPPED] ' : ''}${f.location_name} · ${f.client} (lead ${f.lead_id})`,
        )
        out.push(`    address : ${f.address}`)
        out.push(`    property: ${f.jobber_property_id ?? '(none given)'}   jobber client: ${f.jobber_client_id}`)
        out.push(`    why new : ${f.why}`)
        out.push('')
      }
    }
  } else {
    out.push('══ no addresses to add', '')
  }

  if (progress.errors.length) {
    out.push(`══ ${progress.errors.length} problem${progress.errors.length === 1 ? '' : 's'}`, '')
    for (const e of progress.errors) out.push(`  ${e.location_id}: ${e.message}`)
    out.push('')
  }

  out.push(banner)
  return out.join('\n')
}
