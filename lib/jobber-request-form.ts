// lib/jobber-request-form.ts
//
// The request FORM Bee Hub pushes into Jobber on send-to-jobber.
//
// These are NOT custom fields. Jobber's CustomFieldAppliesTo enum has no
// `request` value — custom fields can attach to clients, properties, quotes,
// jobs, invoices, products and team, but never to a Request. What a request
// DOES accept is `requestDetails`, a RequestDetailsInput wrapping a form of
// free-form sections/items. No account-specific configuration ids are
// involved, so the same payload works on every location with zero per-account
// discovery — unlike the job/client customFields path, which needs ids we'd
// have to fetch per Jobber account.
//
// History: the May mutation audit (0b71bfb) found the route was sending
// `requestDetails` as a plain STRING — schema-invalid against
// RequestDetailsInput — and removed it with an "until we wire form sync"
// comment. This module is that wiring.
//
// VERIFIED against the live schema 2026-07-24 03:08 UTC
// (scripts/introspect-jobber-schema.mjs, token loc_kc):
//   RequestCreateInput.requestDetails: RequestDetailsInput
//   RequestDetailsInput.form:          FormInput!
//   FormInput.sections:                [FormSectionInput!]!
//   FormSectionInput.label:            String!
//   FormSectionInput.items:            [FormItemInput!]!
//   FormItemInput.label:               String!
//   FormItemInput.answerText:          String        ← nullable
// Note `answerText` being nullable means an empty answer WOULD have been
// legal; omitting the item is a product choice, not a schema constraint.
// RequestCreateInput has no `source` field at all — the form item was the
// only route for it, and we deliberately don't take it.
//
// What we deliberately DON'T send: `source`. leads.source holds three
// disjoint vocabularies (MAKE scenario slugs like "seattle_assessment",
// human labels, and ~7,000 nulls) with no display mapping, so pushing it
// would forward raw slugs into a franchisee's Jobber. Source stays in Bee
// Hub — Kevin's call.

export const REQUEST_FORM_SECTION_LABEL = 'BEE ORGANIZED INTERFACE DETAILS'
export const REQUEST_FORM_ITEM_PROJECT_TYPE = 'Type of Project'
export const REQUEST_FORM_ITEM_COMMENTS = 'Additional Comments/Questions'

export type RequestFormItem = { label: string; answerText: string }
export type RequestDetailsInput = {
  form: { sections: Array<{ label: string; items: RequestFormItem[] }> }
}

function answer(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/**
 * Build the `requestDetails` value for RequestCreateInput from a lead row.
 *
 * Empty handling — OMIT, never placeholder: a blank project_type or
 * request_details drops THAT item from the section (a labeled row with an
 * empty answer is noise in the franchisee's Jobber, and inventing "N/A"
 * would be fabricating data). If BOTH are blank the whole form is dropped
 * and the caller omits `requestDetails` entirely — an empty section is
 * worse than no section.
 *
 * Returns null when there is nothing to send.
 */
export function buildRequestDetails(lead: {
  project_type?: unknown
  request_details?: unknown
}): RequestDetailsInput | null {
  const items: RequestFormItem[] = []

  const projectType = answer(lead?.project_type)
  if (projectType) {
    items.push({ label: REQUEST_FORM_ITEM_PROJECT_TYPE, answerText: projectType })
  }

  const comments = answer(lead?.request_details)
  if (comments) {
    items.push({ label: REQUEST_FORM_ITEM_COMMENTS, answerText: comments })
  }

  if (!items.length) return null

  return { form: { sections: [{ label: REQUEST_FORM_SECTION_LABEL, items }] } }
}
