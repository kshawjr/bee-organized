// @vitest-environment node
//
// issue 145 — stop discarding assignment userErrors on the send path.
//
// Background: Team assignment to Jobber assessments failed silently in prod
// for three weeks. 0 of 22 sent assessments carried the assigned person, and
// NOTHING recorded it: the send path console.warn'd userErrors on an ephemeral
// serverless function and then wrote a terminal sync_log row hard-coded
// status:'success' whose message never mentioned assignment. This issue makes
// that terminal row tell the truth.
//
// TESTS split by what the code lets us prove:
//   · summarizeAssignmentOutcome is a PURE function → REAL assertions. This is
//     the seam that decides the terminal row's status + message, so the two
//     headline guarantees ("a failed assignment does NOT report success" / "a
//     clean send still reports success") are asserted directly on the logic
//     that produces them, not on a string in the source.
//   · The POST handler can't be invoked here (live Supabase/Jobber/timezone
//     deps aren't mounted — the repo pins route wiring this way; see
//     jobber-request-form.test.ts and beta-assessment-team-assign.test.ts).
//     So the wiring that CONNECTS the pure seam to the persisted row is pinned
//     against the route source. Each such assertion is labelled a PIN.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { summarizeAssignmentOutcome } from '@/lib/jobber-assessment-assign'

const ROUTE = 'app/api/leads/[id]/send-to-jobber/route.ts'

// ── 1) summarizeAssignmentOutcome — the headline guarantees, asserted ───────
describe('summarizeAssignmentOutcome (issue 145)', () => {
  it('a FAILED assignment does NOT report success — it is partial', () => {
    const out = summarizeAssignmentOutcome({
      problems: ['request salesperson dropped (Jobber rejected the id)'],
    })
    expect(out.status).not.toBe('success')
    expect(out.status).toBe('partial')
  })

  it('a partial send names the shortfall in the message segment', () => {
    const out = summarizeAssignmentOutcome({
      problems: ['assessment team incomplete — missing=[gid://User/1]'],
    })
    expect(out.segment).toContain('assignment=PARTIAL')
    expect(out.segment).toContain('assessment team incomplete')
    expect(out.segment).toContain('gid://User/1')
  })

  it('every problem is folded into one segment (multiple sub-steps degraded)', () => {
    const out = summarizeAssignmentOutcome({
      problems: [
        'request salesperson dropped (Jobber rejected the id)',
        'assessment team incomplete — missing=[gid://User/2]',
      ],
    })
    expect(out.status).toBe('partial')
    expect(out.segment).toContain('request salesperson dropped')
    expect(out.segment).toContain('assessment team incomplete')
  })

  it('a CLEAN send that landed someone reports success and NAMES where', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 1, landed: { salesperson: true },
    })
    expect(out.status).toBe('success')
    expect(out.segment).toBe('assignment=ok(salesperson)')
  })

  it('a bare send that assigned nobody reports success (assignment=none)', () => {
    const out = summarizeAssignmentOutcome({ problems: [] })
    expect(out.status).toBe('success')
    expect(out.segment).toBe('assignment=none')
  })

  it('empty-string problems are ignored (never a phantom partial)', () => {
    const out = summarizeAssignmentOutcome({
      problems: ['', ''], mapped: 1, landed: { salesperson: true },
    })
    expect(out.status).toBe('success')
    expect(out.segment).toBe('assignment=ok(salesperson)')
  })
})

