// Partner emails, slice 2 (2026-11-22): NOTHING THAT TRACKS CLIENT DRIPS
// CHANGES, by fingerprint.
//
//   · every file that names the client drip table is byte for byte what it
//     was on origin/main f115e0ee (sha-256, first 16 hex), and no new file
//     names it except this slice's own tests, which only talk about it
//   · the database snapshot's line for that table is unchanged
//   · the migration and its undo never name it
//   · client screens get client sequences only (the masters list and a
//     location's list leave partner sequences out unless asked), and a
//     partner sequence can never be saved as a location's client sequence —
//     which is the only way client enrolment (lib/drip-lifecycle.ts) picks one
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withoutPartnerEmailsSlice3 } from './partner-emails-hub-footprint'
import { withoutFooterIntent } from './footer-intent-footprint'

const ROOT = process.cwd()
const TABLE = 'lead_' + 'drip_progress'
// BeeHub.jsx names the table only in comments; partner emails slice 3 changed
// it on purpose (the Emails screen), so it is compared with slice 3 taken
// back out, exactly (lib/network/partner-emails-hub-footprint.ts).
const sha = (f: string) => createHash('sha256').update(
  f === 'components/BeeHub.jsx' ? withoutPartnerEmailsSlice3(readFileSync(join(ROOT, f), 'utf8'))
    // the footer-intent edits (2026-11-22) to the senders, taken back out exactly
    : withoutFooterIntent(f, readFileSync(join(ROOT, f), 'utf8')),
).digest('hex').slice(0, 16)

