// lib/jobber-address-sync.ts
//
// Lead-edit trigger for the Jobber address write-back — same rails as
// lib/jobber-contact-sync.ts: ONE fetch-current → per-target diff →
// at most one mutation per target → one breadcrumb.
//
// TWO targets since 7/10 late (Kevin verified billing alone doesn't
// move the address that matters — the PROPERTY/service address):
//   billing  — clientEdit { billingAddress } (unchanged happy path)
//   property — propertyEdit(propertyId, { address }), MANAGED blast
//     radius: only when the client has EXACTLY ONE property; multiple →
//     deliberate skip surfaced in toast + audit; zero → nothing to do.
//     A single property with upcoming visits still updates (an address
//     correction should correct where work happens) and the outcome
//     carries upcoming_visits so the audit note says to verify the
//     schedule.
//
// Failures are per-target and non-fatal: a propertyEdit error never
// undoes the billing edit, and neither ever blocks the lead save.
//
// ECHO GUARD (mirrors contact-sync):
//   1. Our edits make Jobber fire CLIENT_UPDATE / PROPERTY_UPDATE back
//      at us; both handlers write the lead row via upsertLead — never
//      through PATCH /api/leads/:id — so the trigger cannot re-fire.
//   2. The echoes overwrite lead address fields with the pushed values.
//   3. Fetch-at-push: targets Jobber already carries send no mutation.
//
// Never throws — outcome rides the PATCH response + a sync_log
// breadcrumb (entity_type 'client': the sync_log CHECK constraint has
// no 'lead' value).

import { jobberGraphQL, jobberMutation } from './jobber'
import { writeSyncLog } from './sync-log'
import {
  buildBillingAddressInput,
  buildPropertyAddressPlan,
  hasUpcomingVisit,
  resolveAddressWriteback,
  resolvePropertyWriteback,
  type AddressTarget,
  type AddressWriteback,
  type AddressWritebackOutcome,
} from './jobber-address-writeback'

// One round-trip: billing + the property page (totalCount arbitrates
// single-vs-multiple; first:2 so we never page) + incomplete VISITs for
// the upcoming-visit annotation (client-level is exact in the only case
// we use it — the single-property client). Shapes confirmed by live
// introspection 7/10.
const GET_CLIENT_ADDRESS_STATE_QUERY = /* GraphQL */ `
  query GetClientAddressState($clientId: EncodedId!) {
    client(id: $clientId) {
      id
      billingAddress { street street1 street2 city province postalCode country }
      clientProperties(first: 2) {
        totalCount
        nodes {
          id
          address { street street1 street2 city province postalCode country }
        }
      }
      scheduledItems(first: 50, filter: { scheduleItemType: VISIT, completionState: INCOMPLETE }) {
        nodes { startAt }
      }
    }
  }
`

const CLIENT_ADDRESS_EDIT_MUTATION = /* GraphQL */ `
  mutation ClientAddressEdit($clientId: EncodedId!, $input: ClientEditInput!) {
    clientEdit(clientId: $clientId, input: $input) {
      client { id }
      userErrors { message path }
    }
  }
`

const PROPERTY_ADDRESS_EDIT_MUTATION = /* GraphQL */ `
  mutation PropertyAddressEdit($propertyId: EncodedId!, $input: PropertyEditInput!) {
    propertyEdit(propertyId: $propertyId, input: $input) {
      property { id }
      userErrors { message path }
    }
  }
`

// The linked-property variant of the state query: the SAME client fields,
// plus the exact property this lead's address IS (leads.jobber_property_id).
// Used when the link exists so a CORRECTION edits precisely that property —
// on any client, however many properties they hold — instead of the
// single-property blast-radius guess below.
const GET_LINKED_ADDRESS_STATE_QUERY = /* GraphQL */ `
  query GetLinkedAddressState($clientId: EncodedId!, $propertyId: EncodedId!) {
    client(id: $clientId) {
      id
      billingAddress { street street1 street2 city province postalCode country }
      scheduledItems(first: 50, filter: { scheduleItemType: VISIT, completionState: INCOMPLETE }) {
        nodes { startAt }
      }
    }
    property(id: $propertyId) {
      id
      address { street street1 street2 city province postalCode country }
    }
  }
`

const globalId = (type: 'Client' | 'Property', numeric: string) =>
  Buffer.from(`gid://Jobber/${type}/${numeric}`, 'utf8').toString('base64')

const numericFromGlobal = (gid: string | null | undefined): string | null => {
  if (!gid) return null
  try {
    const decoded = Buffer.from(String(gid), 'base64').toString('utf8')
    const tail = decoded.split('/').pop()
    return tail && /^\d+$/.test(tail) ? tail : null
  } catch { return null }
}

