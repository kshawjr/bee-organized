// ═══════════════════════════════════════════════════════════════════════════
// POST OTHER'S ROUTE-SUGGESTION CARDS for leads ALREADY in Other.
// HELD. KEVIN RUNS THIS. DRY RUN BY DEFAULT: it lists each lead it would post
// and exactly what its card would say, and posts nothing. --commit to post.
//
// WHY. The card posts only at intake, so the leads that were in Other before
// Other was connected to Slack (20 Oct 2026) never had one — Leslie's backlog
// is invisible in #lead_transfers. This posts them through the SAME
// notifyNewLeadSlack + logSlackNotification intake uses, so the card, the
// buttons and the log row are exactly what a new lead gets.
//
// THE RULES are lib/other-card-backlog.ts planBacklog (the tests pin them):
//   · only leads still OPEN in Other, by Bee Hub's own Needs-transfer test:
//     not binned, archived, dismissed or snoozed — and not already sent the
//     no-coverage email, and movable (no engagement, nothing in Jobber)
//   · oldest first
//   · a lead that already has a posted card is skipped — running this twice
//     never double-posts. --again (with --lead only) re-posts one on purpose.
//   · --all leaves out test records (first or last name exactly "test");
//     --lead posts the named lead whatever its name.
//
// WHAT IT WILL NOT DO:
//   · post anything without --commit
//   · post the whole backlog with --again
//   · touch the lead: posting a card writes only the notification_log row
//
// Usage:
//   node scripts/post-other-cards.mjs --lead <id>                    # dry run, one lead
//   node scripts/post-other-cards.mjs --lead <id> --commit           # post it
//   node scripts/post-other-cards.mjs --lead <id> --again --commit   # post it again
//   node scripts/post-other-cards.mjs --all                          # dry run, the backlog
//   node scripts/post-other-cards.mjs --all --commit                 # post the backlog
//   --base-url <url>   the Open in Bee Hub link (default: NEXT_PUBLIC_APP_URL,
//                      NEXT_PUBLIC_SITE_URL, then https://beehive.beeorganized.com)
//   --env <path>       default .env.local
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installTsResolver } from './ts-alias-hook.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolvePath(HERE, '..')

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const val = (k, d = null) => {
  const withEq = argv.find((a) => a.startsWith(k + '='))
  if (withEq) return withEq.slice(k.length + 1)
  const i = argv.indexOf(k)
  return i > -1 && argv[i + 1] ? argv[i + 1] : d
}
const COMMIT = has('--commit')
const ALL = has('--all')
const AGAIN = has('--again')
const ONLY = val('--lead')

if (!!ALL === !!ONLY) {
  console.error('Give exactly one of --lead <id> or --all. See the header of this script.')
  process.exit(2)
}
if (AGAIN && !ONLY) {
  console.error('--again needs --lead: it re-posts one named lead, never the whole backlog.')
  process.exit(2)
}