// Every file under app/ lib/ components/ scripts/ migrations/ naming the
// table on origin/main f115e0ee, and its fingerprint there.
const READERS_ON_MAIN: [string, string][] = [
  ['app/api/clients/[id]/profile/route.ts', '4a47ac4eb2f683fc'],
  ['app/api/cron/send-drips/route.ts', '1aeb906c3c422f64'], // was 578c105a680e7a82 until FL-75 slice 2 (2026-11-23): 'unsubscribed_elsewhere' counted as an expected skip in the drip, welcome and stage loops (3 lines added; one line gained a trailing ||).
  ['app/api/drip-paths/[id]/active-lead-count/route.ts', '056cb018b12b8cb3'], // was da565643377fe6d4 until partner emails slice 4 (2026-11-22): on a PARTNER sequence the count adds its active partners; a client sequence counts exactly as before with no second read (lib/network/partner-drip-send.test.ts)
  ['app/api/drip-paths/[id]/steps/route.ts', 'c533d59d49988555'],
  ['app/api/engagements/[id]/route.ts', '6c8e7223f7175b7f'],
  ['app/api/leads/[id]/drip-pause/route.ts', '6dce28d9869a4fc3'],
  ['app/api/leads/[id]/drip-restart/route.ts', 'd53ed4377a2ad54a'],
  ['app/api/leads/[id]/drip/route.ts', '192be2a837e3f92b'],
  ['app/api/leads/[id]/outreach-timeline/route.ts', '8951be55fba8ecc2'],
  ['app/api/leads/[id]/route.ts', 'a8eef021b78ee2e6'],
  ['app/api/locations/[id]/drip-paths/[pathId]/route.ts', 'ad02713db5f16f7b'],
  ['app/api/webhooks/resend/route.ts', '0bf57d58e0da96f4'],
  ['components/BeeHub.jsx', '39fc9cf72668704c'],
  ['components/hive/shared/PreferencesBlock.jsx', '9b37e4477277bfbf'],
  ['lib/__fixtures__/founding-fingerprint.before.json', 'e27eaf6a2559b220'],
  ['lib/auto-close.test.ts', '77779b689de3d00e'],
  ['lib/auto-close.ts', 'd6db49cb8a497cc8'],
  ['lib/beta-card-layout.test.tsx', 'b10343901f8918e0'],
  ['lib/beta-drip-never-enrolled-243.test.ts', 'b086aaccbf163cd3'],
  ['lib/beta-drip-project-type-selection.test.ts', 'e3d9d00571caca11'],
  ['lib/beta-drip-status-panel.test.tsx', 'fc65c8766d02d1d4'],
  ['lib/beta-email-styles-send.test.ts', '1b1ba58f60032035'], // was 78731a603f3130ef until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/beta-email-subject-hold-316.test.ts', '6e3f45758b9131a4'], // was f18a817156273404 until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/beta-email-test-send.test.ts', '49cc167e9d174aca'],
  ['lib/beta-intake-dedup.test.ts', '2be27d9c8dcbf45f'],
  ['lib/beta-intake-observability.test.ts', 'bdd7b10d6494080f'],
  ['lib/beta-lead-transfer-endpoint.test.ts', '6d69eebbe8f2e9ca'],
  ['lib/beta-location-close.test.ts', 'bd511e9eb740fac5'],
  ['lib/beta-ops-alerts-silent-sends.test.ts', '2366a7238fd5eadf'],
  ['lib/beta-returning-drip-intake.test.ts', '23177f350c6ffe72'],
  ['lib/beta-returning-drip-lifecycle.test.ts', '5792bdc0cfcf1cf9'],
  ['lib/beta-returning-drip-subject-hold.test.ts', 'aba8dc74d8befc85'], // was 6a13a6f920ce96aa until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/beta-transfer-any-lead-endpoint.test.ts', '2401b1ec2f192638'],
  ['lib/booking-link.test.ts', '3caef63e32bb5c80'], // was ce677d058cee457b until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  // 2026-11-26 (Mailchimp slice 6): two Mailchimp tables added to the schema copy, then
  // locations' two new date columns (mailchimp_progress_dates.sql, run that day); the
  // client drip table's own line is unchanged (pinned by the test further down).
  ['lib/db-columns.snapshot.txt', '0d923b1eb46ebfa3'],
  ['lib/drip-enrol-outcome.test.ts', '4a3454b8fc9e9c81'],
  ['lib/drip-followups.test.ts', '437d84a4ee31572c'], // was f3e4c818a89d1238 until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/drip-followups.ts', '09b0d1b509bc7dcf'],
  ['lib/drip-interface-active-gate.test.ts', '80db3e20e61e53e1'], // was 0fae95ada939aa00 until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/drip-lifecycle.ts', '925f6146f4b30a72'],
  ['lib/drip-send-visibility.test.ts', 'c43058ced6311dce'], // was 14008bc553ba3726 until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/drip-send.ts', 'dd1d4c5f505cef43'], // was abc8ee5ebb0319ef until FL-75 slice 2 (2026-11-23): one import and one block after the opted-out stop — the shared no-marketing list is asked; said no → stopped 'unsubscribed_elsewhere', unreadable → held. 17 lines added, none changed (git diff --numstat). With every address clear, lib/network/client-drip-send-bytes.test.ts (44 scenarios) is still byte for byte. Before that: was a8a833d4e2fae092 until partner emails slice 4 (2026-11-22): its shareable parts moved to lib/drip-send-shared.ts for the partner sender. What it does is pinned byte for byte by OUTPUT instead: lib/network/client-drip-send-bytes.test.ts (44 scenarios — Resend payloads, every database call incl. the tracking writes, results — equal to af902cb and f115e0e)
  ['lib/drip-terminal-failure.test.ts', '32ad3daf75b14fc1'], // was 49237effee21311e until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/email-send-integrity.test.ts', '4319daf32390c67c'], // was e33633a1976c8871 until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/enquiry-resubmission.ts', '0d8017c3ef522e4b'],
  ['lib/failure-alerts.ts', 'e81fbbafa22adf2d'],
  ['lib/lead-transfer.ts', '264c798d55204ee4'],
  ['lib/location-close.ts', 'a612ca11e4ba29e7'],
  ['lib/rate-guard.test.ts', '38cd6964ab4317b5'], // was b158e7e3a54fed88 until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/reply-to-drips.test.ts', '49d65def5eb79cd1'], // was d7c96a52171ee9c3 until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['lib/resend-webhook-drip-stop.test.ts', 'b57ffd8b7bdee762'],
  ['lib/sender-domain-drips.test.ts', '059f9a395a8dde1b'], // was e3d871685de108c5 until FL-75 slice 2 (2026-11-23): one line — the fake database answers the shared no-marketing list question "clear" (rpc returns false), so these sends run exactly as before; nothing else in the file changed.
  ['migrations/cleanup_legacy_drip_paths.sql', '6051ef52c8909eda'],
  ['migrations/drip_consecutive_failures.sql', '45e31cfe6a77edf0'],
  ['migrations/drips_infrastructure.sql', '7b59351ea82ccef8'],
  ['migrations/leads_drip_send_status.sql', '6179b8a7623f843b'],
  ['scripts/backfill-lead-source.mjs', '643c73d80a70d55d'],
  ['scripts/repair-deleted-invoices.mjs', '5580a056de2c0f28'],
  ['scripts/repair-deleted-jobs.mjs', 'd30554975dd05d73'],
  ['scripts/repair-invoice-balances.mjs', 'a304ebc7de32b8cb'],
  ['scripts/repair-lead-balances.mjs', '676f6e67d949358b'],
  ['scripts/repair-lead-paid-totals.mjs', 'c67b1f3a7eb173f4'],
  ['scripts/repair-paid-work-closed-lost.mjs', 'e5d728f84efad8ca'],
  ['scripts/repair-portland-moving-d.mjs', '94d5ef021e244b5f'],
  ['scripts/repair-unbooked-jobs.mjs', '754ab5f6708d1e3f'],
  ['scripts/repair-unscheduled-jobs.mjs', 'a6ff58264fac8ce5'],
  ['scripts/scan-canspam-live.mjs', '2de88617a1c810bb'],
  ['scripts/scan-gen1-template-damage.mjs', '0e2b6a1cc337f86b'],
  ['scripts/scan-pause-drift.mjs', 'e0e0ae61b19709fe'],
  ['scripts/scan-seattle-td2-context.mjs', 'd2c9a9bf7b167877'],
  ['scripts/scan-seattle-td2-verbatim.mjs', 'd63b2520f5c242b3'],
  ['scripts/verify-unbooked-repair.mjs', '75dfa251aa8f1a73'],
]
// This slice's tests may name it (to say it is untouched); nothing else new may.
const SLICE2_TESTS = [
  'lib/network/partner-emails-client-drips-untouched.test.ts',
  'lib/network/partner-emails-migration.test.ts',
  // slice 3's BeeHub pieces quote BeeHub lines that name it in comments
  'lib/network/partner-emails-hub-footprint.ts',
  // the footer-intent pieces quote drip-send.ts lines that name it
  'lib/network/footer-intent-footprint.ts',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const rel = join(dir, name)
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|sql)$/.test(name)) out.push(rel)
  }
  return out
}

