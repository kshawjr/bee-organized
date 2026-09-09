// ═══════════════════════════════════════════════════════════════════════════
// PROPERTY DRIFT BACKFILL — the webhook's rule, pointed backwards.
//
// HELD. KEVIN RUNS THIS. DRY RUN BY DEFAULT: it prints exactly what it would
// write and writes nothing at all. --commit to apply.
//
// WHAT IT DOES. e0d0451 stopped new drift — a property Jobber has that Bee Hub
// has never seen now becomes one of that client's other addresses. It did not
// touch the backlog. This walks every connected location, reads each client's
// properties out of Jobber, and asks planDriftAddress — THE SAME FUNCTION THE
// WEBHOOK ASKS — whether each one is an address we already know. Anything new
// is appended to leads.former_addresses as 'other' / 'Found in Jobber',
// identical to the row the webhook writes.
//
// WHAT IT WILL NOT DO:
//   · never writes the primary address columns
//   · never writes or moves leads.jobber_property_id
//   · never mutates anything in Jobber — every call is a query
//   · never invents a lead. A property whose client has no lead in Bee Hub is
//     left alone (Kevin's standing ruling)
//   · never writes at all without --commit
//
// SCOPE. Every location with a jobber_account_id except loc_phillysuburbs,
// which re-imported all 18,889 of its clients on 2026-09-09 and is therefore
// already current. --include-philly when that stops being true.
//
// EFFICIENCY. Jobber's Client type carries its properties inline, so this
// pages CLIENTS and reads their properties from the same response — ~1,630
// calls for 40,748 clients rather than one call each. It is never one call per
// client: these are live franchise accounts that are not expecting us.
//
// RESUMABLE. Progress is checkpointed to disk after EVERY page. A run that
// dies at location 20 — or gets rate limited, or is Ctrl-C'd — resumes with
// --resume and picks up at the page it lost, not at the beginning.
//
// Usage:
//   node scripts/backfill-property-drift.mjs                  # dry run
//   node scripts/backfill-property-drift.mjs --resume         # continue one
//   node scripts/backfill-property-drift.mjs --commit         # apply
//   node scripts/backfill-property-drift.mjs --commit --skip-near-duplicates
//                                    # apply, but leave out the ~216 rows that
//                                    # are an address the card already holds,
//                                    # written differently. Different-unit
//                                    # rows are STILL written. Default off.
//   node scripts/backfill-property-drift.mjs --location=loc_kc --commit
//                                    # ONE franchise. Repeatable
//                                    # (--location=a --location=b). An
//                                    # unrecognised slug fails before any
//                                    # Jobber call rather than sweeping
//                                    # nothing and reporting a clean run.
//                                    # Each scope gets its OWN checkpoint
//                                    # file, so one franchise at a time needs
//                                    # no deleting between runs.
//   node scripts/backfill-property-drift.mjs --include-philly
//   node scripts/backfill-property-drift.mjs --env <path>     # default .env.local
//   node scripts/backfill-property-drift.mjs --progress <path>
//   node scripts/backfill-property-drift.mjs --page-size 25 --property-page 8
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installTsResolver } from './ts-alias-hook.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolvePath(HERE, '..')

// ── flags ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const val = (k, d = null) => {
  const withEq = argv.find((a) => a.startsWith(k + '='))
  if (withEq) return withEq.slice(k.length + 1)
  const i = argv.indexOf(k)
  return i > -1 && argv[i + 1] ? argv[i + 1] : d
}
// Repeatable flags. Both spellings, because muscle memory produces both:
//   --location=loc_a --location=loc_b
//   --location loc_a --location loc_b
//   --location=loc_a,loc_b
const vals = (k) => {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith(k + '=')) out.push(...a.slice(k.length + 1).split(','))
    else if (a === k && argv[i + 1] && !argv[i + 1].startsWith('-')) out.push(...argv[++i].split(','))
  }
  return out.map((s) => s.trim()).filter(Boolean)
}

if (has('--help') || has('-h')) {
  // The header block, up to and including its closing rule. Found rather than
  // counted, so adding a line to the docs cannot silently truncate the help.
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
  const end = lines.findIndex((l, i) => i > 0 && l.startsWith('// ═══'))
  console.log(lines.slice(0, end + 1).join('\n'))
  process.exit(0)
}

