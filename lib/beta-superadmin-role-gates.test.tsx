// SuperAdminLayout role gates vs the legacy AdminScreen — source pins for the
// sibling-sweep fixes (follow-up to the webhooks mount, 70ab517).
//
//   1) CONTENT: the legacy tab strip showed Content to super_admin AND
//      corporate (Leslie edits the Hive Hub Guide), but the sidebar had it in
//      the super_admin-only Advanced cluster — corporate lost it when
//      elevated users moved to SuperAdminLayout. It now lives in Operations
//      behind the explicit legacy gate. Configure / Recycle Bin / Webhooks
//      stay super_admin-only.
//
//   2) RENEWALS: KEPT visible to corporate (ratified by Kevin, 7/10 PM). The Billing
//      cluster's per-item gating (Conversions and Pricing individually
//      super_admin-wrapped, Renewals not) is deliberate — flip by wrapping
//      the renewals item in a role === 'super_admin' spread if reversed.
//
//   3) DEEP LINK: /admin?adminTab=feedback now maps to the sidebar's Feedback
//      section for both elevated roles, mirroring the legacy
//      showFeedbackTab gate (webhooks stays super_admin-only — pinned in
//      beta-webhook-superadmin).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

// SuperAdminLayout body (up to the legacy AdminScreen definition)
const layout = beehub.slice(
  beehub.indexOf('function SuperAdminLayout'),
  beehub.indexOf('function AdminScreen'),
)
// App body (holds the SuperAdminLayout mount + deep-link parse)
const app = beehub.slice(beehub.indexOf('export default function App'))

const groupsStart = layout.indexOf('const sidebarGroups')
const groupsEnd   = layout.indexOf('const SECTION_META')
const groups      = layout.slice(groupsStart, groupsEnd)
const advanced    = groups.slice(groups.indexOf("header: 'Advanced'"))

describe('role gates — Content restored for corporate', () => {
  it('Content sits in Operations behind the legacy super_admin-or-corporate gate', () => {
    const operations = groups.slice(
      groups.indexOf("header: 'Operations'"),
      groups.indexOf("header: 'Billing'"),
    )
    expect(operations).toMatch(
      /\.\.\.\(role === 'super_admin' \|\| role === 'corporate' \? \[\{ key:'content',\s*label:'Content',\s*icon:'✏️' \}\] : \[\]\)/,
    )
    // Exactly one sidebar entry — not also left behind in Advanced.
    expect(groups.match(/key:'content'/g)).toHaveLength(1)
    expect(advanced).not.toContain("key:'content'")
  })

  it('SECTION_META breadcrumbs Content under Operations', () => {
    expect(layout).toMatch(/content:\s*\{ label:'Content',\s*cluster:'Operations'\s*\}/)
  })

  it('Configure, Recycle Bin and Webhooks stay inside the super_admin-only Advanced cluster', () => {
    // The Advanced group is still the super_admin-gated one…
    expect(groups).toMatch(/\.\.\.\(role === 'super_admin' \? \[\{\s*header: 'Advanced',/)
    // …and each restricted key appears exactly once, inside it.
    for (const key of ['configure', 'webhooks', 'bin']) {
      expect(groups.match(new RegExp(`key:'${key}'`, 'g'))).toHaveLength(1)
      expect(advanced).toContain(`key:'${key}'`)
    }
  })
})

describe('role gates — Renewals decision (KEEP corporate access)', () => {
  const billing = groups.slice(
    groups.indexOf("header: 'Billing'"),
    groups.indexOf("header: 'My Account'"),
  )

  it('Billing cluster renders for both elevated roles', () => {
    expect(groups).toMatch(
      /\.\.\.\(role === 'super_admin' \|\| role === 'corporate' \? \[\{\s*header: 'Billing',/,
    )
  })

  it('Renewals is NOT super_admin-wrapped; Conversions and Pricing are', () => {
    // Renewals: a bare item, visible to corporate.
    expect(billing).toMatch(/^\s*\{ key:'renewals',\s*label:'Renewals',\s*icon:'🕐' \},\s*$/m)
    // Conversions / Pricing: individually gated.
    expect(billing).toMatch(/\.\.\.\(role === 'super_admin' \? \[\{ key:'conversions',/)
    expect(billing).toMatch(/\.\.\.\(role === 'super_admin' \? \[\{ key:'pricing',/)
  })
})

describe('role gates — feedback deep link for elevated users', () => {
  it('App parses ?adminTab=feedback for both elevated roles', () => {
    expect(app).toMatch(
      /else if \(t === 'feedback' && \(role === 'super_admin' \|\| role === 'corporate'\)\) setAdminDeepLinkSection\('feedback'\)/,
    )
  })

  it('webhooks deep link stays super_admin-only (unchanged)', () => {
    expect(app).toMatch(/if \(t === 'webhooks' && role === 'super_admin'\) setAdminDeepLinkSection\('webhooks'\)/)
  })

  it("renderContent has a 'feedback' case for the deep link to land on", () => {
    expect(layout).toMatch(/case 'feedback':/)
  })
})