// ── 1a) issue 158 — the token reports what LANDED, never what resolved ───────
// THE BUG THIS KILLS: 67 real sends (2026-07-31 → 2026-09-03, 19 locations)
// pushed NOTHING to Jobber and logged `assignment=ok`, because the old input
// asked only whether a Jobber-linked assignee EXISTED. These pin that a send
// which pushed nothing can never again read as ok.
describe('summarizeAssignmentOutcome reports what landed (issue 158)', () => {
  it('THE 67: mapped people, nothing pushed → NOT ok, and it says why', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 1, unmapped: 0, landed: {},
    })
    // nothing FAILED — there was no Jobber field to hold them
    expect(out.status).toBe('success')
    // …but it must never claim ok
    expect(out.segment).not.toContain('assignment=ok')
    expect(out.segment).toBe('assignment=none(1 mapped, nothing reached Jobber)')
  })

  it('a bare `assignment=ok` is no longer producible at all', () => {
    for (const landed of [{ salesperson: true }, { teamVerified: 2 }, { salesperson: true, teamVerified: 2 }]) {
      const out = summarizeAssignmentOutcome({ problems: [], mapped: 2, landed })
      expect(out.segment).not.toBe('assignment=ok')
      expect(out.segment).toMatch(/^assignment=ok\(.+\)$/)
    }
  })

  it('names the salesperson destination when only that landed', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 1, landed: { salesperson: true },
    })
    expect(out.segment).toBe('assignment=ok(salesperson)')
  })

  it('names the team destination with the READ-BACK count, not the requested one', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 3, landed: { teamVerified: 3 },
    })
    expect(out.segment).toBe('assignment=ok(team 3 of 3)')
  })

  it('names BOTH destinations when both landed', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 2, landed: { salesperson: true, teamVerified: 2 },
    })
    expect(out.segment).toBe('assignment=ok(salesperson, team 2 of 2)')
  })

  it('a partial read-back reports the honest number, not the optimistic one', () => {
    // 3 asked, 1 came back. The send is separately 'partial' via the shortfall
    // problem; the count itself must never round up to what we requested.
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 3, landed: { teamVerified: 1 },
    })
    expect(out.segment).toBe('assignment=ok(team 1 of 3)')
    expect(out.segment).not.toContain('3 of 3')
  })

  it('`requested` is GONE — passing it cannot resurrect a false ok', () => {
    // The removed field is the exact conflation that produced the 67. Even if
    // a caller passes it, nothing landed, so the segment stays honest.
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 2, landed: {}, ...({ requested: true } as any),
    })
    expect(out.segment).not.toContain('assignment=ok')
    expect(out.segment).toContain('nothing reached Jobber')
  })

  it('a real problem still wins over any landed fact', () => {
    const out = summarizeAssignmentOutcome({
      problems: ['assessment team incomplete — missing=[gid://User/9]'],
      mapped: 2, unmapped: 1, landed: { salesperson: true, teamVerified: 1 },
    })
    expect(out.status).toBe('partial')
    expect(out.segment).toContain('assignment=PARTIAL')
  })
})

// ── 1b) issue 157 — unmapped picked assignees are STATED, not hidden ─────────
// An owner can pick an assignee with no jobber_user_id. resolveJobberAssignment
// drops them from the Jobber push, so the terminal row used to report a bare
// 'assignment=ok' while a chosen person never reached Jobber. Preserved intact
// under the issue-158 contract: the unmapped count still rides every segment.
describe('summarizeAssignmentOutcome unmapped shape (issue 157)', () => {
  it('all-mapped names only the destination, with no internal-only tail', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 3, unmapped: 0, landed: { teamVerified: 3 },
    })
    expect(out.status).toBe('success')
    expect(out.segment).toBe('assignment=ok(team 3 of 3)')
    expect(out.segment).not.toContain('internal-only')
  })

  it('a MIXED set names the unmapped count alongside what landed', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 2, unmapped: 1, landed: { teamVerified: 2 },
    })
    expect(out.status).toBe('success')
    expect(out.segment).toBe('assignment=ok(team 2 of 2, 1 internal-only)')
  })

  it('an ALL-UNMAPPED set reports none DISTINCTLY (picked, but none linked)', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 0, unmapped: 3, landed: {},
    })
    expect(out.status).toBe('success')
    expect(out.segment).not.toBe('assignment=none')
    expect(out.segment).toBe('assignment=none(3 internal-only)')
  })

  it('GENUINELY nobody picked reports a bare none (the distinction is the point)', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 0, unmapped: 0, landed: {},
    })
    expect(out.status).toBe('success')
    expect(out.segment).toBe('assignment=none')
  })

  it('mapped-but-unpushed WITH unmapped states both facts', () => {
    const out = summarizeAssignmentOutcome({
      problems: [], mapped: 2, unmapped: 1, landed: {},
    })
    expect(out.segment).toBe('assignment=none(2 mapped, nothing reached Jobber, 1 internal-only)')
  })
})

