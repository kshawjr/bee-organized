// @vitest-environment node
//
// Other's Slack cards stay in step with Bee Hub (lib/other-card-sync.ts,
// 20 Oct 2026). When a lead leaves Other by any route its card is edited in
// place — buttons gone, one line saying what happened and who — and when it
// comes back into Other the sweep posts a fresh card.
//   A. the words, per way out
//   B. recordOtherCard / markCardResolved
//   C. retireOtherCards: edits every live card for the lead, marks it
//      resolved; a failed edit stays live for the sweep; never throws
//   D. sweepOtherCards: edits live cards whose lead is no longer open; reposts
//      a lead that came back — never one "left in Other" or moved
//   E. the cron route's auth
//   F. Other's card post records its message id; franchise cards don't
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── a small table-backed fake: filters are honoured, so the tests can see
//    which rows each write touched ──────────────────────────────
const db = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  inserts: [] as { table: string; row: any }[],
  updates: [] as { table: string; patch: any; filters: any[] }[],
  failTable: null as string | null,
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      const filters: [string, string, any][] = []
      let op: 'select' | 'update' | 'insert' = 'select'
      let patch: any = null
      const b: any = {}
      b.select = () => b
      b.order = () => b
      b.limit = () => b
      b.eq = (c: string, v: any) => { filters.push(['eq', c, v]); return b }
      b.in = (c: string, v: any[]) => { filters.push(['in', c, v]); return b }
      b.is = (c: string, v: any) => { filters.push(['is', c, v]); return b }
      b.like = (c: string, v: string) => { filters.push(['like', c, v]); return b }
      b.update = (p: any) => { op = 'update'; patch = p; return b }
      b.insert = (row: any) => { op = 'insert'; db.inserts.push({ table, row }); return b }
      const match = (r: any) => filters.every(([k, c, v]) =>
        k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : k === 'is' ? (r[c] ?? null) === v : k === 'like' ? String(r[c] ?? '').startsWith(v.replace('%', '')) : true)
      const run = () => {
        if (db.failTable === table) return { data: null, error: { message: `${table} down` } }
        if (op === 'insert') return { data: null, error: null }
        const rows = (db.tables[table] || []).filter(match)
        if (op === 'update') {
          db.updates.push({ table, patch, filters: [...filters] })
          rows.forEach((r) => Object.assign(r, patch))
          return { data: rows, error: null }
        }
        return { data: rows, error: null }
      }
      b.maybeSingle = async () => { const r = run(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data } }
      b.single = b.maybeSingle
      b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
      return b
    },
  },
}))

import {
  exitLine,
  resolutionForReason,
  recordOtherCard,
  markCardResolved,
  retireOtherCards,
  sweepOtherCards,
  SLACK_UPDATE_URL,
} from '@/lib/other-card-sync'
import { DONE_BLOCK_ID, SUGGEST_BLOCK_ID, ACTIONS_BLOCK_ID } from '@/lib/route-suggestion-slack'

const NOW = Date.parse('2026-10-21T15:00:00Z')
const slackCalls: { url: string; body: any; auth: string }[] = []
let slackOk = true
const card = (over: any = {}) => ({ id: `c-${Math.random().toString(36).slice(2, 7)}`, lead_id: 'lead-1', location_uuid: 'uuid-other', channel_id: 'C-OTHER', message_ts: '111.222', posted_at: '2026-10-20T21:00:00Z', resolved_at: null, resolution: null, resolved_line: null, ...over })
const lead = (over: any = {}) => ({ id: 'lead-1', name: 'Zach H', first_name: 'Zach', last_name: 'H', location_id: 'loc_other', is_junk: false, created_at: '2026-10-13T00:00:00Z', archived_at: null, inbox_dismissed_at: null, snoozed_until: null, city: 'San Francisco', state: 'CA', zip: '94122', jobber_client_id: null, jobber_request_id: null, jobber_quote_id: null, jobber_job_id: null, jobber_invoice_id: null, jobber_assessment_id: null, jobber_sync_status: null, ...over })

