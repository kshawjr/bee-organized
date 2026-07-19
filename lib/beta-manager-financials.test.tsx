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
    expect(beehub).toContain('(canSeeFinancials && agingInvoices.length > 0)')
    expect(beehub).toContain('canSeeFinancials && <HomeMetricTile label="Outstanding"')
  })
})

describe('Reports — financial sections split from operational', () => {
  // File order: FranchiseReports → ReportsComingSoonPlaceholder → ReportsScreen.
  const franchise = slice('function FranchiseReports', 'function ReportsComingSoonPlaceholder')
  const reports = slice('function ReportsScreen', 'function PaymentConfirmStep')

  it('ReportsScreen receives franchiseRole and computes the shared predicate', () => {
    expect(reports).toContain('function ReportsScreen({ role, franchiseRole')
    expect(reports).toContain('const canSeeFinancials = financialsVisible(role, franchiseRole)')
    expect(reports).toContain('canSeeFinancials={canSeeFinancials}')
  })

  it('ReportsScreen mount passes franchiseRole through', () => {
    const app = slice('export default function App', 'Responsive sidebar')
    expect(app).toContain('<ReportsScreen role={role} franchiseRole={franchiseRole}')
  })

  it('FranchiseReports accepts the gate and hides the Revenue KPI when off', () => {
    expect(franchise).toContain('canSeeFinancials=true }')
    // Revenue KPI is conditionally spread into the kpis array
    expect(franchise).toMatch(/canSeeFinancials \? \[\{ label:'Revenue'/)
    // grid columns track the card count so 2 cards don't leave a phantom column
    expect(franchise).toContain('repeat(${kpis.length},1fr)')
  })

  it('FranchiseReports hides the Revenue Trend card when off', () => {
    // the Revenue Trend ReportCard is wrapped in the gate
    const trend = franchise.slice(franchise.indexOf('Revenue trend'))
    expect(franchise).toMatch(/\{canSeeFinancials && \(\s*<ReportCard title="Revenue Trend"/)
    // sanity: the trend section still exists (not deleted)
    expect(trend).toContain('Monthly collected revenue')
  })

  it('operational sections stay UNGATED (manager keeps them)', () => {
    // Pipeline / Funnel / Sources / Service Types / Referrals must not be
    // wrapped by canSeeFinancials — pin they render unconditionally.
    for (const title of ['My Pipeline', 'Conversion Funnel', 'Partner Referrals']) {
      const idx = franchise.indexOf(title)
      expect(idx).toBeGreaterThan(-1)
      // no canSeeFinancials guard immediately preceding these cards
      const preceding = franchise.slice(Math.max(0, idx - 120), idx)
      expect(preceding).not.toContain('canSeeFinancials')
    }
  })
})
