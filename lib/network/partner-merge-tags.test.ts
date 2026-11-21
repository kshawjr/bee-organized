// Partner emails, slice 1 (2026-11-21). What this pins:
//
//   · {{partner_name}} greets a person by first name, an organization and a
//     joint name by the whole name — and a blank name renders blank
//   · the organization tick wins over a first name
//   · the partner tag list holds nothing that needs a client record
//   · nothing in this slice can send an email: neither module imports the
//     sender, the Resend client, the drip engine or the database, and
//     loading them with all of those booby-trapped still works
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Booby traps: if either module under test loads any of these at runtime, the
// import below throws and every test in this file fails.
vi.mock('../resend', () => { throw new Error('partner tags loaded lib/resend (the sender)') })
vi.mock('resend', () => { throw new Error('partner tags loaded the Resend client') })
vi.mock('../drip-send', () => { throw new Error('partner tags loaded lib/drip-send') })
vi.mock('../supabase-service', () => { throw new Error('partner tags loaded the database client') })

import { partnerGreetingName } from './partner-greeting'
import { PARTNER_MERGE_TAGS, PARTNER_MERGE_TAG_GROUPS, CLIENT_ONLY_TAG_KEYS, partnerRenderContext } from '../partner-merge-tags'

const person = (name: string, first: string | null) => ({ name, first_name: first, network_types: ['partner'] })
const org = (name: string, first: string | null = null) => ({ name, first_name: first, network_types: ['partner', 'organization'] })

describe('{{partner_name}} — the greeting name', () => {
  it('a person with a first name → the first name', () => {
    expect(partnerGreetingName(person('Taylor Capen', 'Taylor'))).toBe('Taylor')
  })
  it('an organization → its own whole name', () => {
    expect(partnerGreetingName(org('Little Guys Movers'))).toBe('Little Guys Movers')
  })
  it('the organization tick wins over a first name in the box', () => {
    expect(partnerGreetingName(org('Little Guys Movers', 'Little'))).toBe('Little Guys Movers')
  })
  it('a joint name is never split', () => {
    expect(partnerGreetingName(person('Drew & Bill Crowley', null))).toBe('Drew & Bill Crowley')
    expect(partnerGreetingName(person('Pat and Sam Lee', null))).toBe('Pat and Sam Lee')
    // even if a first name was somehow stored beside it
    expect(partnerGreetingName(person('Drew & Bill Crowley', 'Drew'))).toBe('Drew & Bill Crowley')
  })
  it('no first name saved → the whole saved name; one word → that word', () => {
    expect(partnerGreetingName(person('Taylor Capen', null))).toBe('Taylor Capen')
    expect(partnerGreetingName(person('Madonna', null))).toBe('Madonna')
    expect(partnerGreetingName(person('Madonna', 'Madonna'))).toBe('Madonna')
    expect(partnerGreetingName({ name: 'Cher' })).toBe('Cher')
  })
  it('spaces are tidied; a whitespace-only first name counts as none', () => {
    expect(partnerGreetingName(person('  Taylor   Capen ', '  Taylor '))).toBe('Taylor')
    expect(partnerGreetingName(person('Taylor Capen', '   '))).toBe('Taylor Capen')
  })
  it('blank or whitespace-only everything → "" (the tag renders blank)', () => {
    expect(partnerGreetingName(person('', null))).toBe('')
    expect(partnerGreetingName(person('   ', '  '))).toBe('')
    expect(partnerGreetingName({ name: null })).toBe('')
    expect(partnerGreetingName(null)).toBe('')
  })
  it('a business typed into a person’s First / Last boxes is NOT guessed at: "Little" (documented, not fixed)', () => {
    expect(partnerGreetingName(person('Little Guys Movers', 'Little'))).toBe('Little')
  })
})

describe('the partner tag list', () => {
  const keys = PARTNER_MERGE_TAGS.map(t => t.key)
  it('has the four it must have', () => {
    for (const k of ['partner_name', 'signature', 'location_name', 'location_phone']) expect(keys, k).toContain(k)
  })
  it('holds nothing that needs a client record — each client-only tag by name', () => {
    const clientOnly = ['first_name', 'last_name', 'owner_name', 'owner_first_name', 'owner_booking_link',
      'book_assessment_link', 'booking_link', 'discovery_booking_link', 'virtual_booking_link', 'organizer_name', 'phone']
    for (const k of clientOnly) expect(keys, `{{${k}}} must not be offered on a partner`).not.toContain(k)
    expect(CLIENT_ONLY_TAG_KEYS.map(t => t.key).sort()).toEqual([...clientOnly].sort())
    // and nothing booking-, job-, quote- or client-shaped slipped in under another name
    for (const k of keys) expect(k, k).not.toMatch(/booking|job|quote|client|assess|^first_name$|^last_name$|^owner_/)
  })
  it('no key twice; every tag in a partner group, with a label and a one-sentence description', () => {
    expect(new Set(keys).size).toBe(keys.length)
    const groups = PARTNER_MERGE_TAG_GROUPS.map(g => g.id)
    for (const t of PARTNER_MERGE_TAGS) {
      expect(groups, t.key).toContain(t.group)
      expect(t.label.trim(), t.key).toBeTruthy()
      expect(t.description.trim().endsWith('.'), t.key).toBe(true)
    }
  })
})

describe('the partner merge context', () => {
  const loc = { name: 'Kansas City', phone: '8165550100', city: 'Kansas City', state: 'MO', rate_per_hour: '$95', reviews_link: 'https://g.page/r/kc' }
  const ctx = partnerRenderContext({ partner: person('Taylor Capen', 'Taylor'), location: loc, locationOwnerName: 'Lynette Ewy' })
  it('fills every partner value tag', () => {
    for (const t of PARTNER_MERGE_TAGS.filter(t => t.key !== 'signature')) {
      expect((ctx as Record<string, unknown>)[t.key], t.key).toBeTruthy()
    }
    expect(ctx.partner_name).toBe('Taylor')
    expect(ctx.service_area).toBe('Kansas City, MO')
  })
  it('holds no client value at all', () => {
    expect(Object.keys(ctx).sort()).toEqual(PARTNER_MERGE_TAGS.map(t => t.key).filter(k => k !== 'signature').sort())
    for (const { key } of CLIENT_ONLY_TAG_KEYS) expect(ctx, key).not.toHaveProperty(key)
  })
})

describe('nothing in this slice can send an email (fingerprint)', () => {
  const files = ['lib/partner-merge-tags.ts', 'lib/network/partner-greeting.ts']
  for (const f of files) {
    const src = readFileSync(join(process.cwd(), f), 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    it(`${f}: no runtime import of a sender, the database or the network`, () => {
      const imports = Array.from(code.matchAll(/^import\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm))
      for (const m of imports) {
        const [, isType, from] = m
        if (isType) continue
        expect(from, `${f} imports ${from}`).not.toMatch(/resend|drip|send|supabase|notification|mail|slack/i)
      }
      // and no bare side-effect import or require
      expect(code).not.toMatch(/^import\s+['"]/m)
      expect(code).not.toMatch(/\brequire\(|\bimport\(/)
    })
    it(`${f}: calls no send function and talks to no email provider`, () => {
      expect(code).not.toMatch(/\bsendEmail\w*\s*\(|\bsendDrip\w*\s*\(|new\s+Resend\b|\.emails\.send\b|\bfetch\s*\(|api\.resend\.com|XMLHttpRequest/)
    })
  }
})
