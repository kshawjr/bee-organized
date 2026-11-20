// WHAT SLICE 4a TOUCHED, AND WHAT IT DID NOT (Network & Nurture, slice 4a).
//
// The contact sheet is new. Everything an owner, manager, read-only or
// corporate user can reach is meant to be exactly what it was. This file pins
// that by fingerprint (a sha256 of the file's bytes), not by reading it:
//
//   1 the old Network screens and the old save path are byte-for-byte what
//     they were when slice 3 was pushed (bf7862c);
//   2 the one big app file, BeeHub.jsx, differs from the pushed one by the
//     sheet's wiring and nothing else: take the wiring out and the bytes are
//     the pushed file's again.
//
// If one of the files in list 1 is changed ON PURPOSE by a later slice, that
// slice refreshes its fingerprint here and says so. A fingerprint that moves
// by accident is the thing this file exists to catch.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { withoutClickAway } from './click-away-footprint'
import { join } from 'node:path'

// BeeHub.jsx and hive/NetworkScreen.jsx: the click-away pass (2026-11-19) is taken back out first (click-away-footprint.ts).
const read = (p: string) => withoutClickAway(p, readFileSync(join(process.cwd(), p), 'utf8'))
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const UNTOUCHED: Record<string, string> = {
  // the old Network screens (still what every role but super admin would get)
  'components/hive/NetworkPersonRecord.jsx': 'a442dad80a382832e0f650105fe4f20b37fd59d0286de46429e60d03bb518847',
  'components/hive/NetworkScreen.jsx': '634bb1f08819400cbe4e516b7d8329624a634fa85b181d4d2d74afbabc72eec4',
  'components/hive/NetworkCompanyRecord.jsx': '96cd651dec0869285ada4392e493cf1cad1beebf9dd114a5e46919a735c5ab22',
  // the old save path for a contact, and what it leans on
  'app/api/partners/[id]/route.ts': '0b15077e5dd127dd907fcfaee92394988c6e0c6aa65a1c3362a35b213e87cf7a',
  // Changed ON PURPOSE after this slice: Referred by › Create now sets the contact's type (clients-doors-footprint.test.ts).
  'app/api/partners/route.ts': 'b9ae5129957215a2727a64c130de303ab94422a3182bf77cb0137d332532a48f',
  'lib/partner-writes.ts': 'c63675a136e1aa5c3db2c65b49f6d08b06939c3245099b488bc799b1bfa4ad25',
  'lib/crm.ts': '0f15c0b894575bbc93287b9e8d3664efca3949327af030d78ba351ddbb74acbb',
  // reminders and tags: the sheet reads them, and must not have changed them
  'app/api/reminders/route.ts': 'ac50556b4dbb5fe99a59e5eb4e82ec6eb6226f16ff370996cb16118da7e0dfe8',
  'app/api/partner-tags/route.ts': 'c5c2a0d881a2fa57ba8e57d270cf0a869dd64367f88e472684a57f7201406daa',
}

// BeeHub.jsx as pushed in slice 3 (git show bf7862c:components/BeeHub.jsx).
const HUB_AT_SLICE_3 = '8dc4f52d53cdef098b39324e7a948d6dee8afe34a13c5f296221a7b2015a82cb'

// The sheet's wiring, piece by piece. Each must be found exactly once.
const IMPORT = 'import ContactSheet from "@/components/network/ContactSheet"\n'
const STATE = '  // Counts saves made in the new contact sheet, so the new list reloads.\n  const [sheetSaves, setSheetSaves] = useState(0)\n'
const REFRESH = '          refreshKey={sheetSaves}\n'
const BLOCK_START = '      {/* THE NEW CONTACT SHEET (slice 4a)'
const BLOCK_END = '      {selected&&!newList&&(\n'
const OLD_LINE = '      {selected&&(\n'

