// Partner emails, slice 1 (2026-11-21): client emails are untouched.
//
//   · the client tag list (OWNER_MERGE_TAGS) is exactly what it was, in order
//   · {{partner_name}} is still not offered to clients, and still a
//     not-offered legacy tag
//   · no client sender fills {{partner_name}}, so in a client email it
//     renders blank, exactly as before
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('no db') } } }))

import { OWNER_MERGE_TAGS, LEGACY_MERGE_TAGS, MERGE_TAG_GROUPS } from '../merge-tags'
import { renderTemplate } from '../resend'
import { PARTNER_MERGE_TAGS, partnerRenderContext } from '../partner-merge-tags'

// The client list as it stood on origin/main 0aac2949 — key and group, in order.
const CLIENT_LIST_BEFORE = [
  ['first_name', 'client'],
  ['owner_name', 'people'], ['owner_first_name', 'people'], ['location_owner_name', 'people'], ['signature', 'people'],
  ['location_name', 'location'], ['location_phone', 'location'], ['service_area', 'location'], ['rate_per_hour', 'location'], ['reviews_link', 'location'],
  ['book_assessment_link', 'booking'], ['booking_link', 'booking'], ['owner_booking_link', 'booking'], ['discovery_booking_link', 'booking'], ['virtual_booking_link', 'booking'],
]

describe('client email tags are untouched', () => {
  it('the client tag list is exactly as before', () => {
    expect(OWNER_MERGE_TAGS.map(t => [t.key, t.group])).toEqual(CLIENT_LIST_BEFORE)
    expect(MERGE_TAG_GROUPS.map(g => g.id)).toEqual(['client', 'people', 'location', 'booking'])
  })
  it('{{partner_name}} is not offered to clients, and stays on the not-offered list', () => {
    expect(OWNER_MERGE_TAGS.map(t => t.key)).not.toContain('partner_name')
    expect(LEGACY_MERGE_TAGS.map(t => t.key)).toEqual(['organizer_name', 'phone', 'partner_name'])
  })
  it('the client list and the partner list are separate objects', () => {
    expect(PARTNER_MERGE_TAGS).not.toBe(OWNER_MERGE_TAGS as unknown)
    for (const t of PARTNER_MERGE_TAGS) expect(OWNER_MERGE_TAGS).not.toContain(t as unknown)
  })
})

describe('no client email fills {{partner_name}}', () => {
  const ctxBlock = (file: string) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8')
    const at = src.indexOf('const ctx: RenderContext = {')
    expect(at, `${file} context`).toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('\n  }', at))
  }
  for (const file of ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts', 'app/api/emails/test-send/route.ts']) {
    it(`${file} does not fill partner_name, and does not use the partner context`, () => {
      expect(ctxBlock(file)).not.toMatch(/partner_name/)
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      expect(src).not.toMatch(/partner-merge-tags|partner-greeting|partnerRenderContext|partnerGreetingName/)
    })
  }
  it('a client context renders {{partner_name}} as blank, as it always has', () => {
    const r = renderTemplate({ subject: 'Hi {{partner_name}}', body: 'Hi {{first_name}}{{partner_name}},' }, { first_name: 'Jordan' })
    expect(r.subject).toBe('Hi ')
    expect(r.body).toBe('Hi Jordan,')
  })
  it('the partner context renders through the same renderTemplate — and a client tag in it renders blank', () => {
    const ctx = partnerRenderContext({
      partner: { name: 'Little Guys Movers', first_name: null, network_types: ['partner', 'organization'] },
      location: { name: 'Kansas City', phone: '8165550100', city: 'Kansas City', state: 'MO', rate_per_hour: '$95', reviews_link: null },
      locationOwnerName: 'Lynette Ewy',
    })
    const r = renderTemplate({ subject: 'Hi {{partner_name}}', body: 'Hi {{partner_name}} {{first_name}}— {{location_name}} {{location_phone}}' }, ctx)
    expect(r.subject).toBe('Hi Little Guys Movers')
    expect(r.body).toBe('Hi Little Guys Movers — Kansas City (816) 555-0100')
  })
})
