// Feedback screen: composer affordance + view-as location parity.
//
// Two contracts pinned here (AdminFeedbackScreen is a BeeHub.jsx internal,
// so these are source pins — the established pattern for BeeHub internals,
// same as beta-go-live / beta-identity-scope):
//
//   1) COMPOSER: AdminFeedbackScreen renders a "report a bug / suggest a
//      feature" button ONLY when the onReportFeedback prop is passed. The
//      FRANCHISE feedback mount passes it (opens the existing FeedbackModal
//      via setShowFeedback — reuse, no second composer); the two ELEVATED
//      admin mounts pass nothing → no button there.
//
//   2) VIEW-AS SCOPE: "view as" swaps display only — API calls ride the
//      REAL session, so an impersonated owner's feedback view used to take
//      the route's elevated branch (org-wide). The franchise mount now
//      passes the impersonated locationId and the screen appends
//      ?location_id= (which /api/admin/feedback honors for elevated
//      callers). REAL sessions are untouched: owner/manager stay
//      hard-scoped server-side (the param is ignored for them), users list
//      only their own items, super_admin without view-as stays org-wide
//      (locationId null → no param).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
const adminRoute = readFileSync(join(process.cwd(), 'app/api/admin/feedback/route.ts'), 'utf8')
const userRoute = readFileSync(join(process.cwd(), 'app/api/feedback/route.ts'), 'utf8')

// The AdminFeedbackScreen function body (up to the next top-level function).
const screenSrc = beehub.slice(
  beehub.indexOf('function AdminFeedbackScreen('),
  beehub.indexOf('const US_TIMEZONES')
)
// The franchise feedback mount (the activeNav==='feedback' branch inside screen()).
const franchiseMount = beehub.slice(
  beehub.indexOf("if (activeNav==='feedback') return ("),
  beehub.indexOf("if (activeNav==='feedback') return (") + 600
)