const envPath = resolvePath(ROOT, val('--env', '.env.local'))
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const BASE_URL = (val('--base-url') || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://beehive.beeorganized.com').replace(/\/$/, '')

installTsResolver(ROOT)
const { planBacklog, OTHER_SLUG } = await import(pathToFileURL(ROOT + '/lib/other-card-backlog.ts').href)
const { suggestRouteForLead } = await import(pathToFileURL(ROOT + '/lib/route-suggestion.ts').href)
const { suggestionHeadline } = await import(pathToFileURL(ROOT + '/lib/route-suggestion-slack.ts').href)
const { notifyNewLeadSlack } = await import(pathToFileURL(ROOT + '/lib/slack-bot.ts').href)
const { logSlackNotification } = await import(pathToFileURL(ROOT + '/lib/notification-log.ts').href)
const { supabaseService: sb } = await import(pathToFileURL(ROOT + '/lib/supabase-service.ts').href)

// ── Other itself ─────────────────────────────────────────────────────────────
const { data: other, error: otherErr } = await sb
  .from('locations')
  .select('id, name, location_id, slack_connected, slack_channel_name')
  .eq('location_id', OTHER_SLUG)
  .maybeSingle()
if (otherErr || !other) { console.error(`REFUSING: could not read Other (${otherErr?.message || 'not found'})`); process.exit(1) }
if (!other.slack_connected) { console.error('REFUSING: Other is not connected to Slack.'); process.exit(1) }

// ── the leads (a handful; Other never holds 1,000) ───────────────────────────
const cols = 'id, name, first_name, last_name, email, phone, project_type, request_details, preferred_contact, source, address, city, state, zip, location_id, is_junk, created_at, archived_at, inbox_dismissed_at, snoozed_until, jobber_client_id, jobber_request_id, jobber_quote_id, jobber_job_id, jobber_invoice_id, jobber_assessment_id, jobber_sync_status'
const q = sb.from('leads').select(cols)
const { data: leads, error: leadErr } = ONLY ? await q.eq('id', ONLY) : await q.eq('location_id', OTHER_SLUG).order('created_at', { ascending: true }).limit(1000)
if (leadErr) { console.error(`REFUSING: lead read failed (${leadErr.message})`); process.exit(1) }
if (!ONLY && leads.length >= 1000) { console.error('REFUSING: 1,000 leads came back — the read may be cut off. Page it before posting.'); process.exit(1) }

// ── which already have a posted card ─────────────────────────────────────────
const ids = leads.map((l) => l.id)
const posted = new Set()
if (ids.length) {
  const { data: rows, error: logErr } = await sb
    .from('notification_log')
    .select('lead_id')
    .eq('channel', 'slack')
    .eq('location_slug', OTHER_SLUG)
    .eq('send_status', 'accepted')
    .in('lead_id', ids)
  if (logErr) { console.error(`REFUSING: could not check which cards were already posted (${logErr.message})`); process.exit(1) }
  for (const r of rows) posted.add(r.lead_id)
}

// ── what else resolves a lead: a no-coverage email, an engagement, Jobber ───
const noCoverage = new Set()
const engaged = new Set()
if (ids.length) {
  const { data: nc, error: ncErr } = await sb
    .from('notification_log')
    .select('lead_id')
    .eq('email_kind', 'no_coverage_optin')
    .eq('send_status', 'accepted')
    .in('lead_id', ids)
  if (ncErr) { console.error(`REFUSING: could not check for no-coverage emails (${ncErr.message})`); process.exit(1) }
  for (const r of nc) noCoverage.add(r.lead_id)
  const { data: eg, error: egErr } = await sb.from('engagements').select('client_id').in('client_id', ids)
  if (egErr) { console.error(`REFUSING: could not check engagements (${egErr.message})`); process.exit(1) }
  for (const r of eg) engaged.add(r.client_id)
}
const JOBBER_FIELDS = ['jobber_client_id', 'jobber_request_id', 'jobber_quote_id', 'jobber_job_id', 'jobber_invoice_id', 'jobber_assessment_id', 'jobber_sync_status']
for (const l of leads) {
  l.no_coverage_sent = noCoverage.has(l.id)
  l.has_engagement = engaged.has(l.id)
  l.in_jobber = JOBBER_FIELDS.some((f) => !!l[f])
}

const plan = planBacklog({ leads, posted, only: ONLY, again: AGAIN })
const label = (l) => `${l.id.slice(0, 8)}  ${[l.first_name, l.last_name].filter(Boolean).join(' ') || l.name}  (zip ${l.zip ?? '—'}, ${l.created_at.slice(0, 10)})`

console.log(`Other → #${other.slack_channel_name} | ${COMMIT ? 'POSTING' : 'DRY RUN'} | ${plan.post.length} to post, ${plan.skipped.length} skipped`)
for (const s of plan.skipped) {
  const l = leads.find((x) => x.id === s.id)
  console.log(`  skip  ${l ? label(l) : s.id}: ${s.reason}`)
}

let ok = 0, failed = 0
for (const l of plan.post) {
  let words = '', buttons = ''
  try {
    const s = await suggestRouteForLead(l.id)
    words = suggestionHeadline(s, l.zip).replace(/\n/g, ' / ')
    buttons = [...s.options.map((o) => (o.highlighted ? `[green] ${o.label}` : o.label)), 'Leave in Other', ...(s.showNotInServiceArea ? ['[red] Not in our service area'] : [])].join(' · ')
  } catch (e) {
    words = `(suggestion failed: ${e?.message || e} — the card would say so)`
    buttons = 'Leave in Other'
  }
  console.log(`  ${COMMIT ? 'post' : 'would post'}  ${label(l)}\n        ${words}\n        ${buttons}`)
  if (!COMMIT) continue

  const lead = {
    id: l.id, name: l.name, email: l.email, phone: l.phone, project_type: l.project_type,
    request_details: l.request_details, preferred_contact: l.preferred_contact, source: l.source,
    address: l.address, city: l.city, state: l.state, zip: l.zip,
  }
  const ctx = { lead_id: l.id, lead_name: l.name, location_id: other.id, location_slug: other.location_id }
  try {
    const res = await notifyNewLeadSlack({ locationId: other.id, locationName: other.name, baseUrl: BASE_URL, lead })
    await logSlackNotification(res, ctx)
    if (res.ok) { ok++; console.log('        → posted') }
    else { failed++; console.log(`        → NOT posted: ${res.error || res.skipped}`) }
  } catch (e) {
    failed++
    await logSlackNotification({ ok: false, error: e?.message || String(e) }, ctx)
    console.log(`        → NOT posted: ${e?.message || e}`)
  }
}

if (!COMMIT) console.log('DRY RUN — nothing posted. Re-run with --commit to post.')
else console.log(`POSTED ${ok}${failed ? `, FAILED ${failed}` : ''}.`)
process.exit(failed ? 1 : 0)