beforeEach(() => {
  db.tables = {
    slack_cards: [],
    leads: [lead()],
    locations: [{ id: 'uuid-other', location_id: 'loc_other', slack_bot_token: 'xoxb-other' }],
    hub_users: [{ id: 'hu-leslie', full_name: 'Leslie Mullins', first_name: 'Leslie' }],
    notification_log: [],
    engagements: [],
    touchpoints: [],
  }
  db.inserts = []
  db.updates = []
  db.failTable = null
  slackCalls.length = 0
  slackOk = true
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    slackCalls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization })
    return { ok: true, status: 200, json: async () => (slackOk ? { ok: true } : { ok: false, error: 'message_not_found' }) } as any
  }))
})

// ═══ A. the words ═══════════════════════════════════════════════
describe('A. what the card says, per way out', () => {
  it.each([
    ['moved', { dest: 'Lincoln', who: 'Leslie Mullins' }, '✅ Moved to *Lincoln* by Leslie Mullins.'],
    ['binned', { who: 'Leslie Mullins' }, '🗑 Binned by Leslie Mullins.'],
    ['dismissed', { who: 'Leslie Mullins' }, '📥 Dismissed by Leslie Mullins.'],
    ['snoozed', { who: 'Leslie Mullins', until: '2026-10-25T13:00:00Z' }, '💤 Snoozed until Oct 25 by Leslie Mullins. Its card comes back when the snooze ends.'],
    ['no_coverage', { who: 'Leslie Mullins', to: 'z@example.com' }, "📭 Told z@example.com we don't serve their area yet (mailing-list link sent) — by Leslie Mullins."],
    ['network', { who: 'Leslie Mullins' }, '🤝 Moved to the Network by Leslie Mullins.'],
    ['left_in_other', { who: 'Leslie Mullins' }, '📥 Left in Other by Leslie Mullins. Route it in Bee Hub when ready.'],
    ['archived', {}, '🗄 Archived in Bee Hub.'],
    ['has_engagement', {}, '✔️ Closed in Bee Hub.'],
    ['in_jobber', {}, '✔️ Already in Jobber — handled in Bee Hub.'],
    ['gone', {}, '✔️ No longer in Other.'],
  ] as const)('%s', (resolution, opts, line) => {
    expect(exitLine(resolution as any, opts as any)).toBe(line)
  })

  it('with nobody named, the line just leaves the "by" out', () => {
    expect(exitLine('dismissed')).toBe('📥 Dismissed.')
    expect(exitLine('moved', { dest: 'Reno' })).toBe('✅ Moved to *Reno*.')
  })

  it.each([
    ['binned', 'binned'], ['dismissed', 'dismissed'], ['snoozed', 'snoozed'], ['no_coverage_sent', 'no_coverage'],
    ['archived', 'archived'], ['has_engagement', 'has_engagement'], ['in_jobber', 'in_jobber'], ['not_in_other', 'gone'],
  ])('the backlog rule\'s %s reads as %s', (reason, resolution) => {
    expect(resolutionForReason(reason as any)).toBe(resolution)
  })
})

