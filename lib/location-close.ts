// lib/location-close.ts
// ─────────────────────────────────────────────────────────────
// CLOSE A LOCATION (29 Oct 2026). A franchise shuts down: retire the hive,
// hand its zips back, and send its clients to Other so a future franchise in
// that territory can pick them up.
//
// NOT A DELETE. A delete is impossible (six tables refuse it: leads,
// engagements, touchpoints, lead_notes, lead_contacts → NO ACTION;
// email_accounts → RESTRICT) and, if forced, destructive: twelve tables are
// ON DELETE CASCADE, billing_invoices and subscription_seats among them — the
// record of what the franchisee was billed and paid. Closing deletes nothing
// but the location's own location_zips rows (the territory), and those are
// copied onto close_record first.
//
// Kevin's decisions, not to be re-opened here:
//   · its clients go to Other (loc_other), not to a neighbour, not frozen
//   · nothing is deleted, and closing is reversible (reopenLocation)
//
// THE TRAP: one location is referenced FOUR ways, not three. LOCATION_REFERENCES
// below is every column in the database that points at a location, checked
// against production on 29 Oct 2026, with what close does to each:
//   · text holding the SLUG ('loc_kc')        — leads, quotes, jobs, …
//   · uuid                                     — engagements, touchpoints, …
//   · text holding the UUID (no FK, no type)   — hub_users, notification
//     externals/prefs, project-type senders. hub_users.location_id is NOT the
//     slug: 60 of 60 rows hold the uuid as text.
// leads carries two (slug + uuid). They are moved in ONE update statement, so
// a lead can never be half-moved; preflight refuses to start if any lead is
// already diverged.
//
// DRY RUN FIRST. planLocationClose reads and counts exactly what closeLocation
// would write, through the same filters (stepQueries), so the two cannot
// disagree. closeLocation re-runs the plan as its preflight and refuses on any
// blocker. It is safe to run again on a closed location: every step is "the
// rows still pointing at the closed location", so a second run finishes what
// a failed first run left, and touches nothing the first one finished.
//
// ORDER IS LOAD-BEARING:
//   1. status → closed FIRST, so intake stops routing to it (zip routing
//      already sends anything not active/onboarding to Other as 'not_live';
//      intake's no-zip path checks 'closed' itself)
//   2. stop drips + cancel stage emails BEFORE the move: both are found
//      through the lead's location, which the move changes. Failure here
//      aborts before a single client moves.
//   3. release zips, 4. move clients, 5. people, 6. Jobber/Slack, 7. billing
// ─────────────────────────────────────────────────────────────

import { isSuperAdmin } from '@/lib/auth'

export const CLOSED_LIFECYCLE = 'closed'
export const OTHER_SLUG = 'loc_other'
// locations.id of Other in production. Checked against the row read by slug
// on every run — a mismatch is a blocker, never a guess.
export const OTHER_UUID = '7714e171-65ce-4be8-ba1d-d455cde2a6e9'

export function isClosedLocation(lifecycleStatus: string | null | undefined): boolean {
  return lifecycleStatus === CLOSED_LIFECYCLE
}

// ── The enumeration ───────────────────────────────────────────

// How the column holds the location.
//   slug       text, locations.location_id ('loc_kc')
//   uuid       uuid, locations.id
//   uuid_text  text holding locations.id — no FK, nothing protects it
export type RefForm = 'slug' | 'uuid' | 'uuid_text'

// What close does to the rows that point at the closing location.
//   move     → re-pointed at Other (client data)
//   release  → deleted (the territory only; copied to close_record first)
//   disable  → rows kept, switched off (people, invites, Gmail sync)
//   end      → rows kept, marked ended (seats)
//   keep     → untouched: the location's own setup, kept for a reopen
//   history  → untouched: logs and money records, never rewritten
export type CloseAction = 'move' | 'release' | 'disable' | 'end' | 'keep' | 'history'

// The FK's ON DELETE rule in production, or 'none' (no FK at all).
export type FkRule = 'cascade' | 'no_action' | 'restrict' | 'set_null' | 'none'

export type LocationRef = {
  table: string
  column: string
  form: RefForm
  fk: FkRule
  action: CloseAction
  why: string
}

