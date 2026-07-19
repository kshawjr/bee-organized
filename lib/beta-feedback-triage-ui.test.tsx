// Feedback triage screen — card-redesign modernization + submit-tab default.
//
// Source pins (AdminFeedbackScreen / FeedbackModal are BeeHub.jsx internals —
// same pattern as beta-feedback-viewas / beta-go-live):
//
//   1) SUBMIT-TAB DEFAULT: the Feedback screen's composer button opens the
//      one existing FeedbackModal ON THE SUBMIT TAB (showFeedback='submit' →
//      initialTab='submit'). The Help "?" menu path is UNCHANGED — it sets
//      true and the modal keeps its 'mine' (My Items) default.
//
//   2) MODERN LAYOUT: header (19px/500 headline + muted count subtitle,
//      composer as a soft-tinted accent action), soft pill filters for the
//      REAL filter axes (type + status; location select + submitter search
//      stay as quiet inputs), hairline-divided rows inside ONE rounded
//      container (no per-row boxes, no table header row), soft-tinted type
//      tiles (bug → red family / feature → accent blue), locked-anatomy
//      status chips over the REAL 6-status vocabulary, closed rows
//      (shipped/declined) dimmed to 0.72.
//
//   3) PER-MOUNT LOCATION: the franchise mount (the one that passes
//      onReportFeedback) drops the location filter and the row meta's
//      location segment — it's always the caller's own location. Elevated
//      admin mounts keep both.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
const icons = readFileSync(join(process.cwd(), 'components/ui/icons.jsx'), 'utf8')

const screenSrc = beehub.slice(
  beehub.indexOf('function AdminFeedbackScreen('),
  beehub.indexOf('const US_TIMEZONES')
)
const modalSrc = beehub.slice(
  beehub.indexOf('function FeedbackModal('),
  beehub.indexOf('function ManualModal(')
)

describe('submit-tab default (Feedback-screen button only)', () => {
  it('FeedbackModal takes initialTab, defaulting to mine (Help-menu behavior unchanged)', () => {
    expect(modalSrc).toContain("function FeedbackModal({ onClose, initialTab = 'mine', viewAsUserId = null })")
    expect(modalSrc).toContain('useState(initialTab)')
  })

  it("the Feedback screen's composer button opens on the SUBMIT tab", () => {
    expect(beehub).toContain("onReportFeedback={() => setShowFeedback('submit')}")
    expect(beehub).toContain(
      "{showFeedback && <FeedbackModal initialTab={showFeedback === 'submit' ? 'submit' : 'mine'} viewAsUserId={viewAsUser?.id || null} onClose={() => setShowFeedback(false)} />}"
    )
  })

  it('the Ask Bee Hub help path still sets plain true → the My Items default', () => {
    // The old "? Help" dropdown is gone; the bug-report entry now lives in the
    // Ask Bee Hub chat panel footer. It still opens the modal on plain `true`
    // (My Items default), never 'submit'.
    expect(beehub).toContain("onOpenFeedback={() => { setShowHelpChat(false); setShowFeedback(true) }}")
  })
})