const COMMIT = has('--commit')
const MODE = COMMIT ? 'commit' : 'dry-run'
const RESUME = has('--resume')
const INCLUDE_PHILLY = has('--include-philly')
// Sorted and de-duplicated here so the checkpoint filename is stable whatever
// order the flags were typed in. The engine normalizes again for the scope
// comparison — that one is authoritative, this is just for the filename.
const ONLY_LOCATIONS = Array.from(new Set(vals('--location'))).sort()
// Default OFF. Without it this run behaves exactly as it did before the flag
// existed, which is the only safe default for something that changes what
// lands on an owner's card.
const SKIP_NEAR_DUPLICATES = has('--skip-near-duplicates')

// ── THE CHECKPOINT IS SCOPED TO WHAT THE RUN IS SWEEPING ──────────────────
//
// Kevin is going to run this one franchise at a time. With a single shared
// checkpoint file that goes wrong two different ways, and the second is the
// dangerous one:
//
//   · without --resume, every run after the first refuses to start ("a
//     checkpoint already exists"), so he would be deleting a file between
//     every franchise;
//   · with --resume, the checkpoint still lists the PREVIOUS franchise as
//     completed and its counts and findings ride along into this run's
//     report — and if he ever re-named an earlier location it would be
//     skipped as "already done" while the report said the run was clean.
//     That is the stale-checkpoint failure exactly.
//
// So the default filename carries the scope: one franchise gets its own
// checkpoint, resumable on its own, and a different franchise cannot collide
// with it. `--progress <path>` still overrides for anyone who wants one file.
//
// The scope is ALSO recorded inside the checkpoint and checked on resume, so
// an explicit --progress pointing at another scope's file is refused rather
// than silently skipping locations. Belt and braces, because the cost of
// getting this wrong is a franchise Kevin believes was swept and was not.
const scopeKey =
  ONLY_LOCATIONS.length === 0
    ? 'all'
    : ONLY_LOCATIONS.length === 1
      ? ONLY_LOCATIONS[0]
      : `${ONLY_LOCATIONS.length}locs-${createHash('sha256').update(ONLY_LOCATIONS.join('|')).digest('hex').slice(0, 8)}`
const PROGRESS_PATH = resolvePath(
  process.cwd(),
  val('--progress', `.property-backfill-progress.${scopeKey}.json`),
)
const CLIENT_PAGE = Number(val('--page-size', '25'))
const PROPERTY_PAGE = Number(val('--property-page', '8'))

// SAY IT LOUDLY, FIRST, EVERY RUN. Nobody should have to read a flag list to
// find out whether the thing they just started writes to production.
const BANNER =
  MODE === 'commit'
    ? [
        '',
        '*********************************************************',
        '***  COMMIT MODE — THIS RUN WILL WRITE TO PRODUCTION  ***',
        '*********************************************************',
        '',
      ]
    : [
        '',
        '=========================================================',
        '===  DRY RUN — NOTHING WILL BE WRITTEN ANYWHERE       ===',
        '===  add --commit to apply what this prints           ===',
        '=========================================================',
        '',
      ]
console.log(BANNER.join('\n'))

// Second banner, same reason as the first: which rows this run will leave
// behind is as much a fact about it as whether it writes at all.
console.log(
  (SKIP_NEAR_DUPLICATES
    ? [
        '---------------------------------------------------------',
        '---  --skip-near-duplicates IS ON                     ---',
        '---  near-duplicates will be LISTED but NOT written   ---',
        '---  different-unit rows ARE still written            ---',
        '---------------------------------------------------------',
      ]
    : [
        '---------------------------------------------------------',
        '---  --skip-near-duplicates is OFF (default)          ---',
        '---  ALL would-creates are written, near-duplicates   ---',
        '---  included                                         ---',
        '---------------------------------------------------------',
      ]
  ).join('\n') + '\n',
)

// Third banner, same principle: WHICH franchises this run touches is the
// first thing to be sure of when committing one at a time.
console.log(
  (ONLY_LOCATIONS.length
    ? [
        '---------------------------------------------------------',
        `---  --location: ONLY ${ONLY_LOCATIONS.join(', ')}`,
        '---  every other location is untouched by this run    ---',
        '---------------------------------------------------------',
      ]
    : [
        '---------------------------------------------------------',
        '---  no --location: EVERY location in scope           ---',
        '---------------------------------------------------------',
      ]
  ).join('\n') + '\n',
)

