// Admin Webhooks tab — source pins for the sync-log dashboard.
//
// Source pins (AdminWebhookLogScreen is a BeeHub.jsx internal — same
// pattern as beta-feedback-triage-ui):
//
//   1) ROLE GATE: the tab shows for super_admin + admin ONLY (corporate
//      stays out, unlike Feedback), and the API route enforces the same
//      two roles server-side — this is operational/sensitive data.
//
//   2) TWO INDICATORS: Processed (green ✓ / red ✕) and Landed (green ✓ /
//      amber ▲ / em-dash). The amber "didn't land" state is visually
//      distinct (amber #FEF3C7 chip + tinted row) — it's the silent-stuck
//      case the whole feature exists to surface.
//
//   3) FAILED-ROW ERROR: rows with an error (and amber rows) expand to
//      show the message with a Copy affordance — that's what the admin
//      pastes into a bug report.
//
//   4) SEARCH + FILTERS: client-name/job-id/event-type search, pills for
//      All / Failures / Didn't land, time-window pills, location select.
//
//   5) DEEP LINK: /admin?adminTab=webhooks&whFilter=…&whWindow=… — the
//      Slack digest links land pre-filtered.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
const route  = readFileSync(join(process.cwd(), 'app/api/admin/webhook-log/route.ts'), 'utf8')

describe('admin webhooks tab — role gating', () => {
  it('tab visibility is super_admin + admin only (no corporate)', () => {
    expect(beehub).toMatch(/const showWebhooksTab = role === 'super_admin' \|\| role === 'admin'/)
    expect(beehub).toMatch(/\.\.\.\(showWebhooksTab\?\[\{key:'webhooks',label:'🔌 Webhooks'\}\]:\[\]\)/)
  })

  it('render branch mounts AdminWebhookLogScreen for the webhooks tab', () => {
    expect(beehub).toMatch(/adminTab==='webhooks' \? \(\s*<AdminWebhookLogScreen \/>/)
  })

  it('API route allows super_admin + admin only and 403s everyone else', () => {
    expect(route).toMatch(/const ELEVATED_ROLES = \['super_admin', 'admin'\]/)
    expect(route).toMatch(/ELEVATED_ROLES\.includes\(caller\.role\)/)
    expect(route).toContain("{ error: 'forbidden' }, { status: 403 }")
    expect(route).toContain("{ error: 'unauthorized' }, { status: 401 }")
  })

  it('API route validates the window param against the known set', () => {
    expect(route).toMatch(/VALID_WINDOWS = new Set<FetchWindow>\(\['24h', '7d', '30d', 'all'\]\)/)
  })
})

describe('admin webhooks tab — indicators', () => {
  const screen = beehub.slice(
    beehub.indexOf('function AdminWebhookLogScreen'),
    beehub.indexOf('// Timezone options for the Create Location form'),
  )

  it('renders both indicator columns with a header strip', () => {
    expect(screen).toContain('>Processed<')
    expect(screen).toContain('>Landed<')
    expect(screen).toContain('>When<')
  })

  it('Processed maps to ok/fail chips; Landed maps ok/stuck/na', () => {
    expect(screen).toMatch(/kind=\{e\.processed \? 'ok' : 'fail'\}/)
    expect(screen).toMatch(/kind=\{e\.landed === 'landed' \? 'ok' : e\.landed === 'stuck' \? 'stuck' : 'na'\}/)
  })

  it("amber didn't-land is visually distinct (amber chip + tinted row)", () => {
    // chip anatomy
    expect(beehub).toMatch(/stuck: \{ bg:'#FEF3C7',\s*fg:'#92400E', glyph:'▲' \}/)
    expect(beehub).toMatch(/fail: {2}\{ bg:'#FCEBEB',\s*fg:'#791F1F', glyph:'✕' \}/)
    // row tint for stuck rows
    expect(screen).toContain("e.landed === 'stuck' ? 'rgba(254,243,199,0.35)' : 'transparent'")
  })

  it('failed and stuck rows expand to the message with a Copy affordance', () => {
    expect(screen).toContain("const expandable = !!e.error || e.landed === 'stuck'")
    expect(screen).toContain('navigator.clipboard.writeText(e.message)')
    expect(screen).toMatch(/\{e\.error \|\| e\.message\}/)
    expect(screen).toContain("hadn't reached its expected state")
  })
})

describe('admin webhooks tab — search, filters, deep link', () => {
  const screen = beehub.slice(
    beehub.indexOf('function AdminWebhookLogScreen'),
    beehub.indexOf('// Timezone options for the Create Location form'),
  )

  it('searches client name, jobber item id, topic, and message', () => {
    expect(screen).toContain('Search by client name, job id, event type')
    expect(screen).toMatch(/\$\{e\.client_name \|\| ''\} \$\{e\.topic \|\| ''\} \$\{e\.friendly \|\| ''\} \$\{e\.jobber_item \|\| ''\} \$\{e\.message \|\| ''\}/)
  })

  it("has All events / Failures / Didn't land pills and time-window pills", () => {
    expect(screen).toContain("label:'All events'")
    expect(screen).toContain("label:'Failures'")
    expect(screen).toContain(`label:"Didn't land"`)
    expect(beehub).toMatch(/WEBHOOK_WINDOWS = \[\s*\{ key:'24h'/)
  })

  it('has a location filter fed by the loaded events', () => {
    expect(screen).toContain('All locations')
    expect(screen).toMatch(/locFilter !== 'all' && e\.location_id !== locFilter/)
  })

  it('deep-links via adminTab + whFilter/whWindow params', () => {
    expect(beehub).toMatch(/if \(t === 'webhooks' && showWebhooksTab\) setAdminTab\('webhooks'\)/)
    expect(screen).toContain("p.get('whFilter')")
    expect(screen).toContain("p.get('whWindow')")
  })
})
