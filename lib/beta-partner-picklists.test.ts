// Admin picklist wiring (Kevin 7/11) — three Partners picklists that were DEAD
// config are now fed by their admin-managed getters, mirroring the already-live
// Partner Tiers wiring (getPartnerTiers). The pins:
//
//   A) Partner Specialties  — every Partners surface reads getSpecialties(),
//      never a bare SPECIALTIES.map / SPECIALTIES.find. (AddPartnerModal,
//      SpecialtyPopup, the filter-drawer chips, and the specialtyConf helper.)
//   B) Partner Stages       — Partner Kanban + filter chips + stage popup read
//      getPartnerStages(); partnerStageConf resolves through it too.
//   C) Touchpoint Types     — TouchpointPopup renders + resolves via
//      getTouchpointTypes().
//   D) Getters fall back to their const so a fresh/unmigrated env still renders.
//   E) Store hydration reshapes the partner_specialties / partner_stages /
//      touchpoint_types lookup categories into the const shape, PRESERVING
//      color/bg (+ icon/dot for stages, icon for touchpoints) so admin brand
//      colors flow through — a naive swap that dropped these would render
//      broken chips.
//   F) Regression: Partner Tiers stays wired (getPartnerTiers, no bare
//      PARTNER_TIERS.map/.find leaked back in).
//
// Source-pin (readFileSync) rather than render: the Partners components and the
// getters are module-internal to BeeHub.jsx (not exported), so we pin the wiring
// at the source the same way the inline-edit standard pins descBlock.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync('components/BeeHub.jsx', 'utf8')

// The UI region only — excludes the getter fallbacks and const definitions near
// the top of the file so `_specialties || SPECIALTIES` doesn't read as a UI call
// site. The Partners UI + helpers all live well past line 13000.
const UI = SRC.slice(SRC.indexOf('const PARTNER_STAGES = ['))