// Slice 5 changed ONE line of the wiring on purpose: a row the host's own
// partners list does not hold yet (a contact just added or imported) still
// opens in the sheet, by its id. Put the slice 3 line back before comparing.
// lib/network/slice5-footprint.test.ts pins that this is the only change.
const SLICE5_OPEN_NEW = "if (p) setSelected(p) }}"
const SLICE5_OPEN_NOW = "setSelected(p || { id }) }}"

function withoutTheSheet(hub: string): string {
  let s = hub
  expect(s.split(SLICE5_OPEN_NOW).length - 1, 'slice 5 open line').toBe(1)
  s = s.replace(SLICE5_OPEN_NOW, SLICE5_OPEN_NEW)
  for (const piece of [IMPORT, STATE, REFRESH]) {
    expect(s.split(piece).length - 1, piece.trim().slice(0, 50)).toBe(1)
    s = s.replace(piece, '')
  }
  expect(s.split(BLOCK_START).length - 1).toBe(1)
  expect(s.split(BLOCK_END).length - 1).toBe(1)
  const from = s.indexOf(BLOCK_START)
  const to = s.indexOf(BLOCK_END)
  expect(to).toBeGreaterThan(from)
  return s.slice(0, from) + OLD_LINE + s.slice(to + BLOCK_END.length)
}

describe('slice 4a left everything outside the new Network screens alone', () => {
  for (const [file, want] of Object.entries(UNTOUCHED)) {
    it(`${file} is byte-for-byte what it was`, () => {
      expect(sha256(read(file))).toBe(want)
    })
  }

  it('BeeHub.jsx is the pushed file plus the sheet wiring, and nothing else', () => {
    expect(sha256(withoutTheSheet(read('components/BeeHub.jsx')))).toBe(HUB_AT_SLICE_3)
  })

  it('the wiring shows the sheet only where the new list is shown, and the old record everywhere else', () => {
    const hub = read('components/BeeHub.jsx')
    const block = hub.slice(hub.indexOf(BLOCK_START), hub.indexOf(BLOCK_END) + BLOCK_END.length)
    expect(block).toContain('{selected&&newList&&(\n        <ContactSheet')
    expect(hub.split('<ContactSheet').length - 1).toBe(1)
    // The old record follows straight on, under "not the new list".
    const after = hub.slice(hub.indexOf(BLOCK_END) + BLOCK_END.length, hub.indexOf(BLOCK_END) + BLOCK_END.length + 200)
    expect(after).toContain('NetworkPersonRecord')
  })

  it('the old contact save route is not what the sheet calls', () => {
    const sheet = read('components/network/ContactSheet.jsx')
    expect(sheet).toContain('/api/network/contacts/')
    // The one time it names the old address is to READ the referral count.
    const old = sheet.split('\n').filter((l) => l.includes('/api/partners'))
    expect(old.map((l) => l.trim())).toEqual(['doFetch(`/api/partners/${contactId}/referrals`)'])
    // Every write the sheet can send, by address and kind. Slice 4b added the
    // last five on purpose: a note and addresses through the sheet's own
    // save, and a touchpoint, a follow-up and tags through the routes Bee Hub
    // already had for them. Nothing else, and never a write to /api/partners.
    const writes = Array.from(sheet.matchAll(/call\((['`][^'`]+['`]), '(POST|PATCH|DELETE)'/g)).map((m) => `${m[2]} ${m[1]!.slice(1, -1).split('?')[0]}`)
    expect(writes).toEqual([
      // slice 6: a confirmed level or stage change, through the same save
      'PATCH /api/network/contacts/${contactId}',
      'POST /api/touchpoints',
      'PATCH /api/network/contacts/${contactId}',
      'POST /api/reminders',
      'POST /api/partner-tags',
      'DELETE /api/partner-tags',
      'POST /api/lookups',
      'PATCH /api/network/contacts/${contactId}',
    ])
    // Outside that one helper there is a single direct write: the name form.
    const direct = sheet.split('\n').filter((l) => /method: '(GET|POST|PUT|PATCH|DELETE)'/.test(l))
    expect(direct).toHaveLength(1)
    expect(direct[0]).toContain("'PATCH'")
  })
})
