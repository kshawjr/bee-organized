// WHAT SLICE 5 TOUCHED, AND WHAT IT DID NOT (Network & Nurture, slice 5:
// add a contact, CSV in and out).
//
// Pinned by fingerprint (sha256 of the bytes), as slice 4a did. Every file
// below is byte-for-byte what it was on main at 70eab32, the commit slice 5
// was built on. They are the doors an owner, manager, read-only or corporate
// user can reach, the old Network screens and their save path, the tag and
// phone rules the new doors lean on, the gate, and the slice 1 CSV module
// the brief said to leave alone.
//
// BeeHub.jsx differs from 70eab32 by exactly one line (a contact the host's
// list does not hold yet still opens in the sheet); the second test proves
// that by putting the old line back and comparing.
//
// A later slice that changes one of these ON PURPOSE refreshes its pin here
// and says so.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { withoutClickAway } from './click-away-footprint'
import { join } from 'node:path'

// BeeHub.jsx and hive/NetworkScreen.jsx: the click-away pass (2026-11-19) is taken back out first (click-away-footprint.ts).
const read = (p: string) => withoutClickAway(p, readFileSync(join(process.cwd(), p), 'utf8'))
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const AT_70EAB32: Record<string, string> = {
  // the old Network screens and their save path
  'components/hive/NetworkPersonRecord.jsx': 'a442dad80a382832e0f650105fe4f20b37fd59d0286de46429e60d03bb518847',
  'components/hive/NetworkScreen.jsx': '634bb1f08819400cbe4e516b7d8329624a634fa85b181d4d2d74afbabc72eec4',
  'components/hive/NetworkCompanyRecord.jsx': '96cd651dec0869285ada4392e493cf1cad1beebf9dd114a5e46919a735c5ab22',
  'app/api/partners/[id]/route.ts': '0b15077e5dd127dd907fcfaee92394988c6e0c6aa65a1c3362a35b213e87cf7a',
  // Changed ON PURPOSE after this slice: Referred by › Create now sets the contact's type (clients-doors-footprint.test.ts).
  'app/api/partners/route.ts': 'b9ae5129957215a2727a64c130de303ab94422a3182bf77cb0137d332532a48f',
  'lib/partner-writes.ts': 'c63675a136e1aa5c3db2c65b49f6d08b06939c3245099b488bc799b1bfa4ad25',
  'lib/crm.ts': '0f15c0b894575bbc93287b9e8d3664efca3949327af030d78ba351ddbb74acbb',
  // reminders, tags, phones, read-only: read by the new doors, not changed
  'app/api/reminders/route.ts': 'ac50556b4dbb5fe99a59e5eb4e82ec6eb6226f16ff370996cb16118da7e0dfe8',
  'app/api/partner-tags/route.ts': 'c5c2a0d881a2fa57ba8e57d270cf0a869dd64367f88e472684a57f7201406daa',
  'app/api/lookups/route.ts': 'fd4e56c6ec43d06eceb2cd5ad28e0301a0b700f5c850c8fe13d8445a10fa2529',
  'lib/tags.ts': '8ac6a0073785ff5d911175a411592fa5a1c1c6e99a1b1457b2ae651728dca622',
  'lib/phone.ts': 'b873e646b26eb0af8d7ec16d397e6aa0acd90bd33163204b8b13d1ba4403f91c',
  'lib/phone-note.ts': 'c1867e2bf732747edad578c42666252beee6e1c30ffb97a0872256759cbdbe4c',
  'lib/partner-tag-writes.ts': '524538baf61c01a8b83d40d5c6adedf9aad5687198d7708d058057e47c83655b',
  'lib/read-only-access.ts': '5401c65cf277c0bf52c4847b7f287913c46d6915e6bba473eca79fec85d023d9',
  'middleware.ts': '6a17cfac0bc06dce536a02027dcc93f10823d9a70129d2ba35e7e1481b925ead',
  // the gate: still super admins only
  'lib/network/access.ts': '2c76af86bf29a4725d279317cb1aa57cc9d189db0d38241e50e6bb19fe9fe546',
  // slice 1's CSV module: "done, leave it". Refreshed ON PURPOSE by the
  // third follow-up (2026-11-19): it now reads First name / Last name
  // columns and sets the three name columns (lib/network/names.ts).
  // And by the slice 6 feedback (2026-11-19): the import's Type help names
  // unsure first, the same order as everywhere else.
  'lib/network/csv.ts': '74ff110c5cc5146eb6eb25c0c3525dfaea1dada63d4dd2ef47134dff9031bdaf',
  // the sheet's own save route and rules, and the tag box: reused, not changed
  // Refreshed ON PURPOSE (2026-11-19): the sheet edits a person's first and
  // last name, and the save sets the full name from them (contact-edit.ts).
  // Slice 6 (2026-11-19): a confirmed partner level or stage, same save.
  'app/api/network/contacts/[id]/route.ts': '08a80794133107bad58e0034c17943fe0344a15eaf7e03b32e20a366e72d9773',
  'app/api/network/summary/route.ts': '075d9fd79131455d016943d5ece20127f5cd2601bbd0ebc191544f83c074c74b',
  'lib/network/contact-edit.ts': '9908264b7975bcd98f8bb647fabedce9714ec3296eb78e0128f7703c81b70d90',
  'lib/network/contact-adds.ts': '7ccf90c5e93ecd106df3103745efdb6726cb9659044a5281aae8034135440bb4',
  // Refreshed ON PURPOSE by the third follow-up: firstName / lastName on NetContact.
  // And by the slice 6 feedback (Kevin, 2026-11-19): Not sure yet first in NET_TYPES.
  'lib/network/types.ts': '9bdb9958b334623c733eadf9f00959243bf0ce3b071f4148cfe719ef3240325d',
  'components/network/TagDialog.jsx': '3b3f519293dde0230ebd26174a98a757c92801d2de87883f2d55061da59e3bc5',
}

