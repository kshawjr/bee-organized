// Webhooks in SuperAdminLayout — source pins for the elevated-admin mount.
//
// The webhook dashboard was originally wired only into the legacy AdminScreen
// tab strip, but super_admin users render SuperAdminLayout instead — so the
// person the dashboard was built for couldn't reach it. These pins hold the
// fix in place:
//
//   1) SIDEBAR: a Webhooks entry lives in the Advanced cluster, which is
//      super_admin-gated — corporate must NOT see it (webhook/Jobber-sync
//      internals are operational, not a corporate surface).
//
//   2) RENDER: renderContent's 'webhooks' case mounts AdminWebhookLogScreen
//      (screen carries its own header, like Feedback).
//
//   3) DEEP LINK: the Slack digest links /admin?adminTab=webhooks. The App
//      mount parses that into initialSection='webhooks' for super_admin, so
//      digest links work for elevated users too (legacy AdminScreen keeps its
//      own parse for franchise 'admin' users — pinned in beta-webhook-log).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
const digest = readFileSync(join(process.cwd(), 'lib/webhook-digest.ts'), 'utf8')

// SuperAdminLayout body (up to the legacy AdminScreen definition)
const layout = beehub.slice(
  beehub.indexOf('function SuperAdminLayout'),
  beehub.indexOf('function AdminScreen'),
)
// App body (holds the SuperAdminLayout mount + deep-link parse)
const app = beehub.slice(beehub.indexOf('export default function App'))

describe('superadmin webhooks — sidebar gating', () => {
  const groupsStart = layout.indexOf('const sidebarGroups')
  const groupsEnd   = layout.indexOf('const SECTION_META')
  const groups      = layout.slice(groupsStart, groupsEnd)

  it('Webhooks entry lives in the super_admin-only Advanced cluster', () => {
    // The Advanced group is the super_admin-gated one…
    expect(groups).toMatch(/\.\.\.\(role === 'super_admin' \? \[\{\s*header: 'Advanced',/)
    // …and the webhooks item sits inside it.
    const advanced = groups.slice(groups.indexOf("header: 'Advanced'"))
    expect(advanced).toMatch(/\{ key:'webhooks',\s*label:'Webhooks',\s*icon:'🔌' \}/)
  })

  it('Webhooks appears nowhere corporate can see it (only inside Advanced)', () => {
    // Exactly one sidebar item — not duplicated into Operations/Billing/etc.
    expect(groups.match(/key:'webhooks'/g)).toHaveLength(1)
    const beforeAdvanced = groups.slice(0, groups.indexOf("header: 'Advanced'"))
    expect(beforeAdvanced).not.toContain("key:'webhooks'")
  })

  it('SECTION_META maps webhooks into the Advanced cluster (breadcrumb)', () => {
    expect(layout).toMatch(/webhooks:\s*\{ label:'Webhooks',\s*cluster:'Advanced'\s*\}/)
  })
})

describe('superadmin webhooks — render + deep link', () => {
  it("renderContent 'webhooks' mounts AdminWebhookLogScreen", () => {
    expect(layout).toMatch(/case 'webhooks':[\s\S]*?<AdminWebhookLogScreen \/>/)
  })

  it('App parses ?adminTab=webhooks into the initial section, super_admin only', () => {
    expect(app).toMatch(/new URLSearchParams\(window\.location\.search\)\.get\('adminTab'\)/)
    expect(app).toMatch(/if \(t === 'webhooks' && role === 'super_admin'\) setAdminDeepLinkSection\('webhooks'\)/)
    expect(app).toMatch(/initialSection=\{adminDeepLinkSection \|\| 'dashboard'\}/)
  })

  it('the Slack digest URL uses the same adminTab param the mount honors', () => {
    expect(digest).toContain('/admin?adminTab=webhooks')
  })
})
