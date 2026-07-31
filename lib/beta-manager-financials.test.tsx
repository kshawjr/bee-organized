// Manager financials gate — Hive Manager must NOT see money figures (revenue /
// collected / royalties) on the Home tile OR in Reports; owner + elevated still
// do; lite_user unchanged (never saw them). Kevin's call for the Hive Manager
// launch. One shared predicate (lib/financial-access.financialsVisible) drives
// both surfaces so they can't drift.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { financialsVisible } from '@/lib/financial-access'

describe('financialsVisible — the shared predicate', () => {
  it('shows financials to franchise OWNER', () => {
    expect(financialsVisible('franchise', 'owner')).toBe(true)
  })
  it('shows financials to elevated (super_admin / corporate)', () => {
    // elevated mounts pass franchiseRole='owner', but intent must hold for any value
    expect(financialsVisible('super_admin', 'owner')).toBe(true)
    expect(financialsVisible('corporate', 'owner')).toBe(true)
    expect(financialsVisible('super_admin', 'manager')).toBe(true)
    expect(financialsVisible('corporate', 'viewer')).toBe(true)
  })
  it('HIDES financials from franchise MANAGER', () => {
    expect(financialsVisible('franchise', 'manager')).toBe(false)
  })
  it('HIDES financials from lite_user (viewer / light / readonly)', () => {
    expect(financialsVisible('franchise', 'viewer')).toBe(false)
    expect(financialsVisible('franchise', 'light')).toBe(false)
    expect(financialsVisible('franchise', 'readonly')).toBe(false)
  })
  it('does not silently grant financials on unknown/missing role', () => {
    expect(financialsVisible(undefined, undefined)).toBe(false)
    expect(financialsVisible('franchise', undefined)).toBe(false)
    expect(financialsVisible(null, null)).toBe(false)
  })
})

const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

const slice = (from: string, to: string) => {
  const a = beehub.indexOf(from)
  const b = beehub.indexOf(to, a + 1)
  return a >= 0 && b >= 0 ? beehub.slice(a, b) : ''
}

describe('BeeHub wiring — one shared predicate, no drift', () => {
  it('imports the shared predicate from lib/financial-access', () => {
    expect(beehub).toContain('import { financialsVisible } from "@/lib/financial-access"')
  })

  it('Home tile gate uses the shared predicate, NOT the old !isLiteUser', () => {
    expect(beehub).toContain('const canSeeFinancials = financialsVisible(role, franchiseRole)')
    // the old permissive gate must be gone
    expect(beehub).not.toContain('const canSeeFinancials = !isLiteUser')
  })

  it('operational assessments signal is decoupled from the money gate (Home redesign)', () => {
    // Post-redesign the "Assessments today/tomorrow" signal is a Needs-attention
    // card + the Upcoming info list, shown to EVERY role — it must NOT be behind
    // canSeeFinancials (managers keep operational visibility). Money surfaces
    // (unpaid-invoices card + Outstanding metric) ARE gated.
    const idx = beehub.indexOf("key:'assessments-soon'")
    expect(idx).toBeGreaterThan(-1)
    const assessPush = beehub.slice(Math.max(0, idx - 120), idx)
    expect(assessPush).not.toContain('canSeeFinancials')
    // money cards remain money-gated
    // Phase 4 gave the hero cards explicit COUNT fields so 'all' (which has
    // numbers without rows) and a scoped load share one shape. The money gate
    // this test exists for is unchanged — still canSeeFinancials, still the
    // only thing between a manager and the unpaid-invoice card.
    expect(beehub).toContain('(canSeeFinancials && agingCount > 0)')
    expect(beehub).toContain('canSeeFinancials && <HomeMetricTile label="Outstanding"')
  })
})

// NOTE: the former "Reports — financial sections split from operational" block
// tested the Gen 1 FranchiseReports (revenue KPI / trend gating). Those sections
// were PURGED in issue 139 — Reports is now a role-independent Coming Soon state
// with no financial content to gate. Coverage moved to
// lib/beta-reports-coming-soon.test.tsx. The Home-tile financial gate above is
// unaffected and still tested here.
