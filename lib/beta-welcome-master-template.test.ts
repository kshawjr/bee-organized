// @vitest-environment node
// The restored Welcome Email, rendered with the master template Kevin wrote
// (migrations/restore_welcome_master_template.sql).
//
// The template is READ FROM THE MIGRATION FILE, not retyped here, so these
// tests describe the row that will actually land in production. Everything on
// the send path runs for real — lib/welcome-email.ts, renderTemplate, the
// {{signature}} resolver, the CAN-SPAM footer, the past-client rule. Only the
// email provider and the primary-owner lookup are stubbed, and the database is
// a small in-memory responder keyed on table + filters (not a FIFO queue, so a
// reordered query can't make a test pass by accident).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── the template, from the migration ─────────────────────────
const SQL = readFileSync(join(__dirname, '..', 'migrations', 'restore_welcome_master_template.sql'), 'utf8')
const ROW = SQL.match(/\('welcome', '([^']+)', '(\w+)', '(\w+)',\s*\n\s*'([^']+)',\s*\n\s*\$tpl\$([\s\S]*?)\$tpl\$\)/)
if (!ROW) throw new Error('could not parse the welcome row out of the migration')
const [, TPL_NAME, TPL_TYPE, TPL_TAG, TPL_SUBJECT, TPL_BODY] = ROW

// ── in-memory database ───────────────────────────────────────
type Op = [string, any[]]
const db = vi.hoisted(() => ({
  state: {} as any,
  writes: [] as { table: string; op: string; payload: any; ops: [string, any[]][] }[],
}))

function respond(table: string, ops: Op[]): { data: any; error: any } {
  const s = db.state
  const sel = String(ops.find(o => o[0] === 'select')?.[1][0] ?? '')
  const eq = (col: string) => ops.find(o => o[0] === 'eq' && o[1][0] === col)?.[1][1]
  switch (table) {
    case 'leads':
      if (sel.includes('unsubscribe_token')) return { data: { unsubscribe_token: 'tok-abc' }, error: null }
      return { data: s.lead, error: null }
    case 'locations':
      if (sel.includes('website_url')) return { data: s.links, error: null }
      return { data: s.loc, error: null }
    case 'templates':
      if (eq('legacy_id') === 'welcome' && ops.some(o => o[0] === 'is' && o[1][0] === 'location_uuid' && o[1][1] === null)) {
        return { data: s.master, error: null }
      }
      return { data: null, error: null }          // no location fork
    case 'engagements':
      return { data: s.won ? { id: 'eng-won' } : null, error: null }
    case 'hub_users': {
      const person = s.people[eq('id')] ?? null
      if (sel.includes('signature_title')) {
        return { data: person ? { signature_title: person.signature_title ?? null, signature_photo_path: null } : null, error: null }
      }
      return { data: person, error: null }
    }
    case 'subscription_seats':
      return { data: [], error: null }
    case 'drip_path_steps':
      if (eq('step_order') === 1) return { data: s.step1, error: null }
      return { data: null, error: null }          // no step 2 → drip completes
    default:
      return { data: null, error: null }
  }
}

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      const ops: Op[] = []
      const b: any = {}
      for (const m of ['select', 'eq', 'is', 'not', 'or', 'in', 'order', 'limit', 'lte', 'gt', 'ilike', 'range']) {
        b[m] = (...a: any[]) => { ops.push([m, a]); return b }
      }
      for (const m of ['update', 'insert', 'upsert', 'delete']) {
        b[m] = (payload: any) => { ops.push([m, [payload]]); db.writes.push({ table, op: m, payload, ops }); return b }
      }
      const done = () => Promise.resolve(ops.some(o => ['update', 'insert', 'upsert', 'delete'].includes(o[0]))
        ? { data: null, error: null }
        : respond(table, ops))
      b.maybeSingle = done
      b.single = done
      b.then = (res: any, rej: any) => done().then(res, rej)
      return b
    },
  },
}))

const sendEmailMock = vi.hoisted(() => vi.fn(async (_args: any) => ({ success: true })))
vi.mock('@/lib/resend', async (orig) => ({ ...(await orig<any>()), sendEmail: sendEmailMock }))