// ── env ───────────────────────────────────────────────────────────────────
const envPath = resolvePath(process.cwd(), val('--env', '.env.local'))
if (!existsSync(envPath)) {
  console.error(`missing env file at ${envPath} — run from the repo root or pass --env <path>`)
  process.exit(1)
}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  if (!(k in process.env)) process.env[k] = v
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

// ── the app's own code ────────────────────────────────────────────────────
// Env first, THEN these imports: lib/supabase-service builds its client at
// module load out of process.env, so importing any of this earlier would build
// a client with no credentials.
installTsResolver(ROOT)
const { createClient } = await import('@supabase/supabase-js')
const jobber = await import(pathToFileURL(ROOT + '/lib/jobber.ts').href)
const backfill = await import(pathToFileURL(ROOT + '/lib/property-backfill.ts').href)

const {
  runBackfill,
  formatReport,
  totalCounts,
  emptyProgress,
  assertResumable,
  selectRequestedLocations,
  PHILLY_SLUG,
} = backfill

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// ── progress on disk ──────────────────────────────────────────────────────
// Written via a temp file and renamed, so a crash mid-write cannot leave a
// half-serialized checkpoint where a good one used to be — the failure mode
// that turns "resumable" into "start over".
function saveProgressSync(p) {
  const tmp = PROGRESS_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(p, null, 2))
  renameSync(tmp, PROGRESS_PATH)
}

let existing
if (RESUME) {
  if (!existsSync(PROGRESS_PATH)) {
    console.error(`--resume but no checkpoint at ${PROGRESS_PATH}`)
    process.exit(1)
  }
  existing = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'))
  try {
    assertResumable(existing, MODE, INCLUDE_PHILLY, ONLY_LOCATIONS)
  } catch (err) {
    console.error(`cannot resume: ${err.message}`)
    process.exit(1)
  }
  console.log(
    `resuming ${existing.mode} run from ${existing.started_at} — ` +
      `${existing.completed.length} location(s) already done, ${existing.findings.length} finding(s) so far\n`,
  )
} else if (existsSync(PROGRESS_PATH)) {
  console.error(
    `a checkpoint already exists at ${PROGRESS_PATH}.\n` +
      `Pass --resume to continue it, or move/delete it to start fresh. ` +
      `Refusing to overwrite it — it may be the only record of a run that has already written.`,
  )
  process.exit(1)
}

// ── locations ─────────────────────────────────────────────────────────────
const { data: locationRows, error: locErr } = await sb
  .from('locations')
  .select('location_id, name, jobber_account_id, jobber_access_token, jobber_refresh_token, token_expiry')
if (locErr) {
  console.error(`could not read locations: ${locErr.message}`)
  process.exit(1)
}
const locById = new Map(locationRows.map((r) => [r.location_id, r]))
const locations = locationRows

// ── VALIDATE --location BEFORE ANY JOBBER WORK ────────────────────────────
// The Supabase read above is the only thing that has happened so far; no
// token has been fetched and no franchise account has been touched. A slug
// that names nothing this run would sweep stops here, loudly, naming what
// was expected — never a clean "0 locations in scope" that reads as success.
try {
  const targets = selectRequestedLocations(locations, {
    includePhilly: INCLUDE_PHILLY,
    only: ONLY_LOCATIONS,
  })
  if (ONLY_LOCATIONS.length) {
    console.log(`--location resolved to ${targets.length}: ${targets.map((t) => t.location_id).join(', ')}\n`)
  }
} catch (err) {
  console.error(`\n${err.message}\n`)
  process.exit(1)
}

// ── Jobber, read-only ─────────────────────────────────────────────────────
// Its own POST rather than jobberQueryThrottled, for ONE reason: that helper
// calls res.json() on whatever comes back, so an HTTP 429 (which Jobber serves
// as HTML) surfaces as a JSON parse error and is indistinguishable from a
// broken response. This sweep has to tell "wait" apart from "broken", so it
// reads the status itself. Endpoint, version header and token refresh are all
// still the app's — only the response handling differs.
const tokenCache = new Map()
async function tokenFor(locationId) {
  if (tokenCache.has(locationId)) return tokenCache.get(locationId)
  const row = locById.get(locationId)
  if (!row) throw new Error(`no location row for ${locationId}`)
  const token = await jobber.getValidJobberToken(row)
  tokenCache.set(locationId, token)
  return token
}

