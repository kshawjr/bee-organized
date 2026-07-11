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

export async function syncLeadAddressToJobber(opts: {
  leadId: string
  locationSlug: string
  jobberClientId: string // numeric, as stored on leads.jobber_client_id
  target: AddressTarget
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
    const clientGlobalId = Buffer.from(
      `gid://Jobber/Client/${jobberClientId}`,
      'utf8',
    ).toString('base64')

    const res = await jobberGraphQL(locationSlug, GET_CLIENT_ADDRESS_STATE_QUERY, {
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