// ═══ B. recording ═══════════════════════════════════════════════
describe('B. recording cards', () => {
  it('recordOtherCard writes the lead, location, channel and message id', async () => {
    await recordOtherCard({ leadId: 'lead-1', locationUuid: 'uuid-other', channelId: 'C-OTHER', messageTs: '111.222' })
    expect(db.inserts).toEqual([{ table: 'slack_cards', row: { lead_id: 'lead-1', location_uuid: 'uuid-other', channel_id: 'C-OTHER', message_ts: '111.222' } }])
  })

  it('a button press marks exactly that message resolved, and only if it was live', async () => {
    db.tables.slack_cards = [card({ message_ts: '111.222' }), card({ message_ts: '333.444' })]
    await markCardResolved({ channelId: 'C-OTHER', messageTs: '111.222', resolution: 'left_in_other', line: 'L' })
    expect(db.tables.slack_cards.map((c) => c.resolution)).toEqual(['left_in_other', null])
    expect(db.updates[0].filters).toContainEqual(['is', 'resolved_at', null])
  })

  it('a press with no message id (an old card) records nothing', async () => {
    await markCardResolved({ channelId: undefined, messageTs: undefined, resolution: 'moved', line: 'L' })
    expect(db.updates).toEqual([])
  })

  it('a failed write never throws', async () => {
    db.failTable = 'slack_cards'
    await expect(recordOtherCard({ leadId: 'x', locationUuid: 'y', channelId: 'z', messageTs: 't' })).resolves.toBeUndefined()
  })
})

// ═══ C. retiring ════════════════════════════════════════════════
describe('C. retireOtherCards — edit every live card for the lead', () => {
  it('no card → no Slack call (any franchise lead)', async () => {
    expect(await retireOtherCards({ leadId: 'lead-1', resolution: 'moved', line: 'x' })).toEqual({ edited: 0, failed: 0 })
    expect(slackCalls).toEqual([])
  })

  it('edits the card in place with Other\'s token: the name and place stay, suggestion and buttons go, the line is added', async () => {
    db.tables.slack_cards = [card()]
    expect(await retireOtherCards({ leadId: 'lead-1', resolution: 'moved', line: '✅ Moved to *Lincoln* by Leslie Mullins.' })).toEqual({ edited: 1, failed: 0 })
    expect(slackCalls).toHaveLength(1)
    const call = slackCalls[0]
    expect(call.url).toBe(SLACK_UPDATE_URL)
    expect(call.auth).toBe('Bearer xoxb-other')
    expect(call.body).toMatchObject({ channel: 'C-OTHER', ts: '111.222' })
    const blocks = call.body.attachments[0].blocks
    expect(blocks[0].text.text).toBe('*Zach H*\nSan Francisco, CA 94122')
    expect(blocks.some((b: any) => b.block_id === SUGGEST_BLOCK_ID || b.block_id === ACTIONS_BLOCK_ID)).toBe(false)
    expect(blocks.find((b: any) => b.block_id === DONE_BLOCK_ID).elements[0].text).toBe('✅ Moved to *Lincoln* by Leslie Mullins.')
    expect(db.tables.slack_cards[0]).toMatchObject({ resolution: 'moved', resolved_line: '✅ Moved to *Lincoln* by Leslie Mullins.' })
    expect(db.tables.slack_cards[0].resolved_at).toBeTruthy()
  })

  it('every live card is edited (a lead with two); a resolved one is left alone', async () => {
    db.tables.slack_cards = [card({ message_ts: 'a' }), card({ message_ts: 'b' }), card({ message_ts: 'c', resolved_at: '2026-10-20T00:00:00Z', resolution: 'left_in_other' })]
    expect((await retireOtherCards({ leadId: 'lead-1', resolution: 'binned', line: 'x' })).edited).toBe(2)
    expect(slackCalls.map((c) => c.body.ts)).toEqual(['a', 'b'])
    expect(db.tables.slack_cards[2].resolution).toBe('left_in_other')
  })

  it('Slack refuses the edit → the card stays live, for the sweep to retry', async () => {
    db.tables.slack_cards = [card()]
    slackOk = false
    expect(await retireOtherCards({ leadId: 'lead-1', resolution: 'dismissed', line: 'x' })).toEqual({ edited: 0, failed: 1 })
    expect(db.tables.slack_cards[0].resolved_at).toBeNull()
  })

  it('no bot token (Other disconnected) → counted as failed, nothing sent', async () => {
    db.tables.slack_cards = [card()]
    db.tables.locations[0].slack_bot_token = null
    expect(await retireOtherCards({ leadId: 'lead-1', resolution: 'dismissed', line: 'x' })).toEqual({ edited: 0, failed: 1 })
    expect(slackCalls).toEqual([])
  })

  it('a database failure never throws into the action that called it', async () => {
    db.failTable = 'slack_cards'
    await expect(retireOtherCards({ leadId: 'lead-1', resolution: 'dismissed', line: 'x' })).resolves.toEqual({ edited: 0, failed: 0 })
  })
})