describe('modern layout — header + pills', () => {
  it('light headline + muted count subtitle using real counts', () => {
    expect(screenSrc).toMatch(/fontSize:'19px', fontWeight:500/)
    expect(screenSrc).toContain("`${items.length} item${items.length !== 1 ? 's' : ''} · ${openCount} open`")
    // "open" derives from the REAL terminal statuses, not an invented flag.
    expect(screenSrc).toContain("const isClosedStatus = s => s === 'shipped' || s === 'declined'")
  })

  it('composer button is a soft-tinted accent action with a plus icon (franchise mount only)', () => {
    expect(screenSrc).toMatch(/\{onReportFeedback && \(\s*<button/)
    const btn = screenSrc.slice(screenSrc.indexOf('{onReportFeedback && ('), screenSrc.indexOf('Report a bug / suggest a feature'))
    expect(btn).toContain("background:'rgba(55,138,221,0.10)'")
    expect(btn).toContain("color:'#2b6aad'")
    expect(btn).toContain('<IconPlus')
    expect(btn).not.toContain('🐛')
  })

  it('filters are soft pills over the REAL axes (type + all six statuses), active = quiet fill', () => {
    expect(screenSrc).toMatch(/pillStyle = active => \(\{\s*padding:'5px 12px', borderRadius:'20px'/)
    expect(screenSrc).toContain("background: active ? 'rgba(0,0,0,0.07)' : 'transparent'")
    // Real filter vocabularies — type from the two DB types, status from
    // FEEDBACK_STATUS_ORDER (not an invented Open/Bugs/Ideas set).
    expect(screenSrc).toMatch(/typePills = \[\s*\{ key:'all'/)
    expect(screenSrc).toContain("i.type === 'bug'")
    expect(screenSrc).toContain('...FEEDBACK_STATUS_ORDER.map(s => ({ key:s, label: FEEDBACK_STATUS_CONF[s].label, count: statusCounts[s] || 0 }))')
    // Counts ride the pills.
    expect(screenSrc).toContain('> · {p.count}</span>')
  })
})

describe('modern layout — rows', () => {
  it('hairline-divided rows inside ONE rounded container; the old table header is gone', () => {
    expect(screenSrc).toContain("border:'0.5px solid rgba(0,0,0,0.08)', borderRadius:'12px', overflow:'hidden'")
    expect(screenSrc).toContain("borderTop: idx === 0 ? 'none' : '0.5px solid rgba(0,0,0,0.08)'")
    expect(screenSrc).not.toContain('bee-fb-head')
    expect(screenSrc).not.toContain('gridTemplateColumns')
  })

  it('soft-tinted type tiles use the real type field: bug → red family, feature → accent blue', () => {
    expect(screenSrc).toContain("background: bug ? '#FCEBEB' : 'rgba(55,138,221,0.10)'")
    expect(screenSrc).toContain("color: bug ? '#791F1F' : '#2b6aad'")
    expect(screenSrc).toContain('{bug ? <IconBug size={15} /> : <IconBulb size={15} />}')
    expect(icons).toContain('export const IconBug')
    expect(icons).toContain('export const IconBulb')
  })

  it('status chips cover the real 6-status vocabulary in locked chip anatomy + families', () => {
    // Anatomy: 11px/500, 2px 8px, radius 10 — the StatusChip spec.
    expect(beehub).toMatch(/FeedbackStatusBadge\(\{ status \}\) \{[\s\S]*?padding:'2px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:500/)
    // Families (spot-check the ramp ends + the in-flight amber).
    expect(beehub).toContain("submitted:    { label:'Submitted',    color:'#085041', bg:'#E1F5EE' }")
    expect(beehub).toContain("in_progress:  { label:'In Progress',  color:'#633806', bg:'#FAEEDA' }")
    expect(beehub).toContain("declined:     { label:'Declined',     color:'#444441', bg:'#F1EFE8' }")
    // Rows render the shared badge.
    expect(screenSrc).toContain('<FeedbackStatusBadge status={it.status} />')
  })

  it('closed rows (shipped/declined) dim to 0.72', () => {
    expect(screenSrc).toContain('const closed = isClosedStatus(it.status)')
    expect(screenSrc).toContain('opacity: closed ? 0.72 : 1')
  })

  it('row click still opens the existing detail modal; PATCH status path untouched', () => {
    expect(screenSrc).toContain('onClick={() => setSelected(it)}')
    expect(screenSrc).toContain('<AdminFeedbackDetailModal')
    const detailSrc = beehub.slice(
      beehub.indexOf('function AdminFeedbackDetailModal('),
      beehub.indexOf('function ProcessRemovalsCard(')
    )
    expect(detailSrc).toContain('/api/admin/feedback/${item.id}')
    expect(detailSrc).toContain("method: 'PATCH'")
  })
})

describe('per-mount location handling', () => {
  it('the franchise mount (composer prop) drops the location filter and row-meta location', () => {
    expect(screenSrc).toContain('const franchiseMount = !!onReportFeedback')
    expect(screenSrc).toMatch(/\{!franchiseMount && \(\s*<select value=\{locFilter\}/)
    expect(screenSrc).toContain("{!franchiseMount && it.location_name ? ` · ${it.location_name}` : ''}")
  })
})
