// Issue 303 — WHAT DOES *THIS* SEQUENCE SEND AS.
//
// The unit half. lib/beta-sequence-sender-303.test.tsx mounts the real screen
// and is the guard that matters, because components/BeeHub.jsx is .jsx and
// tsconfig includes only .ts/.tsx — nothing in that file is type-checked, so a
// rename or a dropped prop there fails no compiler. This file pins the rules
// underneath it, where they can be stated one at a time.
//
// The rule being pinned above all others: A SEQUENCE IS A FAMILY, AND A FAMILY
// IS ONE-TO-MANY OVER JOB TYPES. Moving having one answer and Organizing having
// one answer are both accidents of today's production data. The list is the
// general case.
import { describe, it, expect } from 'vitest'
import { resolveSequenceSenders, resolveConfiguredSenders, locationDefaultSender } from '@/lib/sequence-senders'

const DEFAULT = { name: 'Lynette Ewy', email: 'lynette@beeorganized.com', replyTo: 'lynette@beeorganized.com' }

// loc_kc as it stands in production today (verified 2026-08-15): four active
// types, four handler rows, every one of them person-mode and live.
const KC = () => ({
  base_sender_email: 'lynette@beeorganized.com',
  base_sender_domain: 'beeorganized.com',
  project_types: ['Home or Office Organizing', 'Moving/Relocation', 'Concierge Services', 'Other'],
  project_type_groups: [
    { label: 'Home or Office Organizing', drip_category: 'general' as const },
    { label: 'Moving/Relocation', drip_category: 'move' as const },
    { label: 'Concierge Services', drip_category: 'general' as const },
    { label: 'Other', drip_category: 'general' as const },
  ],
  assignments: [
    person('Home or Office Organizing', 'Lynette Ewy', 'lynette@beeorganized.com', 'u-lynette'),
    person('Moving/Relocation', 'Carol Kern', 'carol@beeorganized.com', 'u-carol'),
    person('Concierge Services', 'Lynette Ewy', 'lynette@beeorganized.com', 'u-lynette'),
    person('Other', 'Lynette Ewy', 'lynette@beeorganized.com', 'u-lynette'),
  ],
  people: [],
})

function person(type: string, name: string, email: string, uid: string, active = true) {
  return {
    id: `a-${type}`, project_type: type,
    sender_name: name, sender_email: email, sender_reply_to: null,
    sender_is_custom: false, source_user_id: uid,
    domain_warning: false, handler_active: active,
  }
}
function typed(type: string, name: string, email: string, replyTo: string | null, uid = 'u-carol') {
  return {
    id: `a-${type}`, project_type: type,
    sender_name: name, sender_email: email, sender_reply_to: replyTo,
    sender_is_custom: true, source_user_id: uid,
    domain_warning: false, handler_active: true,
  }
}

describe('loc_kc as it is today — the two sequences give two different answers', () => {
  it('moving resolves to Carol', () => {
    const r = resolveSequenceSenders(KC(), 'move', DEFAULT)
    expect(r.rows.map(x => x.projectType)).toEqual(['Moving/Relocation'])
    expect(r.uniform).toMatchObject({ name: 'Carol Kern', email: 'carol@beeorganized.com', isDefault: false })
  })

  it('organizing resolves to Lynette across all THREE of its types', () => {
    // The family is one-to-many even when the answer is one name — if this ever
    // reports fewer than three rows, the family lookup has silently narrowed.
    const r = resolveSequenceSenders(KC(), 'general', DEFAULT)
    expect(r.rows.map(x => x.projectType))
      .toEqual(['Home or Office Organizing', 'Concierge Services', 'Other'])
    expect(r.uniform).toMatchObject({ name: 'Lynette Ewy', isDefault: false })
  })

  it('the two sequences do not agree — which is the whole defect, stated', () => {
    const move = resolveSequenceSenders(KC(), 'move', DEFAULT)
    const gen = resolveSequenceSenders(KC(), 'general', DEFAULT)
    expect(move.uniform!.email).not.toBe(gen.uniform!.email)
  })

  it('nothing in either sequence falls through to the location default', () => {
    expect(resolveSequenceSenders(KC(), 'move', DEFAULT).usesDefault).toBe(false)
    expect(resolveSequenceSenders(KC(), 'general', DEFAULT).usesDefault).toBe(false)
  })
})

