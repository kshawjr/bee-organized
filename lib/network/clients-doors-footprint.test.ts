// WHAT CONVERTING THE TWO CLIENTS DOORS TOUCHED: only these.
//   app/api/partners/route.ts            (Referred by › Create; sets the type)
//   app/api/leads/[id]/network/route.ts  (Add / Move to Network; sets the type)
//   components/hive/ReferrerPicker.jsx   (says the contact is a referrer)
//   lib/network/new-contact-type.ts      (new: the slice 2 rule for a new contact)
// Everything else they lean on, the Network screens, the gate and the old
// Network screen's own files, is pinned here by fingerprint (sha256) at
// 0c61afc, the commit this was built on.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sha256 = (p: string) => createHash('sha256').update(readFileSync(join(process.cwd(), p), 'utf8')).digest('hex')

const AT_0C61AFC: Record<string, string> = {
  'components/BeeHub.jsx': '0b1e8e7b67d42aaf77075f0b480731fb4d82a2e60802a76d150ed0d25d4fce04',
  'lib/crm.ts': '0f15c0b894575bbc93287b9e8d3664efca3949327af030d78ba351ddbb74acbb',
  'lib/tags.ts': '8ac6a0073785ff5d911175a411592fa5a1c1c6e99a1b1457b2ae651728dca622',
  'lib/partner-tag-writes.ts': '524538baf61c01a8b83d40d5c6adedf9aad5687198d7708d058057e47c83655b',
  'lib/lead-to-network.ts': '76807abc8b63bf214a199bca0ec61568c270c9e85276480204d9cefdf1e516d2',
  'lib/network/access.ts': '2c76af86bf29a4725d279317cb1aa57cc9d189db0d38241e50e6bb19fe9fe546',
  'lib/network/live-mapping.ts': '66130cbd4cd5b3097f728aebfd0411f4daf891ec5d09d5e123a29f67c02d9df3',
  // Refreshed ON PURPOSE by the slice 6 feedback (Kevin, 2026-11-19): Not sure
  // yet moved to the front of NET_TYPES. Nothing else in the file changed.
  'lib/network/types.ts': '9bdb9958b334623c733eadf9f00959243bf0ce3b071f4148cfe719ef3240325d',
  'lib/network/contact-create.ts': '6b7853d51ed4860c65f37fd4bf445d970ed186bd0457d22a1b688bc7660e54d2',
  'lib/network/contact-writes.ts': '5c067c66b8f4bc7200a0125103d5d6565cea6a499c42ebfd418056940d3b6793',
  'middleware.ts': '6a17cfac0bc06dce536a02027dcc93f10823d9a70129d2ba35e7e1481b925ead',
  'app/api/partners/[id]/route.ts': '0b15077e5dd127dd907fcfaee92394988c6e0c6aa65a1c3362a35b213e87cf7a',
  'app/api/partner-tags/route.ts': 'c5c2a0d881a2fa57ba8e57d270cf0a869dd64367f88e472684a57f7201406daa',
  'app/api/touchpoints/route.ts': '33d10fb808c542286114753217e81789b4dc24e4bbb37777a142cafb76cbb01d',
  'app/api/leads/route.ts': 'd669d870d095c6d6b36bd35ff3e46d255820e3ee0419653aa296e9df23f0b8fe',
  'app/api/leads/[id]/route.ts': 'a8eef021b78ee2e6b8154598f27256548b110a46b935e61df68648825825b277',
  'app/api/network/contacts/route.ts': 'd7727d16c7efcb4122f7394626f9e8f67165ec3f0f6b5695702e754ff99ea541',
  'app/api/network/import/route.ts': '020af53a04643d7333f9c9864c4a3d97e124b52e7759859ed029b69cc94f9aa8',
  'components/hive/NetworkConvertSheet.jsx': '7ecca6bdca2358cfc3cb2adf2c512b5849c68b0365d2d72869b9d4cf1cf258dc',
  'components/hive/shared/ReferrerField.jsx': '48658165103606f2c4e4b932337848ea851d0d5b52afe4b1a8bdd97c45fa685d',
  'components/hive/NetworkAddSheet.jsx': 'f30532bdd360cbafb16b045ef54879dd7d9a03797b8c3d27015fc6fc7b5f03e7',
  'lib/network/doors.test.tsx': 'a3ad747d9b3e5702f6d5acadd9cad170c028ecce972ba07648056dd8e85e09f6',
}

describe('converting the Clients doors changed nothing else', () => {
  for (const [file, want] of Object.entries(AT_0C61AFC)) {
    it(`${file} is byte-for-byte what it was at 0c61afc`, () => expect(sha256(file)).toBe(want))
  }
})
