// Remove the "Client Stages" picklist from admin Configure (Kevin 7/11).
//
// The lookups category `client_stages` ("Kanban columns for the Hive (Clients)
// screen") was fully inert dead config: the Hive board/list/filters render their
// columns from the hardcoded ENGAGEMENT_STAGES stage machine, NOT the picklist,
// and getClientStages() — the only reader of the edited value — had ZERO callers.
// Its fallback showed the stale Phase-0 vocabulary ("Estimate Sent" vs the real
// "Estimate"). Kevin's decision was REMOVE (not make editable): the engagement
// stage set is derivation-owned + DB-CHECK-locked + rank-gated and must not be
// admin-editable in any form. This pins the removal and guards the load-bearing
// pieces that must NOT change.
//
// Source-pin (readFileSync) — the Configure registry and the dead getter were
// module-internal to BeeHub.jsx (never exported), same approach as the sibling
// beta-partner-picklists source-pin.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const HUB = readFileSync('components/BeeHub.jsx', 'utf8')
const STAGE_CONFIG = readFileSync('components/hive/shared/stageConfig.js', 'utf8')
const STAGE_RANK = readFileSync('components/hive/shared/stageRank.js', 'utf8')
const BOARD = readFileSync('components/hive/EngagementBoard.jsx', 'utf8')

describe('A) Client Stages no longer appears in admin Configure', () => {
  it('the picklist registration entry is gone (no label / description)', () => {
    expect(HUB).not.toMatch(/label:\s*'Client Stages'/)
    expect(HUB).not.toMatch(/Kanban columns for the Hive/)
    expect(HUB).not.toMatch(/syncGetter:\s*'client_stages'/)
  })
  it('the CLIENTS Configure section no longer lists the client_stages tile', () => {
    const clientsSection = HUB.slice(HUB.indexOf("key: 'CLIENTS'"), HUB.indexOf("key: 'CLIENTS'") + 200)
    expect(clientsSection).not.toContain('client_stages')
  })
})

describe('B) the dead getter/setter/module-var + stale fallback wiring are removed', () => {
  it('getClientStages / setAdminClientStages / _clientStages no longer exist', () => {
    expect(HUB).not.toContain('getClientStages')
    expect(HUB).not.toContain('setAdminClientStages')
    expect(HUB).not.toContain('_clientStages')
  })
  it('no client_stages hydration or ConfigureTab write-path case remains', () => {
    expect(HUB).not.toContain('client_stages')
  })
})

describe('C) regression — the classic (non-Hive) STAGES const stays, still consumed', () => {
  // STAGES is NOT dead: the PersonCard/pipeline views in BeeHub render from it in
  // ~18 places. It was the picklist's stale FALLBACK, but removing it would break
  // the classic board. It must survive the picklist removal.
  it('the STAGES const is still defined', () => {
    expect(HUB).toMatch(/const STAGES = \[/)
  })
  it('the classic board still reads STAGES directly (consumers intact)', () => {
    expect(HUB).toMatch(/\bSTAGES\.find\b/)
    expect(HUB).toMatch(/\bSTAGES\.filter\b/)
  })
})

describe('D) regression — the Hive board columns still come from ENGAGEMENT_STAGES, unchanged', () => {
  it('EngagementBoard derives its columns from ENGAGEMENT_STAGES, not any picklist', () => {
    expect(BOARD).toMatch(/const BOARD_STAGES = ENGAGEMENT_STAGES\.filter\(s => !s\.terminal\)/)
    expect(BOARD).not.toContain('client_stages')
    expect(BOARD).not.toContain('getClientStages')
  })
  it('the derivation-owned canonical stage set is untouched (6 keys, same rank table)', () => {
    for (const key of ['Request', 'Estimate', 'Job in Progress', 'Final Processing', 'Closed Won', 'Closed Lost']) {
      expect(STAGE_CONFIG).toContain(`'${key}'`)
      expect(STAGE_RANK).toContain(`'${key}'`)
    }
    // rank gating preserved: Request=0 … Closed Won/Lost=4
    expect(STAGE_RANK).toMatch(/'Request':\s*0/)
    expect(STAGE_RANK).toMatch(/'Closed Won':\s*4/)
    expect(STAGE_RANK).toMatch(/'Closed Lost':\s*4/)
  })
})