class HttpRateLimited extends Error {
  constructor(status, retryAfter) {
    super(`Jobber replied HTTP ${status}`)
    this.name = 'HttpRateLimited'
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function runQuery(locationId, query, variables) {
  const token = await tokenFor(locationId)
  const res = await fetch(jobber.JOBBER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': jobber.JOBBER_API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  })
  if (res.status === 429) throw new HttpRateLimited(res.status, res.headers.get('retry-after'))
  if (res.status === 401 || res.status === 403) {
    // The cached token has gone stale mid-run; drop it so the next attempt
    // refreshes rather than replaying a dead credential for the whole location.
    tokenCache.delete(locationId)
    throw new Error(`Jobber replied HTTP ${res.status} for ${locationId} (token rejected)`)
  }
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Jobber replied HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`)
  }
}

// ── Supabase ──────────────────────────────────────────────────────────────
async function loadLeads(locationId) {
  const out = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('leads')
      .select('id, jobber_client_id, address, city, state, zip, former_addresses')
      .eq('location_id', locationId)
      .not('jobber_client_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`leads read failed for ${locationId}: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return out
}

// THE ONLY WRITE. Two columns, and the primary address columns and
// jobber_property_id are absent by construction rather than by care taken —
// exactly as the webhook's drift write is built.
async function appendAddress(leadId, nextFormerAddresses) {
  const { error } = await sb
    .from('leads')
    .update({ former_addresses: nextFormerAddresses, updated_at: new Date().toISOString() })
    .eq('id', leadId)
  if (error) throw new Error(error.message)
}

// ── go ────────────────────────────────────────────────────────────────────
const deps = {
  runQuery,
  loadLeads,
  appendAddress,
  saveProgress: async (p) => saveProgressSync(p),
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => console.log(line),
}

const opts = {
  mode: MODE,
  includePhilly: INCLUDE_PHILLY,
  clientPage: CLIENT_PAGE,
  propertyPage: PROPERTY_PAGE,
  skipNearDuplicates: SKIP_NEAR_DUPLICATES,
  only: ONLY_LOCATIONS,
}

// The Philly case used to be handled here with its own message. It is not a
// special case any more: naming it without --include-philly simply means it is
// not in scope, which selectRequestedLocations already reports above — and
// reports better, because it names the flag that would allow it.
if (!INCLUDE_PHILLY) console.log(`${PHILLY_SLUG} is skipped (already current) — --include-philly to sweep it too\n`)

let progress = existing ?? emptyProgress(MODE, INCLUDE_PHILLY, deps.now(), ONLY_LOCATIONS)
let exitCode = 0
try {
  progress = await runBackfill(locations, deps, opts, existing)
} catch (err) {
  exitCode = 2
  console.error(`\nSTOPPED: ${err.message}`)
  console.error(`Progress is saved. Re-run with --resume${COMMIT ? ' --commit' : ''} to continue.\n`)
  if (existsSync(PROGRESS_PATH)) progress = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'))
}

console.log('\n' + formatReport(progress))
console.log(`\ncheckpoint: ${PROGRESS_PATH}`)

// The one number the first dry run could not give: how many of the
// would-creates are a second property rather than the same address written
// differently.
const t = totalCounts(progress)
if (progress.findings.length) {
  console.log(
    `\nof ${t.would_create} would-create: ` +
      `${t.would_create_new} genuinely new, ` +
      `${t.would_create_different_unit} a different unit in a building we already hold, ` +
      `${t.would_create_near_duplicate} near-duplicates of an address already on the card.`,
  )
  if (SKIP_NEAR_DUPLICATES) {
    console.log(
      `--skip-near-duplicates left ${t.near_duplicates_skipped_by_flag} of them behind. ` +
        `They are still listed above, marked [WOULD BE SKIPPED]. ` +
        `The ${t.would_create_different_unit} different-unit rows were NOT skipped — they are real second properties.`,
    )
  } else {
    console.log(
      'NOTE: --commit writes ALL of them, near-duplicates included. ' +
        'Pass --skip-near-duplicates to leave those out.',
    )
  }
}
if (MODE === 'dry-run' && progress.findings.length) {
  console.log('\nReview the list above. If it looks right, re-run the same command with --commit.')
}
process.exit(exitCode)
