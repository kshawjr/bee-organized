// @vitest-environment node
//
// issue 150 — resolve assignees at SEND TIME, before the Jobber call.
//
// Background (scout 146, confirmed against prod): Send-to-Jobber never founds an
// engagement. engagementId arrives ONLY from body.engagement_id, and the
// assessment team (allAssigneeJobberIds) was populated ONLY when that id was
// present. On a fresh lead the engagement does not exist yet — the Jobber webhook
// founds it ~11s AFTER the send — so issue 144's create-time team assignment was
// UNREACHABLE on a first send: the most common path shipped every assessment
// unassigned, by construction. This issue resolves the assignee off the LEAD at
// send time, persists it (so issue 149's founding seed copies it forward instead
// of re-deciding), and feeds it to the assessmentCreate team path.
//
// TESTS split by what the code lets us prove:
//   · resolveJobberAssignment is PURE → real assertions on the mapped/unmapped
//     split that decides what reaches teamMemberIdsToAssign (an internal-only
//     assignee, null jobber_user_id, must NOT fabricate a Jobber assignment).
//   · The behavioral resolve+persist+empty-only guarantees are asserted directly
//     on resolveAndPersistLeadAssigneesIfEmpty in beta-lead-assignment.test.ts.
//   · The POST handler can't be invoked here (live Supabase/Jobber/timezone deps
//     aren't mounted — the repo pins route wiring this way). So the wiring that
//     CONNECTS those seams into the send flow is pinned against the route source.
//     Each such assertion is labelled a PIN.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// engagement-assignee-sync transitively imports the service-role client, which
// throws at construction without env. Stub it — resolveJobberAssignment is pure
// and never touches it.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))
vi.mock('./supabase-service', () => ({ supabaseService: {} }))

import { resolveJobberAssignment } from '@/lib/engagement-assignee-sync'

const ROUTE = 'app/api/leads/[id]/send-to-jobber/route.ts'

// ── 1) resolveJobberAssignment — the mapped/unmapped split ───────────────────
describe('resolveJobberAssignment maps the send-time team (issue 150)', () => {
  const a = (hub: string, jobber: string | null) => ({
    hub_user_id: hub, name: hub, email: `${hub}@bee.com`, jobber_user_id: jobber,
  })

  it('keeps mapped assignees in order and drops the unmapped ones', () => {
    const r = resolveJobberAssignment([
      a('u1', 'gid://Jobber/User/11'),
      a('kevin', null),                 // valid INTERNAL assignee, no Jobber identity
      a('u2', 'gid://Jobber/User/22'),
    ])
    expect(r.allJobberUserIds).toEqual(['gid://Jobber/User/11', 'gid://Jobber/User/22'])
    expect(r.primaryJobberUserId).toBe('gid://Jobber/User/11')
    expect(r.mappedCount).toBe(2)
    expect(r.unmappedCount).toBe(1)
  })

  it('an ALL-internal set yields an empty Jobber team — no fabricated assignment', () => {
    // teamMemberIdsToAssign is then omitted and the assessment ships unassigned
    // in Jobber, while the assignment stays recorded internally. The terminal
    // sync_log reads assignment=none, which is correct and honest.
    const r = resolveJobberAssignment([a('kevin', null), a('leslie', null)])
    expect(r.allJobberUserIds).toEqual([])
    expect(r.primaryJobberUserId).toBeNull()
    expect(r.mappedCount).toBe(0)
    expect(r.unmappedCount).toBe(2)
  })
})

// ── 2) route wiring (PINS) — the seams are connected into the send flow ──────
describe('send-to-jobber send-time resolution wiring (issue 150)', () => {
  const route = readFileSync(ROUTE, 'utf8')

  it('PIN: engagement_id present KEEPS the existing engagement-read path', () => {
    // When the send rides a founded engagement, assignees come off the
    // engagement junction and nothing re-resolves.
    expect(route).toContain('if (engagementId) {')
    expect(route).toContain('const engAssignees = await getEngagementAssignees(engagementId)')
  })

  it('PIN: the bare-lead path resolves + persists the lead assignees (empty-only)', () => {
    // The new else branch calls the shared resolver/persist seam with the
    // lead\'s own location + project type.
    expect(route).toContain('await resolveAndPersistLeadAssigneesIfEmpty({')
    expect(route).toContain('locationUuid: lead.location_uuid')
    expect(route).toContain('projectType: lead.project_type ?? null')
  })

  it('PIN: the bare-lead path feeds the persisted set into allAssigneeJobberIds', () => {
    // getLeadAssignees → resolveJobberAssignment → the assessmentCreate team.
    // issue 157 split the single-line resolve so unmappedCount is retained too;
    // the mapped ids still flow to allAssigneeJobberIds from the same resolve.
    expect(route).toContain('const leadAssignees = await getLeadAssignees(leadId)')
    expect(route).toContain('const resolved = resolveJobberAssignment(leadAssignees)')
    expect(route).toContain('allAssigneeJobberIds = resolved.allJobberUserIds')
  })

  it('PIN: allAssigneeJobberIds still reaches teamMemberIdsToAssign (issue 144)', () => {
    // applyTeamToSchedule attaches teamMemberIdsToAssign from allAssigneeJobberIds
    // — the whole point is that a first send now populates it.
    expect(route).toContain('const schedule = applyTeamToSchedule(')
    expect(route).toContain('        allAssigneeJobberIds,\n      )')
  })

  it('PIN: comments use the "issue 150" form, never the "#150" hex-sweep trap', () => {
    expect(route).toContain('issue 150')
    expect(route).not.toContain('#150')
  })
})
