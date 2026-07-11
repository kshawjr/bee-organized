// lib/jobber-address-sync.ts
//
// Lead-edit trigger for the Jobber BILLING-address write-back — the
// address sibling of lib/jobber-contact-sync.ts, same rails:
//   fetch-current → diff → (maybe) one clientEdit → breadcrumb.
//
// CLIENT-scoped by design: only clientEdit { billingAddress } — never a
// property mutation. Jobber addresses are often PROPERTY records with
// jobs attached; those stay exclusively Jobber-managed (PROPERTY_UPDATE
// webhooks keep flowing inbound as before).
//
// ECHO GUARD (mirrors contact-sync):
//   1. Our clientEdit makes Jobber fire CLIENT_UPDATE back at us; that
//      handler writes the lead row via upsertLead — never through
//      PATCH /api/leads/:id — so the trigger cannot re-fire.
//   2. The echo overwrites lead.address/city/state/zip from
//      billingAddress, which after our edit ARE the pushed values.
//   3. Fetch-at-push: when Jobber already carries the address, no
//      mutation is sent at all.
//
// Never throws — the lead save has already succeeded; outcome rides the
// PATCH response + a sync_log breadcrumb (entity_type 'client': the
// sync_log CHECK constraint has no 'lead' value).

import { jobberGraphQL, jobberMutation } from './jobber'
import { writeSyncLog } from './sync-log'
import {
  buildBillingAddressInput,
  resolveAddressWriteback,
  type AddressTarget,
  type AddressWritebackOutcome,
} from './jobber-address-writeback'

const GET_CLIENT_BILLING_QUERY = /* GraphQL */ `
  query GetClientBillingAddress($clientId: EncodedId!) {
    client(id: $clientId) {
      id
      billingAddress { street street1 street2 city province postalCode country }
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

export async function syncLeadAddressToJobber(opts: {
  leadId: string
  locationSlug: string
  jobberClientId: string // numeric, as stored on leads.jobber_client_id
  target: AddressTarget
}): Promise<AddressWritebackOutcome> {
  const { leadId, locationSlug, jobberClientId, target } = opts

  const breadcrumb = (status: 'success' | 'error', outcome: AddressWritebackOutcome, detail?: string) =>
    writeSyncLog({
      location_id: locationSlug,
      entity_id: leadId,
      entity_type: 'client',
      direction: 'outbound',
      jobber_record_id: jobberClientId,
      status,
      message:
        `Lead edit address sync; client=${jobberClientId}; billingAddress:${outcome}` +
        (detail ? `; ${detail}` : ''),
    })

  try {
    const clientGlobalId = Buffer.from(
      `gid://Jobber/Client/${jobberClientId}`,
      'utf8',
    ).toString('base64')

    const res = await jobberGraphQL(locationSlug, GET_CLIENT_BILLING_QUERY, {
      clientId: clientGlobalId,
    })
    if (res.errors?.length || !res.data?.client) {
      // Includes the no-valid-token case — warn, don't block the save.
      const reason = res.errors?.[0]?.message || 'client_not_found_in_jobber'
      console.warn('[address-sync] client fetch failed', { leadId, jobberClientId, reason })
      await breadcrumb('error', 'failed', reason)
      return 'failed'
    }

    const { input, plan } = buildBillingAddressInput(target, res.data.client.billingAddress)

    let outcome: AddressWritebackOutcome
    if (plan === 'none' || !input) {
      outcome = 'unchanged' // Jobber already carries it — zero mutations
    } else {
      const edit = await jobberMutation(locationSlug, CLIENT_ADDRESS_EDIT_MUTATION, {
        clientId: clientGlobalId,
        input: { billingAddress: input },
      })
      if (edit.userErrors?.length) {
        console.warn('[address-sync] clientEdit userErrors', JSON.stringify(edit.userErrors))
      }
      outcome = resolveAddressWriteback(plan, !!edit.userErrors?.length)
    }

    await breadcrumb(outcome === 'failed' ? 'error' : 'success', outcome)
    return outcome
  } catch (err: any) {
    console.warn('[address-sync] threw', { leadId, jobberClientId, error: err?.message || String(err) })
    await breadcrumb('error', 'failed', err?.message || 'unexpected_error')
    return 'failed'
  }
}
