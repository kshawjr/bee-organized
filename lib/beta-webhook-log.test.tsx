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
//   3) FAILED-ROW ERROR: ANY failed row shows its reason inline (no click)
//      and expands — including the pre-Phase-1 rows with no error= token
//      (reason falls back to the " — " tail, then the whole message).
//      The expanded panel shows the full raw message with a context-rich
//      Copy details block (pasteable into ClickUp/Slack) + a Copy raw
//      secondary.
//
//   4) SEARCH + FILTERS: client-name/job-id/event-type search, pills for
//      All / Failures / Didn't land, time-window pills, location select.
//
//   5) DEEP LINK: /admin?adminTab=webhooks&whFilter=…&whWindow=… — the
//      Slack digest links land pre-filtered.
//
//   6) INTAKE ROWS: LEAD_INTAKE failures with no client/jobber item show
//      the slug= from the message instead of 'Unknown record · Unknown
//      account' — a Make mapping typo reads straight off the row.

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

  it('ANY failed row and stuck rows expand to the full raw message', () => {
    // !e.processed (not !!e.error) — the 9 pre-Phase-1 failures have no
    // error= token but must still open to their raw message.
    expect(screen).toContain("const expandable = !e.processed || e.landed === 'stuck'")
    expect(screen).toMatch(/<code[^>]*>\s*\{e\.message\}/)
    expect(screen).toContain("hadn't reached its expected state")
  })

  it('failed rows show the reason inline — muted red, single line, no click', () => {
    expect(screen).toMatch(/\{!e\.processed && e\.reason && \(/)
    // #791F1F-family tint + ellipsis, per the quiet-UI system
    expect(screen).toMatch(/color:'rgba\(121,31,31,0\.75\)'[^}]*textOverflow:'ellipsis'/)
  })

  it('reason derivation is server-side with legacy fallbacks (lib)', () => {
    const lib = readFileSync(join(process.cwd(), 'lib/webhook-observability.ts'), 'utf8')
    expect(lib).toContain('return parsed.error || parsed.note || message')
    expect(lib).toMatch(/reason: processed \? null : failureReason\(parsed, row\.message \|\| ''\)/)
  })

  it('expandable rows carry a chevron that rotates when open', () => {
    expect(screen).toMatch(/transform: isOpen \? 'rotate\(90deg\)' : 'none'/)
    expect(screen).toContain("{expandable ? '›' : ''}")
  })

  it('Copy details builds the context block; Copy raw stays as secondary', () => {
    expect(screen).toMatch(/`Event: \$\{e\.friendly\} \(\$\{e\.topic\}\)`/)
    expect(screen).toMatch(/`Record: \$\{record\} · \$\{loc\}\$\{e\.lead_id \? ` · lead=\$\{e\.lead_id\}` : ''\}`/)
    expect(screen).toMatch(/`When: \$\{e\.created_at\}`/)
    expect(screen).toMatch(/`Status: \$\{e\.processed \? 'processed ok' : 'processed fail'\} · landed=\$\{e\.landed \|\| 'n\/a'\}`/)
    expect(screen).toMatch(/`Reason: \$\{e\.reason \|\| '—'\}`/)
    expect(screen).toMatch(/`Raw: \$\{e\.message\}`/)
    // both copy paths hit the clipboard, keyed per button
    expect(screen).toContain('navigator.clipboard.writeText(text)')
    expect(screen).toContain('buildCopyBlock(e), `${e.id}:ctx`')
    expect(screen).toContain('copyText(e.message, `${e.id}:raw`')
    expect(screen).toContain("'Copy details'")
    expect(screen).toContain("'Copy raw'")
  })

  it('intake rows with no client/jobber item show the slug, not Unknown record · Unknown account', () => {
    expect(screen).toMatch(/\|\| \(e\.intake_slug \? `slug \$\{e\.intake_slug\}` : 'Unknown record'\)/)
    // the 'Unknown account' segment is suppressed when the slug is shown
    expect(screen).toContain('const showLoc = e.location_name && !(!e.client_name && !e.jobber_item && e.intake_slug)')
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