export const LOCATION_REFERENCES: readonly LocationRef[] = [
  // ── client data → Other ──
  { table: 'leads', column: 'location_id', form: 'slug', fk: 'none', action: 'move', why: 'the client; moved in the same statement as location_uuid' },
  { table: 'leads', column: 'location_uuid', form: 'uuid', fk: 'no_action', action: 'move', why: 'the client; moved in the same statement as location_id' },
  { table: 'engagements', column: 'location_uuid', form: 'uuid', fk: 'no_action', action: 'move', why: 'the client\'s work and its totals' },
  { table: 'touchpoints', column: 'location_uuid', form: 'uuid', fk: 'no_action', action: 'move', why: 'timeline; corporate\'s per-location load reads it by location' },
  { table: 'lead_notes', column: 'location_uuid', form: 'uuid', fk: 'no_action', action: 'move', why: 'notes; read by location' },
  { table: 'lead_contacts', column: 'location_uuid', form: 'uuid', fk: 'no_action', action: 'move', why: 'extra contacts; read by location' },
  { table: 'quotes', column: 'location_id', form: 'slug', fk: 'none', action: 'move', why: 'Jobber record; read by slug' },
  { table: 'jobs', column: 'location_id', form: 'slug', fk: 'none', action: 'move', why: 'Jobber record; read by slug' },
  { table: 'invoices', column: 'location_id', form: 'slug', fk: 'none', action: 'move', why: 'Jobber record; read by slug' },
  { table: 'payments', column: 'location_id', form: 'slug', fk: 'none', action: 'move', why: 'Jobber record (0 rows today)' },
  { table: 'service_requests', column: 'location_id', form: 'slug', fk: 'none', action: 'move', why: 'Jobber record; read by slug' },
  { table: 'assessments', column: 'location_id', form: 'slug', fk: 'none', action: 'move', why: 'Jobber record; read by slug' },
  { table: 'job_visits', column: 'location_id', form: 'slug', fk: 'none', action: 'move', why: 'Jobber record (0 rows today)' },
  { table: 'notes', column: 'location_id', form: 'slug', fk: 'none', action: 'move', why: 'Jobber notes (0 rows today)' },

  // ── territory ──
  { table: 'location_zips', column: 'location_uuid', form: 'uuid', fk: 'cascade', action: 'release', why: 'a zip with no row routes to Other; the list is copied to close_record first' },

  // ── people ──
  { table: 'hub_users', column: 'location_id', form: 'uuid_text', fk: 'none', action: 'disable', why: 'disabled_at set + auth banned; never deleted; reopen re-enables exactly these' },
  { table: 'pending_invites', column: 'location_id', form: 'uuid', fk: 'cascade', action: 'disable', why: 'unaccepted, unexpired invites expire now, so nobody joins a closed hive' },
  { table: 'email_accounts', column: 'location_id', form: 'uuid', fk: 'restrict', action: 'disable', why: 'Gmail sync switched off' },

  // ── billing ──
  { table: 'subscription_seats', column: 'location_id', form: 'uuid', fk: 'cascade', action: 'end', why: 'active seats → inactive + removed_at; no row deleted' },
  { table: 'billing_invoices', column: 'location_id', form: 'uuid', fk: 'cascade', action: 'history', why: 'what was billed and paid; no status column to mark; never touched' },
  { table: 'stripe_webhook_events', column: 'location_id', form: 'uuid', fk: 'set_null', action: 'history', why: 'Stripe event log' },

  // ── the location's own setup, kept for a reopen ──
  { table: 'templates', column: 'location_uuid', form: 'uuid', fk: 'cascade', action: 'keep', why: 'its email templates' },
  { table: 'drip_paths', column: 'location_uuid', form: 'uuid', fk: 'cascade', action: 'keep', why: 'its drip paths (every live drip on its clients is stopped separately)' },
  { table: 'lookups', column: 'location_id', form: 'uuid', fk: 'cascade', action: 'keep', why: 'its location tags (still attached to moved clients via lead_tags)' },
  { table: 'onboarding_progress', column: 'location_id', form: 'uuid', fk: 'cascade', action: 'keep', why: 'onboarding history' },
  { table: 'companies', column: 'location_id', form: 'uuid', fk: 'cascade', action: 'keep', why: 'its referral network — not clients' },
  { table: 'partners', column: 'location_id', form: 'uuid', fk: 'cascade', action: 'keep', why: 'its referral network — not clients' },
  { table: 'reminders', column: 'location_uuid', form: 'uuid', fk: 'cascade', action: 'keep', why: 'a disabled person\'s own to-do list; back with them on reopen' },
  { table: 'slack_cards', column: 'location_uuid', form: 'uuid', fk: 'cascade', action: 'keep', why: 'only Other\'s channel ever has cards (59 of 59); a franchise has none to retire' },
  { table: 'lead_notification_externals', column: 'location_id', form: 'uuid_text', fk: 'none', action: 'keep', why: 'non-login recipients; silenced by notifications_live=false' },
  { table: 'lead_notification_prefs', column: 'location_id', form: 'uuid_text', fk: 'none', action: 'keep', why: 'per-user notification settings' },
  { table: 'location_project_type_senders', column: 'location_id', form: 'uuid_text', fk: 'none', action: 'keep', why: 'per-project-type sender setup' },
  { table: 'location_jobber_users', column: 'location_id', form: 'slug', fk: 'none', action: 'keep', why: 'Jobber roster cache (0 rows today)' },

  // ── logs, never rewritten ──
  { table: 'sync_log', column: 'location_id', form: 'slug', fk: 'none', action: 'history', why: 'sync history' },
  { table: 'notification_log', column: 'location_id', form: 'uuid', fk: 'set_null', action: 'history', why: 'what was sent, and to whom' },
  { table: 'notification_log', column: 'location_slug', form: 'slug', fk: 'none', action: 'history', why: 'same row, slug copy' },
  { table: 'feedback_items', column: 'location_id', form: 'uuid', fk: 'set_null', action: 'history', why: 'owner feedback' },
  { table: 'feedback_deletions', column: 'location_id', form: 'uuid', fk: 'set_null', action: 'history', why: 'feedback audit' },
  { table: 'tag_deletions', column: 'location_id', form: 'uuid', fk: 'none', action: 'history', why: 'tag audit' },
  { table: 'import_jobs', column: 'location_id', form: 'slug', fk: 'none', action: 'history', why: 'import history; a RUNNING import blocks the close' },
  { table: 'import_staging', column: 'location_id', form: 'slug', fk: 'none', action: 'history', why: 'import scratch (0 rows today)' },
  { table: 'import_location_fetch', column: 'location_id', form: 'slug', fk: 'none', action: 'history', why: 'import scratch (0 rows today)' },
  { table: 'jobber_oauth_states', column: 'location_id', form: 'slug', fk: 'none', action: 'history', why: 'short-lived OAuth handshakes' },
]

