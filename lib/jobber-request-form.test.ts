// @vitest-environment node
//
// Request FORM push (project type + details) on send-to-jobber.
//
// Send-to-Jobber has NEVER written these fields. The May audit (0b71bfb)
// found the route sending `requestDetails` as a plain STRING — schema-invalid
// against RequestDetailsInput — and removed it with an "until we wire form
// sync" comment that was never replaced. The populated sections on older
// records came from the retired Zoho integration, whose own section label was
// "BEE ORGANIZED INTERFACE DETAILS".
//
// These are NOT custom fields: CustomFieldAppliesTo has no `request` value.
// A request takes requestDetails.form.sections[].items[] — free-form labels,
// no account-specific ids — so one payload works on every location.
//
// Pinned here:
//   * the section + both items, mapped from project_type / request_details
//   * source is NEVER sent (three disjoint vocabularies; stays in Bee Hub)
//   * blanks OMIT their item, never a placeholder; both blank → no key at all
//   * the rest of the request payload is untouched, and job_direct never
//     learns about the form
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  buildRequestDetails,
  REQUEST_FORM_SECTION_LABEL,
  REQUEST_FORM_ITEM_PROJECT_TYPE,
  REQUEST_FORM_ITEM_COMMENTS,
} from '@/lib/jobber-request-form'

const ROUTE = 'app/api/leads/[id]/send-to-jobber/route.ts'

// ── unit: the form payload ──────────────────────────────────────────────────

describe('buildRequestDetails', () => {
  it('builds ONE section with BOTH items, mapped from project_type and request_details', () => {
    const out = buildRequestDetails({
      project_type: 'Garage Organization',
      request_details: 'Two-car garage, wants shelving by August.',
    })
    expect(out).toEqual({
      form: {
        sections: [{
          label: 'BEE ORGANIZED INTERFACE DETAILS',
          items: [
            { label: 'Type of Project', answerText: 'Garage Organization' },
            { label: 'Additional Comments/Questions', answerText: 'Two-car garage, wants shelving by August.' },
          ],
        }],
      },
    })
  })

  it('the labels are the exported constants (the section label is the Zoho-era one Kevin recognizes)', () => {
    expect(REQUEST_FORM_SECTION_LABEL).toBe('BEE ORGANIZED INTERFACE DETAILS')
    expect(REQUEST_FORM_ITEM_PROJECT_TYPE).toBe('Type of Project')
    expect(REQUEST_FORM_ITEM_COMMENTS).toBe('Additional Comments/Questions')
  })

  it('never sends source — even when the lead carries one (raw MAKE slugs stay in Bee Hub)', () => {
    const out = buildRequestDetails({
      project_type: 'Pantry',
      request_details: 'help',
      // @ts-expect-error — deliberately passing a field the builder must ignore
      source: 'seattle_assessment',
    })
    expect(JSON.stringify(out)).not.toContain('seattle_assessment')
    expect(JSON.stringify(out)).not.toContain('source')
    expect(out!.form.sections[0].items).toHaveLength(2)
  })

  it('null project_type OMITS that item — no placeholder, no empty answer', () => {
    const out = buildRequestDetails({ project_type: null, request_details: 'just the notes' })
    expect(out!.form.sections[0].items).toEqual([
      { label: 'Additional Comments/Questions', answerText: 'just the notes' },
    ])
  })

  it('null request_details OMITS that item', () => {
    const out = buildRequestDetails({ project_type: 'Closet', request_details: null })
    expect(out!.form.sections[0].items).toEqual([
      { label: 'Type of Project', answerText: 'Closet' },
    ])
  })

  it('blank/whitespace counts as empty (~9% of intake leads land with no description)', () => {
    expect(buildRequestDetails({ project_type: '   ', request_details: '\n\t ' })).toBeNull()
    const out = buildRequestDetails({ project_type: '  Office  ', request_details: '' })
    expect(out!.form.sections[0].items).toEqual([
      { label: 'Type of Project', answerText: 'Office' },
    ])
  })

  it('BOTH blank → null, so the caller omits requestDetails entirely (no empty section ships)', () => {
    expect(buildRequestDetails({ project_type: null, request_details: null })).toBeNull()
    expect(buildRequestDetails({})).toBeNull()
  })

  it('a null/blank lead never produces a malformed payload — items are never empty when a form is returned', () => {
    for (const lead of [
      {},
      { project_type: null, request_details: undefined },
      { project_type: undefined, request_details: '' },
    ]) {
      const out = buildRequestDetails(lead as any)
      if (out !== null) expect(out.form.sections[0].items.length).toBeGreaterThan(0)
    }
  })
})

// ── source pins: how the route wires it ─────────────────────────────────────

describe('send-to-jobber route wiring', () => {
  const route = readFileSync(ROUTE, 'utf8')

  it('the REQUEST path attaches requestDetails, and only when there is something to send', () => {
    expect(route).toContain("import { buildRequestDetails } from '@/lib/jobber-request-form'")
    expect(route).toContain('const requestDetails = buildRequestDetails(lead)')
    expect(route).toContain('if (requestDetails) requestInput.requestDetails = requestDetails')
    // the "no form mapping today" placeholder comment from the May audit is gone
    expect(route).not.toContain('until we wire form sync')
  })

  it('the rest of the request payload is byte-for-byte unchanged', () => {
    expect(route).toContain('clientId: jobberClientGlobalId')
    expect(route).toContain('title:    requestTitle')
    expect(route).toContain('if (jobberPropertyGlobalId) requestInput.propertyId = jobberPropertyGlobalId')
    expect(route).toContain('if (salesPersonJobberId) requestInput.salespersonId = salesPersonJobberId')
    expect(route).toContain('mutation RequestCreate($input: RequestCreateInput!)')
  })

  it('never puts source on the request input', () => {
    expect(route).not.toMatch(/requestInput\.source\s*=/)
    expect(route).not.toMatch(/source:\s*lead\.source/)
  })

  it('requestDetails is NON-FATAL: rejection strips the form and re-runs the ladder', () => {
    expect(route).toContain('REQUEST_FORM_RETRY')
    expect(route).toContain('retrying without the form')
    expect(route).toContain('const { requestDetails: _form, ...withoutForm } = requestInput')
    expect(route).toContain('reqCreate = await createRequest(withoutForm)')
    // the pre-existing salespersonId rung still fires inside the ladder
    expect(route).toContain('REQUEST_ASSIGN_RETRY')
    expect(route).toContain('retrying unassigned')
  })

  it('job_direct never learns about the form (Path 2 stays exactly as it was)', () => {
    const jobBranch = route.slice(route.indexOf("} else if (creation_type === 'job_direct') {"))
    expect(jobBranch.length).toBeGreaterThan(0)
    expect(jobBranch).not.toContain('requestDetails')
    expect(jobBranch).not.toContain('buildRequestDetails')
    expect(jobBranch).not.toContain(REQUEST_FORM_SECTION_LABEL)
  })
})
