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

// ── 1) summarizeAssignmentOutcome — the two headline guarantees, asserted ────
describe('summarizeAssignmentOutcome (issue 145)', () => {
  it('a FAILED assignment does NOT report success — it is partial', () => {
    const out = summarizeAssignmentOutcome({
      requested: true,
      problems: ['request salesperson dropped (Jobber rejected the id)'],
    })
    expect(out.status).not.toBe('success')
    expect(out.status).toBe('partial')
  })

  it('a partial send names the shortfall in the message segment', () => {
    const out = summarizeAssignmentOutcome({
      requested: true,
      problems: ['assessment team incomplete — missing=[gid://User/1]'],
    })
    expect(out.segment).toContain('assignment=PARTIAL')
    expect(out.segment).toContain('assessment team incomplete')
    expect(out.segment).toContain('gid://User/1')
  })

  it('every problem is folded into one segment (multiple sub-steps degraded)', () => {
    const out = summarizeAssignmentOutcome({
      requested: true,
      problems: [
        'request salesperson dropped (Jobber rejected the id)',
        'assessment team incomplete — missing=[gid://User/2]',
      ],
    })
    expect(out.status).toBe('partial')
    expect(out.segment).toContain('request salesperson dropped')
    expect(out.segment).toContain('assessment team incomplete')
  })

  it('a CLEAN send that assigned someone still reports success (assignment=ok)', () => {
    const out = summarizeAssignmentOutcome({ requested: true, problems: [] })
    expect(out.status).toBe('success')
    expect(out.segment).toBe('assignment=ok')
  })

  it('a bare send that assigned nobody reports success (assignment=none) — no false alarm', () => {
    const out = summarizeAssignmentOutcome({ requested: false, problems: [] })
    expect(out.status).toBe('success')
    expect(out.segment).toBe('assignment=none')
  })

  it('empty-string problems are ignored (never a phantom partial)', () => {
    const out = summarizeAssignmentOutcome({ requested: true, problems: ['', ''] })
    expect(out.status).toBe('success')
    expect(out.segment).toBe('assignment=ok')
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