describe('nothing that tracks client drips changes (fingerprint)', () => {
  it('every file that names the client drip table is unchanged since main', () => {
    const changed = READERS_ON_MAIN.filter(([f, h]) => sha(f) !== h).map(([f]) => f)
    expect(changed).toEqual([])
  })
  it('no new file names it (other than this slice\'s own tests)', () => {
    const known = new Set([...READERS_ON_MAIN.map(([f]) => f), ...SLICE2_TESTS])
    const now = ['app', 'lib', 'components', 'scripts', 'migrations'].flatMap(d => walk(d))
      .filter(f => readFileSync(join(ROOT, f), 'utf8').includes(TABLE))
    expect(now.filter(f => !known.has(f))).toEqual([])
  })
  it('its line in the database snapshot is unchanged', () => {
    const snap = readFileSync(join(ROOT, 'lib/db-columns.snapshot.txt'), 'utf8').split('\n')
    expect(snap.filter(l => l.startsWith(TABLE + ':'))).toEqual(['lead_drip_progress:id,lead_id,drip_path_id,current_step,started_at,next_send_at,last_sent_at,completed_at,stopped_at,stopped_reason,paused_at,created_at,updated_at,consecutive_failures'])
  })
  it('the migration and its undo never name it', () => {
    for (const f of ['migrations/partner_emails.sql', 'migrations/partner_emails_undo.sql']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toContain(TABLE)
    }
  })
  it('the client enrolment code is among the unchanged files', () => {
    const files = READERS_ON_MAIN.map(([f]) => f)
    for (const f of ['lib/drip-lifecycle.ts', 'lib/drip-send.ts', 'app/api/cron/send-drips/route.ts', 'app/api/locations/[id]/drip-paths/[pathId]/route.ts']) {
      expect(files, f).toContain(f)
    }
  })
  it('client enrolment picks its sequence only from the two columns the database now guards', () => {
    const src = readFileSync(join(ROOT, 'lib/drip-lifecycle.ts'), 'utf8')
    expect(src).toMatch(/loc\.default_move_drip_path \|\| loc\.default_drip_path/)
    const mig = readFileSync(join(ROOT, 'migrations/partner_emails.sql'), 'utf8')
    expect(mig).toMatch(/ADD CONSTRAINT locations_default_paths_not_partner CHECK \(\s*\(default_drip_path IS NULL OR default_drip_path NOT LIKE 'partner-%'\) AND\s*\(default_move_drip_path IS NULL OR default_move_drip_path NOT LIKE 'partner-%'\)/)
  })
})

// ── the routes ───────────────────────────────────────────────────────────────
const h = vi.hoisted(() => {
  const state = { queue: [] as { table: string; resp: any }[], writes: [] as { table: string; op: string; arg: any }[], hubUser: { id: 'u1', role: 'owner', location_id: 'loc-1' } as any }
  const builder = (table: string) => {
    const i = state.queue.findIndex(q => q.table === table)
    const resp = i >= 0 ? state.queue.splice(i, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) b[m] = () => b
    for (const op of ['update', 'insert', 'delete', 'upsert']) b[op] = (arg: any) => { state.writes.push({ table, op, arg }); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, builder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.builder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: h.state.hubUser, error: null }); b.maybeSingle = b.single; return b },
  }),
}))