const ownerMock = vi.hoisted(() => vi.fn(async (_loc: string): Promise<any> => null))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: ownerMock }))

import { sendWelcomeEmail } from '@/lib/welcome-email'
import { sendDripStepForRow } from '@/lib/drip-send'

// ── fixtures ─────────────────────────────────────────────────
const OWNER = { id: 'u-owner', full_name: 'Olive Owner', email: 'olive@beeorganized.com', phone: '555-0100', is_active: true, disabled_at: null, location_id: 'loc-1' }
const ASSIGNEE = { id: 'u-assignee', full_name: 'Avery Assignee', email: 'avery@beeorganized.com', phone: '555-0199', is_active: true, disabled_at: null, location_id: 'loc-1' }

function freshState(over: any = {}) {
  db.state = {
    lead: {
      id: 'lead-1', name: 'Sarah Mitchell', first_name: 'Sarah', email: 'sarah@email.com',
      location_uuid: 'loc-1', assigned_to: null, welcome_email_sent_at: null,
      is_junk: false, paused: false, marketing_opt_out: false,
      import_source: 'manual', paid_amount: 0,
      ...(over.lead ?? {}),
    },
    loc: {
      id: 'loc-1', name: 'Boulder', sender_name: 'Bee Boulder', phone: '555', calendar_link: null,
      reviews_link: null, rate_per_hour: null, city: 'Boulder', state: 'CO',
      timezone: 'America/Denver', lifecycle_status: 'active',
    },
    links: { website_url: null, facebook_url: null, instagram_url: null, linkedin_url: null },
    master: { id: 'tpl-welcome', subject: TPL_SUBJECT, body: TPL_BODY },
    people: { 'u-owner': OWNER, 'u-assignee': ASSIGNEE, ...(over.people ?? {}) },
    won: false,
    step1: { id: 'st-1', step_order: 1, delay_days: 0, channel: 'email', subject: 'Thanks for reaching out', body: 'Hi {{first_name}}', master_template_id: null, templates: null },
    ...(over.rest ?? {}),
  }
}

const saved = { postal: process.env.MARKETING_POSTAL_ADDRESS, app: process.env.NEXT_PUBLIC_APP_URL }
beforeEach(() => {
  db.writes = []
  vi.clearAllMocks()
  ownerMock.mockImplementation(async () => OWNER)
  process.env.MARKETING_POSTAL_ADDRESS = '123 Hive Lane, Suite 4, Omaha, NE 68102'
  process.env.NEXT_PUBLIC_APP_URL = 'https://beehive.beeorganized.com'
  freshState()
})
afterEach(() => {
  saved.postal === undefined ? delete process.env.MARKETING_POSTAL_ADDRESS : (process.env.MARKETING_POSTAL_ADDRESS = saved.postal)
  saved.app === undefined ? delete process.env.NEXT_PUBLIC_APP_URL : (process.env.NEXT_PUBLIC_APP_URL = saved.app)
})

async function sendAndCapture() {
  const res = await sendWelcomeEmail('lead-1')
  expect(res).toEqual({ sent: true })
  expect(sendEmailMock).toHaveBeenCalledTimes(1)
  return sendEmailMock.mock.calls[0][0] as { subject: string; html: string; text: string; to: string; email_kind: string }
}