// ── 2) route wiring (PINS) — the pure seam is connected to the persisted row ──
describe('send-to-jobber terminal-row wiring (issue 145)', () => {
  const route = readFileSync(ROUTE, 'utf8')

  it('PIN: the terminal sync_log row status is the summarized outcome, not a literal', () => {
    // The specific lie we killed: a hard-coded success on the terminal row.
    expect(route).toContain('status:           assignmentOutcome.status')
    expect(route).toContain('const assignmentOutcome = summarizeAssignmentOutcome({')
    // and the assignment outcome rides the terminal message
    expect(route).toContain('`; ${assignmentOutcome.segment}`')
  })

  it('PIN: every assignment sub-step degrade feeds the terminal summary', () => {
    // request + job salesperson drops, and the assessment team shortfall
    expect(route).toContain('requestSalespersonDropped = true')
    expect(route).toContain('jobSalespersonDropped = true')
    expect(route).toContain('assessmentTeamShortfall =')
    expect(route).toContain("if (requestSalespersonDropped) assignmentProblems.push(")
    expect(route).toContain("if (jobSalespersonDropped)     assignmentProblems.push(")
    expect(route).toContain('if (assessmentTeamShortfall)   assignmentProblems.push(')
  })

  it('PIN: no assignment userError on the send path is console.warn-only — each also persists', () => {
    // The three assignment degrade points each pair their console.warn with a
    // writeSyncLog. Assert the persisted breadcrumbs still exist (the send
    // path never regresses to warn-only for assignment).
    expect(route).toContain('topic=REQUEST_ASSIGN_RETRY')
    expect(route).toContain('topic=JOB_ASSIGN_RETRY')
    expect(route).toContain('ASSESSMENT_TEAM_MISMATCH (issue 144)')
  })

  it('PIN: comments use the "issue 145" form, never the "#145" hex-sweep trap', () => {
    expect(route).toContain('issue 145')
    expect(route).not.toContain('#145')
  })
})

// ── 3) issue 157 wiring (PINS) — the retained unmapped count reaches the row ──
describe('send-to-jobber unmapped-count wiring (issue 157)', () => {
  const route = readFileSync(ROUTE, 'utf8')

  it('PIN: unmappedCount is RETAINED from both resolveJobberAssignment call sites', () => {
    // Previously discarded on both the founded-engagement and bare-lead paths.
    expect(route).toContain('let assigneeUnmappedCount = 0')
    expect(route).toContain('assigneeUnmappedCount = resolved.unmappedCount')
  })

  it('PIN: the retained counts are folded into the terminal summary', () => {
    expect(route).toContain('mapped:    allAssigneeJobberIds.length')
    expect(route).toContain('unmapped:  assigneeUnmappedCount')
  })

  it('PIN: comments use the "issue 157" form, never the "#157" hex-sweep trap', () => {
    expect(route).toContain('issue 157')
    expect(route).not.toContain('#157')
  })
})

// ── 4) issue 158 wiring (PINS) — the fix, and the token that reports it ──────
// The handler can't be invoked here (live Supabase/Jobber/timezone deps aren't
// mounted — the repo's standing pattern), so the behaviour change is pinned
// against the route source. Each assertion is labelled a PIN.
describe('send-to-jobber request-only assignment (issue 158)', () => {
  const route = readFileSync(ROUTE, 'utf8')

  it('PIN: the BARE-LEAD path now sets the request/job salesperson', () => {
    // The whole fix. Before, this branch set only allAssigneeJobberIds, so a
    // request-only send on a fresh lead pushed nothing at all.
    expect(route).toContain('salesPersonJobberId = resolved.primaryJobberUserId')
    // …and it is set on BOTH branches now — engagement and bare lead.
    const hits = route.split('salesPersonJobberId = resolved.primaryJobberUserId').length - 1
    expect(hits).toBe(2)
  })

  it('PIN: the old resolved-only `assignmentRequested` is GONE from the route', () => {
    // The exact conflation that produced 67 false oks. Not softened — removed,
    // so it cannot be passed to the summarizer by any caller.
    expect(route).not.toContain('assignmentRequested')
    expect(route).not.toContain('requested: assignmentRequested')
  })

  it('PIN: the terminal row is fed LANDED facts, not resolved ones', () => {
    expect(route).toContain('landed:    { salesperson: salespersonLanded, teamVerified: teamVerifiedCount }')
    expect(route).toContain('let salespersonLanded = false')
    expect(route).toContain('let teamVerifiedCount = 0')
  })

  it('PIN: salespersonLanded is claimed ONLY on an accepted push, never on the retry', () => {
    // The retry branch ships the record WITHOUT the salesperson — it must not
    // claim it landed. Both legs guard on a clean userErrors array.
    expect(route).toContain("} else if (input.salespersonId && !res.userErrors?.length) {")
    expect(route).toContain("} else if (jobInput.salespersonId && !jobCreate.userErrors?.length) {")
    const claims = route.split('salespersonLanded = true').length - 1
    expect(claims).toBe(2) // request leg + job leg, and nowhere else
  })

  it('PIN: the team count comes from the READ-BACK, not from what we requested', () => {
    expect(route).toContain('teamVerifiedCount = diff.requested.filter(id => diff.returned.includes(id)).length')
    // never the optimistic source
    expect(route).not.toContain('teamVerifiedCount = allAssigneeJobberIds.length')
  })

  it('PIN: comments use the "issue 158" form, never the "#158" hex-sweep trap', () => {
    expect(route).toContain('issue 158')
    expect(route).not.toContain('#158')
  })
})