export async function syncLeadAddressToJobber(opts: {
  leadId: string
  locationSlug: string
  jobberClientId: string // numeric, as stored on leads.jobber_client_id
  target: AddressTarget
  // leads.jobber_property_id when the lead carries one — the property this
  // address IS. Present → the correction targets it directly.
  linkedPropertyId?: string | null
}): Promise<AddressWriteback> {
  const { leadId, locationSlug, jobberClientId, target } = opts

  const breadcrumb = (status: 'success' | 'error', outcome: AddressWriteback, detail?: string) =>
    writeSyncLog({
      location_id: locationSlug,
      entity_id: leadId,
      entity_type: 'client',
      direction: 'outbound',
      jobber_record_id: jobberClientId,
      status,
      message:
        `Lead edit address sync; client=${jobberClientId}; ` +
        `billing:${outcome.billing},property:${outcome.property}` +
        (outcome.upcoming_visits ? '; upcoming_visits' : '') +
        (detail ? `; ${detail}` : ''),
    })

  const failedBoth: AddressWriteback = { billing: 'failed', property: 'failed', upcoming_visits: false }

  try {
    const clientGlobalId = globalId('Client', jobberClientId)

    // Linked path: fetch the exact property alongside billing. The linked
    // property may not sit in the client's first page, so it is addressed by
    // id, never discovered.
    const linked = opts.linkedPropertyId ? String(opts.linkedPropertyId) : null
    const res = linked
      ? await jobberGraphQL(locationSlug, GET_LINKED_ADDRESS_STATE_QUERY, {
          clientId: clientGlobalId,
          propertyId: globalId('Property', linked),
        })
      : await jobberGraphQL(locationSlug, GET_CLIENT_ADDRESS_STATE_QUERY, {
          clientId: clientGlobalId,
        })
    if (res.errors?.length || !res.data?.client) {
      // Includes the no-valid-token case — warn, don't block the save.
      const reason = res.errors?.[0]?.message || 'client_not_found_in_jobber'
      console.warn('[address-sync] client fetch failed', { leadId, jobberClientId, reason })
      await breadcrumb('error', failedBoth, reason)
      return failedBoth
    }
    const client = res.data.client
    // In the linked shape the property arrives as its own root field; fold it
    // into the page shape the planner already understands (totalCount 1 =
    // "edit exactly this one"). A linked id Jobber no longer knows (deleted
    // property) falls back to the discovery shape's zero-property outcome.
    if (linked) {
      const linkedProp = res.data.property
      client.clientProperties = linkedProp?.id
        ? { totalCount: 1, nodes: [linkedProp] }
        : { totalCount: 0, nodes: [] }
    }

    // ── billing ──────────────────────────────────────────────────
    const billingPlan = buildBillingAddressInput(target, client.billingAddress)
    let billing = resolveAddressWriteback(billingPlan.plan, false)
    if (billingPlan.input) {
      const edit = await jobberMutation(locationSlug, CLIENT_ADDRESS_EDIT_MUTATION, {
        clientId: clientGlobalId,
        input: { billingAddress: billingPlan.input },
      })
      if (edit.userErrors?.length) {
        console.warn('[address-sync] clientEdit userErrors', JSON.stringify(edit.userErrors))
      }
      billing = resolveAddressWriteback(billingPlan.plan, !!edit.userErrors?.length)
    }

    // ── property (service address) ───────────────────────────────
    const propPlan = buildPropertyAddressPlan(target, client.clientProperties)
    let property = resolvePropertyWriteback(propPlan.kind, false)
    if (propPlan.kind === 'edit' && propPlan.propertyId && propPlan.input) {
      const edit = await jobberMutation(locationSlug, PROPERTY_ADDRESS_EDIT_MUTATION, {
        propertyId: propPlan.propertyId,
        input: { address: propPlan.input },
      })
      if (edit.userErrors?.length) {
        console.warn('[address-sync] propertyEdit userErrors', JSON.stringify(edit.userErrors))
      }
      property = resolvePropertyWriteback(propPlan.kind, !!edit.userErrors?.length)
    }

    const outcome: AddressWriteback = {
      billing,
      property,
      // Annotation, not a gate: only meaningful when the service address
      // actually moved under a scheduled future visit.
      upcoming_visits:
        property === 'updated' && hasUpcomingVisit(client.scheduledItems?.nodes, Date.now()),
    }

    const anyFailed = billing === 'failed' || property === 'failed'
    await breadcrumb(anyFailed ? 'error' : 'success', outcome)
    return outcome
  } catch (err: any) {
    console.warn('[address-sync] threw', { leadId, jobberClientId, error: err?.message || String(err) })
    await breadcrumb('error', failedBoth, err?.message || 'unexpected_error')
    return failedBoth
  }
}