// ═══ the migration is the row the code reads ═══════════════
describe('the migration inserts the master the sender looks for', () => {
  it('an EMAIL master tagged welcome, no location, active by default, ON CONFLICT safe', () => {
    expect(TPL_NAME).toBe('Welcome Email')
    expect(TPL_TYPE).toBe('email')
    expect(TPL_TAG).toBe('welcome')
    expect(TPL_SUBJECT).toBe('Welcome to the Bee Organized Hive!')
    // Same shape as seed_master_drip_paths.sql SECTION 3: these six columns,
    // location_uuid left NULL (a master), is_active left to its default true.
    expect(SQL).toMatch(/INSERT INTO templates \(legacy_id, name, type, tag, subject, body\) VALUES/)
    expect(SQL).toMatch(/ON CONFLICT \(legacy_id\) DO NOTHING;/)
    expect(SQL).not.toMatch(/is_active\s*=?\s*false/i)
  })

  it("carries Kevin's copy verbatim — greeting first, signature last, no hand-written unsubscribe", () => {
    expect(TPL_BODY.startsWith('{{first_name}},\n\nWelcome to the Bee Organized Hive!')).toBe(true)
    expect(TPL_BODY.endsWith('\n\n{{signature}}')).toBe(true)
    expect(TPL_BODY).toContain('Take our fun Organizing Profile Quiz here (https://beeorganized.com/)')
    expect(TPL_BODY).toContain('(https://beeorganized.com/pages/how-we-came-to-bee)')
    expect(TPL_BODY).toContain('Check out more info about **Bee Organized** below…')
    expect(TPL_BODY.toLowerCase()).not.toContain('unsubscribe')
  })
})

// ═══ it renders with this template, tags resolved ══════════
describe('a new lead\'s welcome renders from this template', () => {
  it('subject, greeting and both links come through', async () => {
    const sent = await sendAndCapture()
    expect(sent.subject).toBe('Welcome to the Bee Organized Hive!')
    expect(sent.to).toBe('sarah@email.com')
    expect(sent.email_kind).toBe('welcome')
    expect(sent.text.startsWith('Sarah,\n\nWelcome to the Bee Organized Hive!')).toBe(true)
    expect(sent.html).toContain('<p>Sarah,</p>')
    for (const out of [sent.text, sent.html]) {
      expect(out).toContain('https://beeorganized.com/)')
      expect(out).toContain('https://beeorganized.com/pages/how-we-came-to-bee')
    }
  })

  it('NOTHING renders as a literal {{ }} tag — subject, HTML or text — and no internal marker leaks', async () => {
    const sent = await sendAndCapture()
    for (const out of [sent.subject, sent.html, sent.text]) {
      expect(out).not.toMatch(/\{\{|\}\}/)
      expect(out).not.toContain('bo-signature')
    }
  })

  it('a lead with no first_name is greeted by the first word of their name, not a blank', async () => {
    freshState({ lead: { first_name: null, name: 'Jordan Reyes' } })
    const sent = await sendAndCapture()
    expect(sent.text.startsWith('Jordan,')).toBe(true)
  })

  it('the unsubscribe footer IS attached — the welcome is on the follow-ups\' side, not the drips\'', async () => {
    const sent = await sendAndCapture()
    const url = 'https://beehive.beeorganized.com'
    for (const out of [sent.text, sent.html]) {
      expect(out).toContain(url)
      expect(out).toContain('tok-abc')
      expect(out).toContain('123 Hive Lane, Suite 4, Omaha, NE 68102')
    }
    // …and it comes AFTER the signature, at the very end.
    expect(sent.text.indexOf('Olive Owner')).toBeLessThan(sent.text.indexOf('123 Hive Lane'))
  })

  it('no postal address → the footer cannot be built → the welcome is HELD, not sent bare', async () => {
    delete process.env.MARKETING_POSTAL_ADDRESS
    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: false, error: 'canspam_no_postal_address' })
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  // KNOWN GAP, pinned so it is visible rather than discovered in an inbox.
  // Client emails render bodies as plain paragraphs (bodyToHtml → plainParagraphs
  // in lib/drip-send.ts): there is no Markdown step anywhere on the send path.
  // So Kevin's **bold** and *italic* go out as literal asterisks. This is NOT a
  // regression — the original 2026 seed copy had the same asterisks. If this
  // test starts failing because bold now renders, that is the fix landing:
  // update it then.
  it('KNOWN GAP: **bold** and *italic* go out as literal asterisks (no Markdown on the send path)', async () => {
    const sent = await sendAndCapture()
    expect(sent.text).toContain('**Bee Organized**')
    expect(sent.text).toContain('*Simplify Your Hive!*')
    expect(sent.html).toContain('**Bee Organized**')
    expect(sent.html).not.toContain('<strong>Bee Organized</strong>')
  })
})