describe('A) Partner Specialties read the admin getter, not the const', () => {
  it('no Partners surface reads SPECIALTIES directly (.map/.find)', () => {
    expect(UI).not.toMatch(/\bSPECIALTIES\.map\b/)
    expect(UI).not.toMatch(/\bSPECIALTIES\.find\b/)
  })
  it('the specialtyConf helper resolves through getSpecialties()', () => {
    expect(SRC).toMatch(/function specialtyConf\(id\)\s*\{\s*return getSpecialties\(\)\.find/)
  })
  it('all three specialty render sites (two picklists + filter chips) call getSpecialties()', () => {
    // AddPartnerModal grid, SpecialtyPopup grid, filter-drawer chips.
    expect((UI.match(/getSpecialties\(\)\.map/g) || []).length).toBeGreaterThanOrEqual(3)
  })
})

describe('B) Partner Stages read the admin getter, not the const', () => {
  it('no Partner Kanban / popup / filter surface reads PARTNER_STAGES directly', () => {
    expect(UI).not.toMatch(/\bPARTNER_STAGES\.map\b/)
    expect(UI).not.toMatch(/\bPARTNER_STAGES\.find\b/)
    expect(UI).not.toMatch(/\bPARTNER_STAGES\[/)
  })
  it('partnerStageConf resolves through getPartnerStages()', () => {
    expect(SRC).toMatch(/function partnerStageConf\(key\)[^\n]*getPartnerStages\(\)/)
  })
  it('the stage popup + filter chips call getPartnerStages()', () => {
    expect((UI.match(/getPartnerStages\(\)\.map/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('C) Touchpoint Types read the admin getter, not the const', () => {
  it('TouchpointPopup never reads TOUCHPOINT_TYPES directly', () => {
    expect(UI).not.toMatch(/\bTOUCHPOINT_TYPES\.map\b/)
    expect(UI).not.toMatch(/\bTOUCHPOINT_TYPES\.find\b/)
  })
  it('both the render grid and the save resolver call getTouchpointTypes()', () => {
    expect(UI).toMatch(/getTouchpointTypes\(\)\.map/)
    expect(UI).toMatch(/getTouchpointTypes\(\)\.find/)
  })
})

describe('D) getters fall back to their const for fresh/unmigrated envs', () => {
  it('getSpecialties / getPartnerStages / getTouchpointTypes default to the const', () => {
    expect(SRC).toMatch(/function getSpecialties\(\)\s*\{\s*return _specialties \|\| SPECIALTIES\s*\}/)
    expect(SRC).toMatch(/function getPartnerStages\(\)\s*\{\s*return _partnerStages \|\| PARTNER_STAGES\s*\}/)
    expect(SRC).toMatch(/function getTouchpointTypes\(\)\s*\{\s*return _touchpointTypes \|\| TOUCHPOINT_TYPES\s*\}/)
  })
})

describe('E) admin edits flow to the getters, shape preserved (color/bg/icon)', () => {
  it('App() server-side hydration feeds the three categories to their setAdmin* setters', () => {
    expect(SRC).toMatch(/initialLookups\.partner_specialties\)\)\s*setAdminSpecialties\(toSpecialtyShape/)
    expect(SRC).toMatch(/initialLookups\.partner_stages\)\)\s*setAdminPartnerStages\(toStageShape/)
    expect(SRC).toMatch(/initialLookups\.touchpoint_types\)\)\s*setAdminTouchpointTypes\(toTouchpointShape/)
  })
  it('the live ConfigureTab write path (pushLookupsToGetters) routes each category to its setter', () => {
    const push = SRC.slice(SRC.indexOf('function pushLookupsToGetters'), SRC.indexOf('function pushLookupsToGetters') + 2000)
    expect(push).toMatch(/case 'partner_specialties':\s*setAdminSpecialties\(/)
    expect(push).toMatch(/case 'partner_stages':\s*setAdminPartnerStages\(/)
    expect(push).toMatch(/case 'touchpoint_types':\s*setAdminTouchpointTypes\(/)
  })
  // The App() hydration mappers are the `(rows) => rows.map(r => …)` copies;
  // slice from that exact signature so we don't grab the pushLookupsToGetters
  // twins (which use a different closure var but the same shape).
  const mapperWindow = (sig: string) => {
    const at = SRC.indexOf(sig)
    return at === -1 ? '' : SRC.slice(at, at + 300)
  }
  it('specialty shape carries color + bg (chip brand colors)', () => {
    const shape = mapperWindow('const toSpecialtyShape = (rows)')
    expect(shape).toMatch(/color:\s*r\.color/)
    expect(shape).toMatch(/bg:\s*r\.bg_color/)
  })
  it('stage shape carries color + bg + dot + icon', () => {
    const shape = mapperWindow('const toStageShape = (rows)')
    expect(shape).toMatch(/color:\s*r\.color/)
    expect(shape).toMatch(/bg:\s*r\.bg_color/)
    expect(shape).toMatch(/dot:\s*r\.color/)
    expect(shape).toMatch(/icon:\s*r\.icon/)
  })
  it('touchpoint shape carries key + icon + label', () => {
    const shape = mapperWindow('const toTouchpointShape = (rows)')
    expect(shape).toMatch(/icon:\s*r\.icon/)
    expect(shape).toMatch(/key:/)
    expect(shape).toMatch(/label:\s*r\.label/)
  })
})

describe('F) regression: Partner Tiers stays wired', () => {
  it('the tier surfaces still read getPartnerTiers(), no bare PARTNER_TIERS leaked back', () => {
    expect(UI).toMatch(/getPartnerTiers\(\)\.map/)
    expect(UI).toMatch(/getPartnerTiers\(\)\.find/)
    expect(UI).not.toMatch(/\bPARTNER_TIERS\.map\b/)
    expect(UI).not.toMatch(/\bPARTNER_TIERS\.find\b/)
  })
})
