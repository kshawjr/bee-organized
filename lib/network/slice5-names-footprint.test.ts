// WHAT THE THIRD FOLLOW-UP (names, other programs' files, one Add button)
// TOUCHED OUTSIDE NETWORK: NOTHING. Pinned by fingerprint (sha256) at
// ec19879, the commit it was built on. These are the Clients name rules it
// follows but must not change, the client routes that use them, the host
// screen, and the shared rules Network leans on. (slice5-footprint.test.ts
// still pins the old Network screens, the gate, tags and phones.)
//
// lib/db-columns.snapshot.txt is NOT pinned here: the migration adds three
// columns, and the snapshot is regenerated from production after Kevin runs
// it, in the same commit (lib/db-columns-check.ts says how).
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sha256 = (p: string) => createHash('sha256').update(readFileSync(join(process.cwd(), p), 'utf8')).digest('hex')

const AT_EC19879: Record<string, string> = {
  'lib/lead-name.ts': '91605df028704d2bc96a818b702de2603cd34493159f0d74b9cc683f01c3c094',
  'lib/name-prefill.ts': '5f35c32045f715c98d77ede6119b35ecf6eb57eae895cebc3141e71b3dbb31c9',
  'app/api/leads/route.ts': 'd669d870d095c6d6b36bd35ff3e46d255820e3ee0419653aa296e9df23f0b8fe',
  'app/api/leads/intake/route.ts': '2397d4c079916d719a6f0ac4f6e90088718052e1b890c698f4a2e27af9808115',
  'app/api/leads/[id]/route.ts': 'a8eef021b78ee2e6b8154598f27256548b110a46b935e61df68648825825b277',
  'components/BeeHub.jsx': '0b1e8e7b67d42aaf77075f0b480731fb4d82a2e60802a76d150ed0d25d4fce04',
  'lib/phone.ts': 'b873e646b26eb0af8d7ec16d397e6aa0acd90bd33163204b8b13d1ba4403f91c',
  'lib/tags.ts': '8ac6a0073785ff5d911175a411592fa5a1c1c6e99a1b1457b2ae651728dca622',
  'middleware.ts': '6a17cfac0bc06dce536a02027dcc93f10823d9a70129d2ba35e7e1481b925ead',
}

describe('the third follow-up changed nothing outside Network', () => {
  for (const [file, want] of Object.entries(AT_EC19879)) {
    it(`${file} is byte-for-byte what it was at ec19879`, () => expect(sha256(file)).toBe(want))
  }
})