describe('feedback composer affordance (franchise mount only)', () => {
  it('AdminFeedbackScreen gates the report button on the onReportFeedback prop', () => {
    expect(screenSrc).toContain('onReportFeedback = null')
    // Button renders only when the prop is passed…
    expect(screenSrc).toMatch(/\{onReportFeedback && \(\s*<button/)
    // …fires the callback, and is labeled for both actions.
    expect(screenSrc).toContain('onClick={onReportFeedback}')
    expect(screenSrc).toContain('Report a bug / suggest a feature')
  })

  it('the franchise feedback mount passes onReportFeedback → the EXISTING FeedbackModal (setShowFeedback), landing on the Submit tab', () => {
    expect(franchiseMount).toContain("onReportFeedback={() => setShowFeedback('submit')}")
    // Reuse contract: showFeedback mounts the one existing modal; the
    // 'submit' intent rides through as initialTab.
    expect(beehub).toContain("{showFeedback && <FeedbackModal initialTab={showFeedback === 'submit' ? 'submit' : 'mine'} viewAsUserId={viewAsUser?.id || null} onClose={() => setShowFeedback(false)} />}")
  })

  it('the elevated admin mounts pass NO composer prop and NO location override', () => {
    const elevatedMounts = beehub.match(/<AdminFeedbackScreen[^/]*\/>/g) || []
    const withPending = elevatedMounts.filter(m => m.includes('onPendingCountChange'))
    expect(withPending.length).toBe(2) // the two elevated admin surfaces
    for (const m of withPending) {
      expect(m).not.toContain('onReportFeedback')
      expect(m).not.toContain('locationId')
    }
  })
})

describe('view-as feedback scope parity', () => {
  it('the franchise mount passes the IMPERSONATED locationId (null for real sessions)', () => {
    expect(franchiseMount).toContain('locationId={viewAsUser?.locationId || null}')
  })

  it('AdminFeedbackScreen appends ?location_id= only when scoped, and refetches when it changes', () => {
    expect(screenSrc).toContain('locationId = null')
    expect(screenSrc).toMatch(/locationId\s*\?\s*`\/api\/admin\/feedback\?location_id=\$\{encodeURIComponent\(locationId\)\}`/)
    expect(screenSrc).toMatch(/`\/api\/admin\/feedback\?location_id=[^`]*`\s*:\s*'\/api\/admin\/feedback'/)
    expect(screenSrc).toMatch(/useEffect\(\(\) => \{ load\(\) \}, \[locationId\]\)/)
  })

  it('documents that view-as data scoping is per-surface (no global fix)', () => {
    expect(screenSrc).toMatch(/VIEW-AS DATA SCOPING IS PER-SURFACE/i)
  })
})

describe('real-session scoping unchanged (server routes)', () => {
  it('owner/manager stay HARD-scoped to their own location — the query param is ignored for them', () => {
    // The forced scope branch…
    expect(adminRoute).toContain("query = query.eq('location_id', caller!.location_id)")
    // …and the ?location_id= override is only read in the elevated else-branch.
    const scopedBranch = adminRoute.slice(
      adminRoute.indexOf('if (isLocationScopedCaller)'),
      adminRoute.indexOf('} else {')
    )
    expect(scopedBranch).not.toContain('searchParams')
  })

  it('elevated callers may pass ?location_id= (what the view-as fix rides); omitted → org-wide', () => {
    const elevatedBranch = adminRoute.slice(adminRoute.indexOf('} else {'))
    expect(elevatedBranch).toContain("searchParams.get('location_id')")
    expect(elevatedBranch).toMatch(/if \(locationId\) query = query\.eq\('location_id', locationId\)/)
  })

  it('non-owner/manager/elevated callers are still 403; users list only their OWN items', () => {
    expect(adminRoute).toContain("return NextResponse.json({ error: 'forbidden' }, { status: 403 })")
    // The user route defaults to the session user; the override only ever
    // replaces it inside the elevated-role check (asserted in detail below).
    expect(userRoute).toContain('let targetUserId = user.id')
  })
})

// The identity half of view-as parity (the location half is 681b3a7 above):
// the "mine" tab under view-as shows the IMPERSONATED user's items, via an
// elevated-only ?user_id= override on GET /api/feedback.
describe('view-as feedback identity parity (mine tab)', () => {
  // The FeedbackModal function body (up to the next top-level component).
  const modalSrc = beehub.slice(
    beehub.indexOf('function FeedbackModal('),
    beehub.indexOf('function FeedbackModal(') + 6000
  )

  it('the modal mount passes the IMPERSONATED user id (null for real sessions)', () => {
    expect(beehub).toContain('viewAsUserId={viewAsUser?.id || null}')
  })

  it('FeedbackModal appends ?user_id= only when impersonating, and refetches when it changes', () => {
    expect(modalSrc).toContain('viewAsUserId = null')
    expect(modalSrc).toMatch(/viewAsUserId\s*\?\s*`\/api\/feedback\?user_id=\$\{encodeURIComponent\(viewAsUserId\)\}`\s*:\s*'\/api\/feedback'/)
    expect(modalSrc).toMatch(/useEffect\(\(\) => \{ loadItems\(\) \}, \[viewAsUserId\]\)/)
  })

  it('GET /api/feedback honors ?user_id= ONLY after an elevated-role check on the SESSION user', () => {
    // Default target is the session user…
    expect(userRoute).toContain('let targetUserId = user.id')
    // …and the only reassignment is gated on the caller's own hub_users role
    // being elevated (role looked up by session id, never from the request).
    const overrideBlock = userRoute.slice(
      userRoute.indexOf("searchParams.get('user_id')"),
      userRoute.indexOf('targetUserId = override') + 'targetUserId = override'.length
    )
    expect(overrideBlock).toContain(".eq('id', user.id)")
    expect(overrideBlock).toMatch(/if \(caller && ELEVATED_ROLES\.includes\(caller\.role\)\) targetUserId = override/)
    expect(userRoute.split('targetUserId = override').length).toBe(2) // exactly one assignment site
    // The query binds to the resolved target, not raw input.
    expect(userRoute).toContain(".eq('user_id', targetUserId)")
    // ELEVATED_ROLES stays the corp tier only — owner/manager never qualify.
    expect(userRoute).toMatch(/const ELEVATED_ROLES = \['super_admin', 'admin'\]/)
  })

  it('a non-elevated caller passing ?user_id= is IGNORED — read stays scoped to their own session id', () => {
    // No unconditional use of the raw param in a query filter…
    expect(userRoute).not.toMatch(/\.eq\('user_id', override\)/)
    // …and there is no other searchParams read that could smuggle identity in.
    const paramReads = userRoute.match(/searchParams\.get\('[^']+'\)/g) || []
    expect(paramReads).toEqual(["searchParams.get('user_id')"])
  })
})