describe('THE LIST IS THE GENERAL CASE', () => {
  it('one organizing type on a different person makes the answer a list', () => {
    // Exactly the change the prompt names: give one organizing type to Carol.
    const cfg = KC()
    cfg.assignments[2] = person('Concierge Services', 'Carol Kern', 'carol@beeorganized.com', 'u-carol')
    const r = resolveSequenceSenders(cfg, 'general', DEFAULT)
    expect(r.uniform, 'must NOT collapse to one name').toBeNull()
    expect(r.rows.map(x => [x.projectType, x.sender.name])).toEqual([
      ['Home or Office Organizing', 'Lynette Ewy'],
      ['Concierge Services', 'Carol Kern'],
      ['Other', 'Lynette Ewy'],
    ])
  })

  it('reactivating a second move type makes MOVING a list too', () => {
    // Move-In Organization is inactive today with drip_category 'move'. The
    // moment corporate switches it on, Moving stops having one answer.
    const cfg = KC()
    cfg.project_type_groups.push({ label: 'Move-In Organization', drip_category: 'move' as const })
    const r = resolveSequenceSenders(cfg, 'move', DEFAULT)
    expect(r.uniform).toBeNull()
    expect(r.rows).toHaveLength(2)
    // Unhandled → the location default, not Carol borrowed from the sibling row.
    expect(r.rows[1].sender).toMatchObject({ isDefault: true, email: 'lynette@beeorganized.com' })
    expect(r.usesDefault).toBe(true)
  })

  it('never picks the first row, averages, or substitutes the default', () => {
    const cfg = KC()
    cfg.assignments[2] = person('Concierge Services', 'Carol Kern', 'carol@beeorganized.com', 'u-carol')
    const r = resolveSequenceSenders(cfg, 'general', DEFAULT)
    expect(r.uniform).toBeNull()
    const emails = new Set(r.rows.map(x => x.sender.email))
    expect(emails).toEqual(new Set(['lynette@beeorganized.com', 'carol@beeorganized.com']))
  })
})

describe('typed senders (issue 296) — the mailbox, never the handler', () => {
  it('a typed type reports the typed name and address, not the person holding it', () => {
    const cfg = KC()
    cfg.assignments[1] = typed('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', 'carol@beeorganized-kc.com')
    const r = resolveSequenceSenders(cfg, 'move', DEFAULT)
    expect(r.uniform).toMatchObject({
      name: 'Bee Organized Moving',
      email: 'moving@beeorganized-kc.com',
      replyTo: 'carol@beeorganized-kc.com',
      typed: true,
    })
    expect(r.uniform!.name).not.toBe('Carol Kern')
  })

  it('a typed sender with no reply-to of its own follows the location', () => {
    const cfg = KC()
    cfg.assignments[1] = typed('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', null)
    expect(resolveSequenceSenders(cfg, 'move', DEFAULT).uniform!.replyTo).toBe('lynette@beeorganized.com')
  })

  it('a typed sender survives its handler being offboarded', () => {
    // issue 296's rule: a mailbox does not stop existing when a person leaves.
    const cfg = KC()
    const t = typed('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', null)
    cfg.assignments[1] = { ...t, handler_active: false }
    expect(resolveSequenceSenders(cfg, 'move', DEFAULT).uniform).toMatchObject({
      email: 'moving@beeorganized-kc.com', typed: true, isDefault: false,
    })
  })
})

describe('the fallback — what the send path would ACTUALLY do', () => {
  it('a type with no handler row sends as the location default', () => {
    const cfg = KC()
    cfg.assignments = []
    const r = resolveSequenceSenders(cfg, 'general', DEFAULT)
    expect(r.usesDefault).toBe(true)
    expect(r.uniform).toMatchObject({ isDefault: true, name: 'Lynette Ewy' })
  })

  it('a PERSON-mode type whose handler is offboarded also falls to the default', () => {
    // lib/project-type-handlers.ts drops that row at send time. Reporting
    // "Carol Kern" because the row still says so would be issue 303's defect
    // one layer down: true about the config, false about the mail.
    const cfg = KC()
    cfg.assignments[1] = person('Moving/Relocation', 'Carol Kern', 'carol@beeorganized.com', 'u-carol', false)
    const r = resolveSequenceSenders(cfg, 'move', DEFAULT)
    expect(r.uniform).toMatchObject({ isDefault: true, email: 'lynette@beeorganized.com' })
    expect(r.uniform!.name).not.toBe('Carol Kern')
  })

  it('a row carrying no address falls back, matching resend.ts', () => {
    // lib/resend.ts only overrides `if (override?.sender_email)`.
    const cfg = KC()
    cfg.assignments[1] = { ...person('Moving/Relocation', 'Carol Kern', '', 'u-carol'), sender_email: '' }
    expect(resolveSequenceSenders(cfg, 'move', DEFAULT).uniform).toMatchObject({ isDefault: true })
  })

  it('reply-to defaults to the send-from address when the location has none', () => {
    expect(locationDefaultSender({ name: 'X', email: 'a@b.com', replyTo: '' }).replyTo).toBe('a@b.com')
  })
})