const HUB_AT_70EAB32 = 'e37c6794ec4d5bec00f0b350304e940b9e5ea6c32562198a734be2566ae5dd64'
const OPEN_THEN = "const p = allPartners.find(x=>x.id===id); if (p) setSelected(p) }}"
const OPEN_NOW = "const p = allPartners.find(x=>x.id===id); setSelected(p || { id }) }}"

describe('slice 5 left everything outside the new Network screens alone', () => {
  for (const [file, want] of Object.entries(AT_70EAB32)) {
    it(`${file} is byte-for-byte what it was at 70eab32`, () => {
      expect(sha256(read(file))).toBe(want)
    })
  }

  it('BeeHub.jsx is 70eab32 with one line changed, and nothing else', () => {
    const hub = read('components/BeeHub.jsx')
    expect(hub.split(OPEN_NOW).length - 1).toBe(1)
    expect(sha256(hub.replace(OPEN_NOW, OPEN_THEN))).toBe(HUB_AT_70EAB32)
  })

  it('that one line only runs where the new list is shown, inside one location', () => {
    const hub = read('components/BeeHub.jsx')
    const at = hub.indexOf(OPEN_NOW)
    const line = hub.slice(hub.lastIndexOf('\n', at) + 1, hub.indexOf('\n', at))
    expect(line.trim().startsWith("onOpenContact={locFilter==='all' ? null :")).toBe(true)
    // ...and it is a prop of the new list, not of the old screen.
    const before = hub.slice(0, at)
    expect(before.lastIndexOf('<NetworkListScreen')).toBeGreaterThan(before.lastIndexOf('<NetworkScreen'))
  })

  it('the new list, add box and import box write only through the new routes and /api/lookups', () => {
    const writes = (file: string) => Array.from(read(file).matchAll(/['`](\/api\/[^'`?$]+)/g)).map((m) => m[1])
    expect(new Set(writes('components/network/AddContactDialog.jsx'))).toEqual(new Set(['/api/lookups', '/api/network/contacts']))
    expect(new Set(writes('components/network/ImportDialog.jsx'))).toEqual(new Set(['/api/network/import']))
    // Slice 6: the list reads the location's tags (for bulk tags) and sends one
    // write, the confirmed bulk action.
    expect(new Set(writes('components/network/NetworkListScreen.jsx'))).toEqual(new Set(['/api/network/list', '/api/network/summary', '/api/lookups', '/api/network/contacts/bulk']))
  })
})