// ═══ {{signature}} becomes a real signature ════════════════
describe('{{signature}} resolves on the welcome path', () => {
  it('the location\'s primary owner signs when nobody is assigned — their name, email and mobile', async () => {
    const sent = await sendAndCapture()
    expect(sent.html).toContain('<table role="presentation"')   // the signature block, not text
    expect(sent.html).toContain('Olive Owner')
    expect(sent.html).toContain('mailto:olive@beeorganized.com')
    expect(sent.text).toContain('\n\nOlive Owner\nolive@beeorganized.com\nm: 555-0100')
  })

  it('an ACTIVE assignee signs instead of the owner', async () => {
    freshState({ lead: { assigned_to: 'u-assignee' } })
    const sent = await sendAndCapture()
    expect(sent.text).toContain('Avery Assignee')
    expect(sent.text).not.toContain('Olive Owner')
  })

  it('nobody has set a signature up (no title, no photo) → it is the owner\'s NAME, never worse than {{owner_name}}', async () => {
    const sent = await sendAndCapture()
    // No title line was set up, so the block is just who they are.
    const afterBody = sent.text.split('how-we-came-to-bee)')[1]
    expect(afterBody.trimStart().startsWith('Olive Owner\n')).toBe(true)
  })

  it('a title, when set, appears under the name', async () => {
    freshState({ people: { 'u-owner': { ...OWNER, signature_title: 'Owner, Bee Organized Boulder' } } })
    const sent = await sendAndCapture()
    expect(sent.text).toContain('Olive Owner\nOwner, Bee Organized Boulder')
  })

  it('no active owner or assignee → the LOCATION signs ("Bee Organized Boulder"), never a blank and never the tag', async () => {
    ownerMock.mockImplementation(async () => null)
    const sent = await sendAndCapture()
    expect(sent.text).toContain('Bee Organized Boulder')
    expect(sent.text).not.toMatch(/\{\{signature\}\}/)
  })
})

// ═══ new lead gets it; returning client does not ═══════════
describe('with this template in place: new leads only', () => {
  const row = (pathKey: string) => ({
    id: 'prog-1', lead_id: 'lead-1', drip_path_id: 'path-1', current_step: 1,
    next_send_at: '2026-01-01T14:00:00.000Z', drip_paths: { id: 'path-1', path_key: pathKey },
  })
  const welcomeScheduled = () =>
    db.writes.some(w => w.table === 'leads' && w.op === 'update' && 'welcome_email_scheduled_at' in w.payload && w.payload.welcome_email_scheduled_at)

  it('a NEW lead: step 1 queues the welcome, and the welcome then sends', async () => {
    const res = await sendDripStepForRow(row('organizing-c') as any)
    expect(res.sent).toBe(true)
    expect(welcomeScheduled()).toBe(true)

    sendEmailMock.mockClear()
    const sent = await sendAndCapture()
    expect(sent.subject).toBe('Welcome to the Bee Organized Hive!')
  })

  it('a RETURNING client on the returning sequence: step 1 sends, NO welcome queued', async () => {
    freshState({ lead: { import_source: 'jobber_import' } })
    const res = await sendDripStepForRow(row('returning-c') as any)
    expect(res.sent).toBe(true)
    expect(welcomeScheduled()).toBe(false)
  })

  it('a RETURNING client on an ordinary path (a Closed Won on record): NO welcome queued', async () => {
    freshState({ rest: { won: true } })
    const res = await sendDripStepForRow(row('organizing-c') as any)
    expect(res.sent).toBe(true)
    expect(welcomeScheduled()).toBe(false)
  })

  it('a RETURNING client whose welcome is somehow pending: NOT sent, and the pending welcome is cancelled', async () => {
    freshState({ lead: { paid_amount: 480 } })
    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: false, error: 'returning_client' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(db.writes.filter(w => w.table === 'leads').map(w => w.payload)).toEqual([{ welcome_email_scheduled_at: null }])
  })
})