// ═══ D. the sweep ═══════════════════════════════════════════════
describe('D. sweepOtherCards — the backstop', () => {
  const sweep = (repost = vi.fn(async () => true)) => sweepOtherCards({ nowMs: NOW, repost }).then((r) => ({ r, repost }))
  const lastLine = () => slackCalls[slackCalls.length - 1].body.attachments[0].blocks.find((b: any) => b.block_id === DONE_BLOCK_ID).elements[0].text

  it('a live card for a lead still open in Other → left alone', async () => {
    db.tables.slack_cards = [card()]
    const { r, repost } = await sweep()
    expect(r).toEqual({ retired: 0, reposted: 0, failed: 0 })
    expect(slackCalls).toEqual([])
    expect(repost).not.toHaveBeenCalled()
  })

  it.each([
    ['dismissed', { inbox_dismissed_at: '2026-10-21T10:00:00Z' }, '📥 Dismissed.'],
    ['binned', { is_junk: true }, '🗑 Binned.'],
    ['archived', { archived_at: '2026-10-21T10:00:00Z' }, '🗄 Archived in Bee Hub.'],
    ['in Jobber', { jobber_client_id: 'J1' }, '✔️ Already in Jobber — handled in Bee Hub.'],
  ])('a live card whose lead was %s elsewhere → edited, no name (the sweep can\'t see who)', async (_what, over, line) => {
    db.tables.slack_cards = [card()]
    db.tables.leads = [lead(over)]
    const { r } = await sweep()
    expect(r.retired).toBe(1)
    expect(lastLine()).toBe(line)
  })

  it('snoozed elsewhere → edited with the date it comes back', async () => {
    db.tables.slack_cards = [card()]
    db.tables.leads = [lead({ snoozed_until: '2026-10-25T13:00:00Z' })]
    await sweep()
    expect(lastLine()).toBe('💤 Snoozed until Oct 25. Its card comes back when the snooze ends.')
  })

  it('closed as not interested (an engagement, nothing on the lead row) → edited', async () => {
    db.tables.slack_cards = [card()]
    db.tables.engagements = [{ client_id: 'lead-1' }]
    await sweep()
    expect(lastLine()).toBe('✔️ Closed in Bee Hub.')
  })

  it('moved out of Other where the instant edit failed → says where and who, from the transfer entry', async () => {
    db.tables.slack_cards = [card()]
    db.tables.leads = [lead({ location_id: 'loc_greensboro' })]
    db.tables.touchpoints = [{ lead_id: 'lead-1', kind: 'system', notes: 'Routed from loc_other to Greensboro', user_id: 'hu-leslie', occurred_at: '2026-10-21T10:00:00Z' }]
    await sweep()
    expect(lastLine()).toBe('✅ Moved to *Greensboro* by Leslie Mullins.')
  })

  it('a lead deleted outright → its card is edited "no longer in Other"', async () => {
    db.tables.slack_cards = [card()]
    db.tables.leads = []
    await sweep()
    expect(lastLine()).toBe('✔️ No longer in Other.')
  })

  it.each([['dismissed'], ['binned'], ['snoozed'], ['archived'], ['has_engagement'], ['in_jobber']])(
    'came back into Other after "%s" → a fresh card', async (resolution) => {
      db.tables.slack_cards = [card({ resolved_at: '2026-10-20T22:00:00Z', resolution })]
      const { r, repost } = await sweep()
      expect(repost).toHaveBeenCalledTimes(1)
      expect((repost.mock.calls[0] as any)[0].id).toBe('lead-1')
      expect(r.reposted).toBe(1)
    })

  it.each([['left_in_other'], ['moved'], ['gone']])('resolved as "%s" and still open → NOT reposted', async (resolution) => {
    db.tables.slack_cards = [card({ resolved_at: '2026-10-20T22:00:00Z', resolution })]
    const { repost } = await sweep()
    expect(repost).not.toHaveBeenCalled()
  })

  it('only the LATEST card decides: dismissed, then reposted and left in Other → not reposted again', async () => {
    db.tables.slack_cards = [
      card({ message_ts: 'a', posted_at: '2026-10-20T20:00:00Z', resolved_at: '2026-10-20T21:00:00Z', resolution: 'dismissed' }),
      card({ message_ts: 'b', posted_at: '2026-10-20T22:00:00Z', resolved_at: '2026-10-20T23:00:00Z', resolution: 'left_in_other' }),
    ]
    const { repost } = await sweep()
    expect(repost).not.toHaveBeenCalled()
  })

  it('a snooze still running → no repost; one that has run out → repost', async () => {
    db.tables.slack_cards = [card({ resolved_at: '2026-10-20T22:00:00Z', resolution: 'snoozed' })]
    db.tables.leads = [lead({ snoozed_until: '2026-10-25T00:00:00Z' })]
    expect((await sweep()).repost).not.toHaveBeenCalled()
    db.tables.leads = [lead({ snoozed_until: '2026-10-21T00:00:00Z' })]
    expect((await sweep()).repost).toHaveBeenCalledTimes(1)
  })

  it('a lead that is still resolved is not reposted (dismissed, card already says so)', async () => {
    db.tables.slack_cards = [card({ resolved_at: '2026-10-20T22:00:00Z', resolution: 'dismissed' })]
    db.tables.leads = [lead({ inbox_dismissed_at: '2026-10-20T22:00:00Z' })]
    const { repost, r } = await sweep()
    expect(repost).not.toHaveBeenCalled()
    expect(r.retired).toBe(0)
  })

  it('a repost that fails is counted, not thrown', async () => {
    db.tables.slack_cards = [card({ resolved_at: '2026-10-20T22:00:00Z', resolution: 'dismissed' })]
    const { r } = await sweep(vi.fn(async () => false))
    expect(r).toEqual({ retired: 0, reposted: 0, failed: 1 })
  })

  it('a failed facts read throws (the cron reports it) rather than editing on half a picture', async () => {
    db.tables.slack_cards = [card()]
    db.failTable = 'engagements'
    await expect(sweepOtherCards({ nowMs: NOW })).rejects.toThrow('facts read failed')
  })
})

// ═══ E. the cron route ═══════════════════════════════════════════
describe('E. GET /api/cron/other-cards — auth', () => {
  const call = async (headers: Record<string, string> = {}, query = '') => {
    const { GET } = await import('@/app/api/cron/other-cards/route')
    return GET({ headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, nextUrl: new URL(`https://x.example/api/cron/other-cards${query}`) } as any)
  }
  it('no CRON_SECRET → 500 and nothing runs (fail closed)', async () => {
    delete process.env.CRON_SECRET
    expect((await call()).status).toBe(500)
  })
  it('a wrong secret → 401', async () => {
    process.env.CRON_SECRET = 's3cret'
    expect((await call({ authorization: 'Bearer nope' })).status).toBe(401)
  })
  it('the right Bearer secret runs the sweep', async () => {
    process.env.CRON_SECRET = 's3cret'
    const res = await call({ authorization: 'Bearer s3cret' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, retired: 0, reposted: 0, failed: 0 })
  })
  it('?secret= works for manual testing', async () => {
    process.env.CRON_SECRET = 's3cret'
    expect((await call({}, '?secret=s3cret')).status).toBe(200)
  })
})