import { NextRequest } from 'next/server'
import { GET as mastersGET } from '@/app/api/drip-paths/masters/route'
import { GET as locPathsGET, PATCH as locPathsPATCH } from '@/app/api/locations/[id]/drip-paths/route'
import { POST as onboardingPathsPOST } from '@/app/api/locations/[id]/paths/route'

const req = (url: string, body?: unknown) => new NextRequest(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const MASTERS = ['organizing-a', 'moving-b', 'returning-c', 'partner-introduction', 'partner-power-introduction'].map((k, i) => ({ id: 'm' + i, path_key: k, name: k, is_active: true, is_master: true }))
beforeEach(() => { h.state.queue = []; h.state.writes = []; h.state.hubUser = { id: 'u1', role: 'owner', location_id: 'loc-1' } })

describe('client screens get client sequences only', () => {
  it('the masters list (onboarding, Settings, Admin → Content) leaves the partner masters out', async () => {
    h.state.queue.push({ table: 'drip_paths', resp: { data: MASTERS, error: null } }, { table: 'drip_path_steps', resp: { data: [], error: null } })
    const j = await (await mastersGET(req('http://x/api/drip-paths/masters'))).json()
    expect(j.masters.map((m: any) => m.path_key)).toEqual(['organizing-a', 'moving-b', 'returning-c'])
  })
  it('…and still works when called with no request at all, as before', async () => {
    h.state.queue.push({ table: 'drip_paths', resp: { data: MASTERS, error: null } }, { table: 'drip_path_steps', resp: { data: [], error: null } })
    const j = await (await (mastersGET as any)()).json()
    expect(j.masters).toHaveLength(3)
  })
  it('?audience=partner returns the partner masters only (for slice 3)', async () => {
    h.state.queue.push({ table: 'drip_paths', resp: { data: MASTERS, error: null } }, { table: 'drip_path_steps', resp: { data: [], error: null } })
    const j = await (await mastersGET(req('http://x/api/drip-paths/masters?audience=partner'))).json()
    expect(j.masters.map((m: any) => m.path_key)).toEqual(['partner-introduction', 'partner-power-introduction'])
  })
  it("a location's own list leaves its partner copies out", async () => {
    h.state.queue.push(
      { table: 'drip_paths', resp: { data: [{ id: 'c1', path_key: 'organizing-c' }, { id: 'c2', path_key: 'partner-introduction' }], error: null } },
      { table: 'drip_path_steps', resp: { data: [], error: null } },
      { table: 'locations', resp: { data: { id: 'loc-1', default_drip_path: 'organizing-c', default_move_drip_path: null }, error: null } },
    )
    const j = await (await locPathsGET(req('http://x/api/locations/loc-1/drip-paths'), { params: { id: 'loc-1' } })).json()
    expect(j.paths.map((p: any) => p.path_key)).toEqual(['organizing-c'])
  })
})

describe('a partner sequence can never be saved as a location\'s client sequence', () => {
  for (const body of [{ default: 'partner-introduction' }, { default_move: 'partner-power-introduction' }, { default: 'organizing-a', default_move: 'partner-introduction' }]) {
    it(`Settings: PATCH ${JSON.stringify(body)} is refused and nothing is written`, async () => {
      const res = await locPathsPATCH(new NextRequest('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: { id: 'loc-1' } })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('partner_sequence_not_allowed')
      expect(h.state.writes).toEqual([])
    })
  }
  for (const body of [{ default_drip_path: 'partner-introduction' }, { default_move_drip_path: 'partner-power-introduction' }]) {
    it(`onboarding: POST ${JSON.stringify(body)} is refused and nothing is written`, async () => {
      const res = await onboardingPathsPOST(req('http://x', body), { params: { id: 'loc-1' } })
      expect(res.status).toBe(400)
      expect(h.state.writes).toEqual([])
    })
  }
  it('a client sequence still saves as before', async () => {
    h.state.queue.push({ table: 'locations', resp: { data: { id: 'loc-1', default_drip_path: 'organizing-b', default_move_drip_path: null }, error: null } })
    const res = await locPathsPATCH(new NextRequest('http://x', { method: 'PATCH', body: JSON.stringify({ default: 'organizing-b' }) }), { params: { id: 'loc-1' } })
    expect(res.status).toBe(200)
    expect(h.state.writes.map(w => [w.table, w.op, w.arg.default_drip_path])).toEqual([['locations', 'update', 'organizing-b']])
  })
})