// Tables with NO location column that still hang off a client. They follow
// the lead by lead_id, so the move needs nothing from them — except the two
// that send email, which are stopped before the move.
export const LEAD_KEYED_TABLES: readonly { table: string; on_close: string }[] = [
  { table: 'lead_drip_progress', on_close: "live rows stopped (stopped_at; stopped_reason 'location_closed')" },
  { table: 'scheduled_stage_emails', on_close: "unsent rows cancelled (cancelled_at; cancelled_reason 'location_closed')" },
  { table: 'lead_assignees', on_close: 'kept: the closed location\'s people stay named on the client, as on a reopen' },
  { table: 'lead_tags', on_close: 'kept' },
  { table: 'email_threads', on_close: 'kept' },
]

// 'location_closed' (Kevin, 29 Oct 2026). No existing reason fitted: each is
// about the CLIENT (stage_changed, junk, closed_lost, opted_out …) and would
// lie. Nothing branches on stopped_reason / cancelled_reason. The client's
// Preferences block shows its generic copy for a value it has no words for;
// the legacy drip panel prints the raw word. stopped_at / cancelled_at equal
// close_record.closed_at.
export const DRIP_STOP_REASON = 'location_closed'
export const STAGE_CANCEL_REASON = 'location_closed'

// ── Types ─────────────────────────────────────────────────────

export type Db = { from: (table: string) => any }

export type CloseLocationRow = {
  id: string
  name: string
  location_id: string
  lifecycle_status: string | null
  notifications_live: boolean | null
  jobber_account_id: string | null
  stripe_subscription_id: string | null
  subscription_status: string | null
  close_record: CloseRecord | null
}

export type CloseRecord = {
  closed_at: string
  closed_by: string
  from_status: string | null
  notifications_live: boolean | null
  jobber_account_id: string | null
  stripe_subscription_id: string | null
  released_zips: string[]
  counts?: CloseCounts
  stripe?: string
  reopened_at?: string | null
  reopened_by?: string | null
}

export type CloseCounts = {
  zips_released: number
  moved: Record<string, number>
  drips_stopped: number
  stage_emails_cancelled: number
  users_disabled: number
  invites_expired: number
  gmail_accounts_paused: number
  seats_ended: number
}

export type ClosePlan = {
  location: { id: string; name: string; slug: string; lifecycle_status: string | null }
  already_closed: boolean
  blockers: string[]
  counts: CloseCounts
  // Facts for the person deciding, none of which is written:
  facts: {
    released_zips: string[]
    leads_joining_other_queue: number   // active (not junk, not archived) → Leslie's "Not yet routed"
    billing_invoices_kept: number
    seats_kept_total: number
    stripe_subscription_id: string | null
    jobber_connected_account: string | null
  }
}

export type CloseDeps = {
  now?: () => string
  // Cancel the Stripe subscription. Resolves to a short outcome word; throws
  // on a real failure. Injected so tests never reach Stripe.
  cancelStripeSubscription?: (subscriptionId: string) => Promise<string>
  // Supabase auth ban/unban — belt-and-braces, as Remove access does.
  setAuthBan?: (userId: string, banned: boolean) => Promise<boolean>
}