// ─── THE MOVE: add a property, touch nothing historical ───────────────
//
// "They moved" adds the NEW address as a NEW Jobber property on the same
// client and leaves the old property — and every job, quote and invoice
// hanging off it — exactly as it is. This is Jobber's own model (one
// client, N properties); deleting or editing the old property is never
// done here, deliberately: deletion destroys its history, and editing is
// what the correction path is for.
//
// Same posture as the sync above: never throws, never blocks the lead
// save, one sync_log breadcrumb either way.
const PROPERTY_CREATE_FOR_MOVE_MUTATION = /* GraphQL */ `
  mutation PropertyCreate($clientId: EncodedId!, $input: PropertyCreateInput!) {
    propertyCreate(clientId: $clientId, input: $input) {
      properties { id }
      userErrors { message path }
    }
  }
`

// Billing on a move FOLLOWS THE PERSON (proposed to Kevin, implemented
// pending his veto): invoices bill to where the client lives now, while
// per-job service addresses stay on their untouched properties. Same
// clientEdit + echo-guard rails as the correction path.
const GET_BILLING_QUERY = /* GraphQL */ `
  query GetClientBilling($clientId: EncodedId!) {
    client(id: $clientId) {
      id
      billingAddress { street street1 street2 city province postalCode country }
    }
  }
`

export interface MovePropertyResult {
  created: boolean
  // Numeric id of the new property (leads.jobber_property_id convention).
  propertyId: string | null
  billing: AddressWritebackOutcome
  error: string | null
}

export async function createPropertyForMove(opts: {
  leadId: string
  locationSlug: string
  jobberClientId: string
  target: AddressTarget
}): Promise<MovePropertyResult> {
  const { leadId, locationSlug, jobberClientId, target } = opts
  let billing: AddressWritebackOutcome = 'unchanged'

  const fail = async (error: string): Promise<MovePropertyResult> => {
    console.warn('[address-move] property create failed', { leadId, jobberClientId, error })
    await writeSyncLog({
      location_id: locationSlug,
      entity_id: leadId,
      entity_type: 'client',
      direction: 'outbound',
      jobber_record_id: jobberClientId,
      status: 'error',
      message: `Move: new Jobber property NOT created; client=${jobberClientId}; billing:${billing}; ${error}`,
    })
    return { created: false, propertyId: null, billing, error }
  }

  try {
    const clientGlobalId = globalId('Client', jobberClientId)

    // ── billing follows the person (never fatal to the property step) ──
    const bres = await jobberGraphQL(locationSlug, GET_BILLING_QUERY, { clientId: clientGlobalId })
    if (bres.errors?.length || !bres.data?.client) {
      billing = 'failed'
    } else {
      const plan = buildBillingAddressInput(target, bres.data.client.billingAddress)
      billing = resolveAddressWriteback(plan.plan, false)
      if (plan.input) {
        const bedit = await jobberMutation(locationSlug, CLIENT_ADDRESS_EDIT_MUTATION, {
          clientId: clientGlobalId,
          input: { billingAddress: plan.input },
        })
        billing = resolveAddressWriteback(plan.plan, !!bedit.userErrors?.length)
      }
    }

    // ── the new property. The old one is NEVER touched here. ──────────
    const edit = await jobberMutation(locationSlug, PROPERTY_CREATE_FOR_MOVE_MUTATION, {
      clientId: clientGlobalId,
      input: {
        properties: [{
          address: {
            street1: target.street,
            city: target.city,
            province: target.state,
            postalCode: target.zip,
          },
        }],
      },
    })
    if (edit.userErrors?.length) {
      return await fail(edit.userErrors.map((e: any) => e?.message).filter(Boolean).join('; ') || 'user_errors')
    }
    const created = edit.data?.propertyCreate?.properties?.[0]?.id ?? null
    const numeric = numericFromGlobal(created)
    if (!numeric) return await fail('property_create_returned_no_id')
    await writeSyncLog({
      location_id: locationSlug,
      entity_id: leadId,
      entity_type: 'client',
      direction: 'outbound',
      jobber_record_id: jobberClientId,
      status: 'success',
      message: `Move: new Jobber property ${numeric} created; old property untouched; billing:${billing}; client=${jobberClientId}`,
    })
    return { created: true, propertyId: numeric, billing, error: null }
  } catch (err: any) {
    return await fail(err?.message || 'unexpected_error')
  }
}