describe('degrades without inventing an answer', () => {
  it('a null config yields no rows and no uniform sender', () => {
    const r = resolveSequenceSenders(null, 'move', DEFAULT)
    expect(r.rows).toEqual([])
    expect(r.uniform).toBeNull()
    expect(r.usesDefault).toBe(false)
    expect(r.locationDefault.email).toBe('lynette@beeorganized.com')
  })

  it('matches handler rows case-insensitively, like the DB index does', () => {
    const cfg = KC()
    cfg.assignments[1] = person('moving/relocation', 'Carol Kern', 'carol@beeorganized.com', 'u-carol')
    expect(resolveSequenceSenders(cfg, 'move', DEFAULT).uniform).toMatchObject({ name: 'Carol Kern' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-03 — REPLIES GO TO WHOEVER THE EMAIL WENT OUT AS, and the card lists
// WHO SENDS WHAT across both sequences rather than one family at a time.
describe('reply-to follows the sender (2026-09-03)', () => {
  it('a person-mode row with no reply-to of its own replies to THAT PERSON, not the location', () => {
    const r = resolveSequenceSenders(KC(), 'move', DEFAULT)
    expect(r.uniform).toMatchObject({ email: 'carol@beeorganized.com', replyTo: 'carol@beeorganized.com' })
    expect(r.uniform!.replyTo).not.toBe(DEFAULT.replyTo)
  })

  it('a typed row keeps its own reply-to, unchanged', () => {
    const cfg = KC()
    cfg.assignments[1] = typed('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', 'carol@beeorganized-kc.com')
    expect(resolveSequenceSenders(cfg, 'move', DEFAULT).uniform!.replyTo).toBe('carol@beeorganized-kc.com')
  })

  it('a typed row left blank still follows the location, unchanged', () => {
    const cfg = KC()
    cfg.assignments[1] = typed('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', null)
    expect(resolveSequenceSenders(cfg, 'move', DEFAULT).uniform!.replyTo).toBe(DEFAULT.replyTo)
  })

  it('a type with no row is the location default, reply-to included, exactly as today', () => {
    const cfg = KC()
    cfg.assignments = []
    const r = resolveSequenceSenders(cfg, 'move', DEFAULT)
    expect(r.uniform).toMatchObject({ isDefault: true, email: DEFAULT.email, replyTo: DEFAULT.replyTo })
  })
})

describe('resolveConfiguredSenders — who sends what, every kind of job at once', () => {
  it('lists every kind of job with its own sender, across BOTH families, in lookups order', () => {
    const r = resolveConfiguredSenders(KC(), DEFAULT)
    expect(r.rows.map(x => x.projectType)).toEqual([
      'Home or Office Organizing', 'Moving/Relocation', 'Concierge Services', 'Other',
    ])
    const moving = r.rows.find(x => x.projectType === 'Moving/Relocation')!
    expect(moving.sender).toMatchObject({ name: 'Carol Kern', email: 'carol@beeorganized.com', replyTo: 'carol@beeorganized.com' })
    const org = r.rows.find(x => x.projectType === 'Home or Office Organizing')!
    expect(org.sender).toMatchObject({ name: 'Lynette Ewy', replyTo: 'lynette@beeorganized.com', isDefault: false })
  })

  it('a kind of job with no handler row is NOT listed — it is "everything else"', () => {
    const cfg = KC()
    cfg.assignments = [cfg.assignments[1]]   // moving only
    const r = resolveConfiguredSenders(cfg, DEFAULT)
    expect(r.rows.map(x => x.projectType)).toEqual(['Moving/Relocation'])
    expect(r.locationDefault).toMatchObject({ isDefault: true, email: DEFAULT.email })
  })

  it('an offboarded person-mode handler drops off the list rather than being named', () => {
    const cfg = KC()
    cfg.assignments[1] = person('Moving/Relocation', 'Carol Kern', 'carol@beeorganized.com', 'u-carol', false)
    const r = resolveConfiguredSenders(cfg, DEFAULT)
    expect(r.rows.map(x => x.projectType)).not.toContain('Moving/Relocation')
    expect(JSON.stringify(r.rows)).not.toContain('Carol Kern')
  })

  it('a typed row is listed as the mailbox with its own reply-to', () => {
    const cfg = KC()
    cfg.assignments[1] = typed('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', 'carol@beeorganized-kc.com')
    const row = resolveConfiguredSenders(cfg, DEFAULT).rows.find(x => x.projectType === 'Moving/Relocation')!
    expect(row.sender).toMatchObject({ name: 'Bee Organized Moving', typed: true, replyTo: 'carol@beeorganized-kc.com' })
  })

  it('no rows at all → an empty list and the location default', () => {
    const r = resolveConfiguredSenders({ project_type_groups: [], assignments: [] }, DEFAULT)
    expect(r.rows).toEqual([])
    expect(r.locationDefault.replyTo).toBe(DEFAULT.replyTo)
  })

  it('tolerates a missing payload', () => {
    expect(resolveConfiguredSenders(null, DEFAULT).rows).toEqual([])
  })
})