// ── Reading ───────────────────────────────────────────────────

const LOCATION_COLS =
  'id, name, location_id, lifecycle_status, notifications_live, jobber_account_id, stripe_subscription_id, subscription_status, close_record'

const ID_CHUNK = 200
const PAGE = 1000

function emptyCounts(): CloseCounts {
  return {
    zips_released: 0,
    moved: {},
    drips_stopped: 0,
    stage_emails_cancelled: 0,
    users_disabled: 0,
    invites_expired: 0,
    gmail_accounts_paused: 0,
    seats_ended: 0,
  }
}

// The value a column holds for this location, by its form.
export function refValue(form: RefForm, loc: { id: string; location_id: string }): string {
  return form === 'slug' ? loc.location_id : loc.id
}

// The tables whose rows move, grouped so a table with two location columns
// (leads) moves both in ONE statement. The first column is the filter.
export function moveGroups(): { table: string; refs: LocationRef[] }[] {
  const groups = new Map<string, LocationRef[]>()
  for (const r of LOCATION_REFERENCES) {
    if (r.action !== 'move') continue
    groups.set(r.table, [...(groups.get(r.table) || []), r])
  }
  // Children first, leads last: if a run stops part-way the client is still
  // findable at the closed location, and a re-run picks the rest up.
  return Array.from(groups.entries())
    .map(([table, refs]) => ({ table, refs }))
    .sort((a, b) => (a.table === 'leads' ? 1 : 0) - (b.table === 'leads' ? 1 : 0))
}

async function countRows(q: any): Promise<number> {
  const { count, error } = await q
  if (error) throw new Error(error.message)
  return count ?? 0
}

async function leadIdsAt(db: Db, loc: { id: string }): Promise<string[]> {
  const ids: string[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('leads')
      .select('id')
      .eq('location_uuid', loc.id)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`leads read failed: ${error.message}`)
    ids.push(...(data || []).map((r: any) => r.id))
    if (!data || data.length < PAGE) return ids
  }
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

// ── The steps' filters — shared by the dry run and the real run ──
// Each takes a query builder already pointed at the table (a count-select in
// the dry run, an update in the real run) and adds the SAME filters.

export const stepQueries = {
  zips: (q: any, loc: CloseLocationRow) => q.eq('location_uuid', loc.id),
  move: (q: any, ref: LocationRef, loc: CloseLocationRow) => q.eq(ref.column, refValue(ref.form, loc)),
  drips: (q: any, leadIds: string[]) =>
    q.in('lead_id', leadIds).is('stopped_at', null).is('completed_at', null),
  stageEmails: (q: any, leadIds: string[]) =>
    q.in('lead_id', leadIds).is('sent_at', null).is('cancelled_at', null),
  users: (q: any, loc: CloseLocationRow) => q.eq('location_id', loc.id).is('disabled_at', null),
  invites: (q: any, loc: CloseLocationRow, nowIso: string) =>
    q.eq('location_id', loc.id).is('accepted_at', null).gt('invite_expires_at', nowIso),
  gmail: (q: any, loc: CloseLocationRow) => q.eq('location_id', loc.id).eq('sync_enabled', true),
  seats: (q: any, loc: CloseLocationRow) => q.eq('location_id', loc.id).eq('status', 'active'),
}

async function readLocation(db: Db, locationId: string): Promise<CloseLocationRow | null> {
  const { data, error } = await db.from('locations').select(LOCATION_COLS).eq('id', locationId).maybeSingle()
  if (error) throw new Error(`location read failed: ${error.message}`)
  return (data as CloseLocationRow) ?? null
}

async function readOther(db: Db): Promise<{ id: string; location_id: string } | null> {
  const { data, error } = await db.from('locations').select('id, location_id').eq('location_id', OTHER_SLUG).maybeSingle()
  if (error) throw new Error(`Other read failed: ${error.message}`)
  return (data as any) ?? null
}

// Unique indexes that include location_id: moving a row whose Jobber id
// already sits at Other would fail mid-run. Counted up front instead.
const JOBBER_UNIQUE: { table: string; column: string; partial?: boolean }[] = [
  { table: 'leads', column: 'jobber_client_id', partial: true },
  { table: 'quotes', column: 'jobber_quote_id' },
  { table: 'jobs', column: 'jobber_job_id' },
  { table: 'invoices', column: 'jobber_invoice_id' },
  { table: 'service_requests', column: 'jobber_request_id' },
]

async function readColumnValues(db: Db, table: string, column: string, slug: string): Promise<string[]> {
  const out: string[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select(column)
      .eq('location_id', slug)
      .not(column, 'is', null)
      .order(column, { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}.${column} read failed: ${error.message}`)
    out.push(...(data || []).map((r: any) => String(r[column])))
    if (!data || data.length < PAGE) return out
  }
}

// ── Dry run ───────────────────────────────────────────────────

// Reads only. Every count here is what closeLocation will write, by the same
// filters. Blockers stop a real close; the dry run still reports them.
export async function planLocationClose(db: Db, locationId: string, deps: CloseDeps = {}): Promise<ClosePlan | null> {
  const nowIso = (deps.now ?? (() => new Date().toISOString()))()
  const loc = await readLocation(db, locationId)
  if (!loc) return null

  const blockers: string[] = []
  const counts = emptyCounts()

  if (loc.location_id === OTHER_SLUG) blockers.push('Other cannot be closed: it is where closed clients go.')
  const other = await readOther(db)
  if (!other) blockers.push('Other (loc_other) was not found.')
  else if (other.id !== OTHER_UUID) blockers.push(`Other's id is ${other.id}, expected ${OTHER_UUID}.`)

  // A running Jobber import would keep writing clients to the closed slug.
  const running = await countRows(
    db.from('import_jobs').select('*', { count: 'exact', head: true }).eq('location_id', loc.location_id).eq('status', 'running'),
  )
  if (running > 0) blockers.push(`A Jobber import is running for this location (${running}). Wait for it to finish.`)

  // A lead whose two columns already disagree is half-moved; the close would
  // move one half. Refuse and say how many.
  const slugOnly = await countRows(
    db.from('leads').select('*', { count: 'exact', head: true }).eq('location_id', loc.location_id).neq('location_uuid', loc.id),
  )
  const uuidOnly = await countRows(
    db.from('leads').select('*', { count: 'exact', head: true }).eq('location_uuid', loc.id).neq('location_id', loc.location_id),
  )
  if (slugOnly + uuidOnly > 0) {
    blockers.push(`${slugOnly + uuidOnly} client(s) already point here in one column but not the other. Fix those first.`)
  }

  if (other && loc.location_id !== OTHER_SLUG) {
    for (const u of JOBBER_UNIQUE) {
      const mine = await readColumnValues(db, u.table, u.column, loc.location_id)
      let clash = 0
      for (const part of chunks(mine, ID_CHUNK)) {
        clash += await countRows(
          db.from(u.table).select('*', { count: 'exact', head: true }).eq('location_id', OTHER_SLUG).in(u.column, part),
        )
      }
      if (clash > 0) blockers.push(`${clash} ${u.table} row(s) share a Jobber id with a row already at Other; the move would fail.`)
    }
  }

  // Territory
  const { data: zipRows, error: zipErr } = await stepQueries.zips(db.from('location_zips').select('zip'), loc)
  if (zipErr) throw new Error(`location_zips read failed: ${zipErr.message}`)
  const releasedZips = Array.from(new Set(((zipRows || []) as any[]).map((r) => String(r.zip)))).sort()
  counts.zips_released = (zipRows || []).length

  // Clients
  for (const g of moveGroups()) {
    counts.moved[g.table] = await countRows(
      stepQueries.move(db.from(g.table).select('*', { count: 'exact', head: true }), g.refs[0], loc),
    )
  }
  const leadsJoiningQueue = await countRows(
    db.from('leads').select('*', { count: 'exact', head: true })
      .eq('location_uuid', loc.id).not('is_junk', 'is', true).is('archived_at', null),
  )

  // Sends, through the lead
  const leadIds = await leadIdsAt(db, loc)
  for (const part of chunks(leadIds, ID_CHUNK)) {
    counts.drips_stopped += await countRows(
      stepQueries.drips(db.from('lead_drip_progress').select('*', { count: 'exact', head: true }), part),
    )
    counts.stage_emails_cancelled += await countRows(
      stepQueries.stageEmails(db.from('scheduled_stage_emails').select('*', { count: 'exact', head: true }), part),
    )
  }

  // People
  counts.users_disabled = await countRows(stepQueries.users(db.from('hub_users').select('*', { count: 'exact', head: true }), loc))
  counts.invites_expired = await countRows(stepQueries.invites(db.from('pending_invites').select('*', { count: 'exact', head: true }), loc, nowIso))
  counts.gmail_accounts_paused = await countRows(stepQueries.gmail(db.from('email_accounts').select('*', { count: 'exact', head: true }), loc))

  // Billing
  counts.seats_ended = await countRows(stepQueries.seats(db.from('subscription_seats').select('*', { count: 'exact', head: true }), loc))
  const seatsTotal = await countRows(db.from('subscription_seats').select('*', { count: 'exact', head: true }).eq('location_id', loc.id))
  const invoicesKept = await countRows(db.from('billing_invoices').select('*', { count: 'exact', head: true }).eq('location_id', loc.id))

  return {
    location: { id: loc.id, name: loc.name, slug: loc.location_id, lifecycle_status: loc.lifecycle_status },
    already_closed: isClosedLocation(loc.lifecycle_status),
    blockers,
    counts,
    facts: {
      released_zips: releasedZips,
      leads_joining_other_queue: leadsJoiningQueue,
      billing_invoices_kept: invoicesKept,
      seats_kept_total: seatsTotal,
      stripe_subscription_id: loc.stripe_subscription_id,
      jobber_connected_account: loc.jobber_account_id,
    },
  }
}

// ── Gate ──────────────────────────────────────────────────────

// The typed name must match the location's name (trimmed, any case). Not the
// slug: a person reads the name on the sheet they are looking at.
export function confirmationMatches(typed: unknown, locationName: string): boolean {
  return typeof typed === 'string' && typed.trim().toLowerCase() === locationName.trim().toLowerCase() && typed.trim() !== ''
}

export type CloseGateRejection = { status: number; error: string }

export function checkCloseGate(role: string | null | undefined): CloseGateRejection | null {
  if (!role || !isSuperAdmin(role)) return { status: 403, error: 'forbidden_super_admin_only' }
  return null
}

// ── The real run ──────────────────────────────────────────────

export type CloseResult = {
  status: number
  body: {
    mode: 'dry_run' | 'close'
    plan?: ClosePlan
    done?: CloseCounts
    stripe?: string
    warnings?: string[]
    error?: string
    detail?: string
  }
}

export async function closeLocation(
  db: Db,
  args: { locationId: string; actor: { hubUserId: string; role: string }; confirmName?: unknown; dryRun: boolean },
  deps: CloseDeps = {},
): Promise<CloseResult> {
  const mode = args.dryRun ? 'dry_run' : 'close'
  const gate = checkCloseGate(args.actor.role)
  if (gate) return { status: gate.status, body: { mode, error: gate.error } }

  const nowIso = (deps.now ?? (() => new Date().toISOString()))()
  const plan = await planLocationClose(db, args.locationId, { ...deps, now: () => nowIso })
  if (!plan) return { status: 404, body: { mode, error: 'location_not_found' } }
  if (args.dryRun) return { status: 200, body: { mode, plan } }

  if (!confirmationMatches(args.confirmName, plan.location.name)) {
    return { status: 400, body: { mode, plan, error: 'confirmation_mismatch', detail: `Type the location's name, "${plan.location.name}", to close it.` } }
  }
  if (plan.blockers.length) return { status: 409, body: { mode, plan, error: 'blocked' } }

  const loc = (await readLocation(db, args.locationId))!
  const warnings: string[] = []
  const done = emptyCounts()

  // 1. Status first. A re-run keeps the first run's record (its closed_at is
  //    what reopen matches users by) and only adds zips it hadn't seen.
  const prior = loc.close_record && isClosedLocation(loc.lifecycle_status) ? loc.close_record : null
  const record: CloseRecord = prior
    ? { ...prior, released_zips: Array.from(new Set([...(prior.released_zips || []), ...plan.facts.released_zips])).sort() }
    : {
        closed_at: nowIso,
        closed_by: args.actor.hubUserId,
        from_status: loc.lifecycle_status,
        notifications_live: loc.notifications_live,
        jobber_account_id: loc.jobber_account_id,
        stripe_subscription_id: loc.stripe_subscription_id,
        released_zips: plan.facts.released_zips,
        reopened_at: null,
        reopened_by: null,
      }
  const closedAt = record.closed_at
  {
    const { error } = await db
      .from('locations')
      .update({ lifecycle_status: CLOSED_LIFECYCLE, notifications_live: false, close_record: record, updated_at: nowIso })
      .eq('id', loc.id)
    if (error) return { status: 500, body: { mode, plan, error: 'status_write_failed', detail: error.message } }
  }

  // 2. Stop what sends, BEFORE the move (found through the lead's location).
  try {
    const leadIds = await leadIdsAt(db, loc)
    for (const part of chunks(leadIds, ID_CHUNK)) {
      const d = await stepQueries.drips(
        db.from('lead_drip_progress').update({ stopped_at: closedAt, stopped_reason: DRIP_STOP_REASON }, { count: 'exact' }),
        part,
      )
      if (d.error) throw new Error(`drip stop: ${d.error.message}`)
      done.drips_stopped += d.count ?? 0
      const s = await stepQueries.stageEmails(
        db.from('scheduled_stage_emails').update({ cancelled_at: closedAt, cancelled_reason: STAGE_CANCEL_REASON }, { count: 'exact' }),
        part,
      )
      if (s.error) throw new Error(`stage email cancel: ${s.error.message}`)
      done.stage_emails_cancelled += s.count ?? 0
    }
  } catch (err: any) {
    return { status: 500, body: { mode, plan, done, error: 'stop_sends_failed', detail: `${err?.message || err} — no client was moved. Run the close again.` } }
  }

  // 3. Territory.
  {
    const { count, error } = await stepQueries.zips(db.from('location_zips').delete({ count: 'exact' }), loc)
    if (error) return { status: 500, body: { mode, plan, done, error: 'zip_release_failed', detail: error.message } }
    done.zips_released = count ?? 0
  }

  // 4. Clients → Other, every reference style, one statement per table.
  for (const g of moveGroups()) {
    const patch: Record<string, string> = {}
    for (const r of g.refs) patch[r.column] = r.form === 'slug' ? OTHER_SLUG : OTHER_UUID
    const { count, error } = await stepQueries.move(db.from(g.table).update(patch, { count: 'exact' }), g.refs[0], loc)
    if (error) {
      return { status: 500, body: { mode, plan, done, error: 'move_failed', detail: `${g.table}: ${error.message} — run the close again to finish.` } }
    }
    done.moved[g.table] = count ?? 0
  }

  // 5. People. Disabled with the close's own timestamp, so reopen re-enables
  //    exactly these and nobody who was removed for another reason.
  {
    const { data: users, error: readErr } = await stepQueries.users(db.from('hub_users').select('id'), loc)
    if (readErr) warnings.push(`users_read_failed: ${readErr.message}`)
    const { count, error } = await stepQueries.users(
      db.from('hub_users').update({ disabled_at: closedAt, disabled_by: record.closed_by }, { count: 'exact' }),
      loc,
    )
    if (error) warnings.push(`users_disable_failed: ${error.message}`)
    else done.users_disabled = count ?? 0
    if (!error && deps.setAuthBan) {
      for (const u of (users || []) as any[]) {
        if (!(await deps.setAuthBan(u.id, true))) warnings.push(`auth_ban_failed: ${u.id}`)
      }
    }
  }
  {
    const { count, error } = await stepQueries.invites(
      db.from('pending_invites').update({ invite_expires_at: nowIso }, { count: 'exact' }),
      loc,
      nowIso,
    )
    if (error) warnings.push(`invites_expire_failed: ${error.message}`)
    else done.invites_expired = count ?? 0
  }
  {
    const { count, error } = await stepQueries.gmail(
      db.from('email_accounts').update({ sync_enabled: false, updated_at: nowIso }, { count: 'exact' }),
      loc,
    )
    if (error) warnings.push(`gmail_pause_failed: ${error.message}`)
    else done.gmail_accounts_paused = count ?? 0
  }

  // 6. Jobber + Slack. Same columns as lib/jobber-disconnect and
  //    lib/slack-disconnect, plus jobber_account_id: the Jobber webhook finds
  //    its location by that id, so leaving it would keep Jobber's events
  //    landing on a closed hive. It is kept on close_record.
  {
    const { error } = await db
      .from('locations')
      .update({
        jobber_connected: false,
        jobber_access_token: null,
        jobber_refresh_token: null,
        token_expiry: null,
        token_expiry_display: null,
        jobber_account_name: null,
        jobber_team_roster: null,
        jobber_team_roster_synced_at: null,
        jobber_initial_import_completed_at: null,
        jobber_account_id: null,
        last_sync_status: `Disconnected — location closed ${closedAt}`,
        slack_connected: false,
        slack_bot_token: null,
        slack_team_id: null,
        slack_team_name: null,
        slack_channel_id: null,
        slack_channel_name: null,
        updated_at: nowIso,
      })
      .eq('id', loc.id)
    if (error) warnings.push(`jobber_slack_disconnect_failed: ${error.message}`)
  }

  // 7. Billing. Seats are ended, never deleted. billing_invoices is not
  //    touched at all.
  {
    const { count, error } = await stepQueries.seats(
      db.from('subscription_seats').update({ status: 'inactive', removed_at: closedAt, updated_at: nowIso }, { count: 'exact' }),
      loc,
    )
    if (error) warnings.push(`seats_end_failed: ${error.message}`)
    else done.seats_ended = count ?? 0
  }
  let stripe = 'no_subscription'
  const subId = loc.stripe_subscription_id
  if (subId && loc.subscription_status !== 'canceled') {
    if (!deps.cancelStripeSubscription) {
      stripe = 'not_attempted'
      warnings.push(`stripe_not_cancelled: ${subId} — cancel it in Stripe by hand`)
    } else {
      try {
        stripe = await deps.cancelStripeSubscription(subId)
        const { error } = await db.from('locations').update({ subscription_status: 'canceled', updated_at: nowIso }).eq('id', loc.id)
        if (error) warnings.push(`subscription_status_write_failed: ${error.message}`)
      } catch (err: any) {
        stripe = 'failed'
        warnings.push(`stripe_cancel_failed: ${subId} — ${err?.message || err}. The franchisee is still being billed; cancel it in Stripe by hand.`)
      }
    }
  } else if (subId) {
    stripe = 'already_canceled'
  }

  // The record of what this run did.
  {
    const { error } = await db
      .from('locations')
      .update({ close_record: { ...record, counts: done, stripe } })
      .eq('id', loc.id)
    if (error) warnings.push(`close_record_write_failed: ${error.message}`)
  }

  return { status: 200, body: { mode, plan, done, stripe, warnings } }
}

// ── Reopen ────────────────────────────────────────────────────

// What reopen does: lifecycle back to what it was, notifications_live back,
// and the people the close disabled re-enabled (and unbanned).
// What it does NOT do — each is a deliberate, separate step:
//   · pull clients back from Other (route them one by one, or by hand)
//   · re-add zips (close_record.released_zips lists them; another franchise
//     may hold them by now)
//   · reconnect Jobber or Slack (the owner reconnects; tokens are gone)
//   · restart Stripe or re-add seats (billing is never restarted silently)
//   · restart drips or stage emails, un-expire invites, resume Gmail sync
export type ReopenPlan = {
  location: { id: string; name: string; slug: string }
  restore_status: string
  restore_notifications_live: boolean
  users_reenabled: number
  released_zips: string[]
  blockers: string[]
}

function reopenUsersQuery(q: any, loc: CloseLocationRow, rec: CloseRecord) {
  return q.eq('location_id', loc.id).eq('disabled_at', rec.closed_at).eq('disabled_by', rec.closed_by)
}

export async function reopenLocation(
  db: Db,
  args: { locationId: string; actor: { hubUserId: string; role: string }; confirmName?: unknown; dryRun: boolean },
  deps: CloseDeps = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const mode = args.dryRun ? 'dry_run' : 'reopen'
  const gate = checkCloseGate(args.actor.role)
  if (gate) return { status: gate.status, body: { mode, error: gate.error } }
  const nowIso = (deps.now ?? (() => new Date().toISOString()))()

  const loc = await readLocation(db, args.locationId)
  if (!loc) return { status: 404, body: { mode, error: 'location_not_found' } }
  const rec = loc.close_record
  const blockers: string[] = []
  if (!isClosedLocation(loc.lifecycle_status)) blockers.push('This location is not closed.')
  if (!rec) blockers.push('No close record on this location — it was not closed by Bee Hub.')

  const users = rec
    ? await countRows(reopenUsersQuery(db.from('hub_users').select('*', { count: 'exact', head: true }), loc, rec))
    : 0
  const plan: ReopenPlan = {
    location: { id: loc.id, name: loc.name, slug: loc.location_id },
    restore_status: rec?.from_status || 'onboarding',
    restore_notifications_live: rec?.notifications_live === true,
    users_reenabled: users,
    released_zips: rec?.released_zips || [],
    blockers,
  }
  if (args.dryRun) return { status: 200, body: { mode, plan } }
  if (!confirmationMatches(args.confirmName, loc.name)) {
    return { status: 400, body: { mode, plan, error: 'confirmation_mismatch', detail: `Type the location's name, "${loc.name}", to reopen it.` } }
  }
  if (blockers.length || !rec) return { status: 409, body: { mode, plan, error: 'blocked' } }

  const warnings: string[] = []
  const { data: toRestore } = await reopenUsersQuery(db.from('hub_users').select('id'), loc, rec)
  const { count, error: userErr } = await reopenUsersQuery(
    db.from('hub_users').update({ disabled_at: null, disabled_by: null }, { count: 'exact' }),
    loc,
    rec,
  )
  if (userErr) return { status: 500, body: { mode, plan, error: 'users_restore_failed', detail: userErr.message } }
  if (deps.setAuthBan) {
    for (const u of (toRestore || []) as any[]) {
      if (!(await deps.setAuthBan(u.id, false))) warnings.push(`auth_unban_failed: ${u.id}`)
    }
  }
  const { error } = await db
    .from('locations')
    .update({
      lifecycle_status: plan.restore_status,
      notifications_live: plan.restore_notifications_live,
      close_record: { ...rec, reopened_at: nowIso, reopened_by: args.actor.hubUserId },
      updated_at: nowIso,
    })
    .eq('id', loc.id)
  if (error) return { status: 500, body: { mode, plan, error: 'status_restore_failed', detail: error.message } }

  return { status: 200, body: { mode, plan, users_reenabled: count ?? 0, warnings } }
}
