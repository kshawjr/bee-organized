// lib/jobber-name-sync.ts
//
// Lead-edit trigger for the Jobber NAME write-back — the contact
// write-back (lib/jobber-contact-sync.ts) with the name fields in place
// of phone/email. Same rails, deliberately: the address field already
// proved this shape in production, and a second pattern for the same
// problem is a second thing to get wrong.
//
// Until now a client's name could only be fixed in Jobber and waited
// for on the CLIENT_UPDATE echo — which does nothing at all for a lead
// that was never sent to Jobber (a website enquiry sitting at New has
// no jobber_client_id, and there are plenty). The name was the one
// field on the profile header with no pencil.
//
// Fetches the linked client BY CLIENT ID — not by name search: the name
// may be exactly what is being corrected, so a search on it would miss
// the client (the same reason the contact sync fetches by id rather
// than by email).
//
// ECHO GUARD — one user edit converges to at most one Jobber mutation.
// Identical in structure to the contact sync's:
//   1. Our clientEdit makes Jobber fire CLIENT_UPDATE back at us. That
//      handler (handleClientUpdate → upsertLead) writes the lead row
//      directly — it never goes through PATCH /api/leads/:id — so the
//      trigger cannot re-fire from the echo by construction.
//   2. The echo overwrites the name parts with Jobber's values, which
//      after our edit ARE the pushed values; and upsertLead derives
//      leads.name with the SAME rule lib/lead-name composes with, so
//      the echo cannot introduce drift either.
//   3. Belt-and-suspenders: even when a diff-vs-DB says "changed", the
//      fetch-at-push diff omits values already present on the client —
//      applying the same value is a no-op and no mutation is sent.
//
// NEVER THROWS. The lead save has already succeeded by the time this
// runs and no Jobber-side failure may undo it — but the failure is
// REPORTED, never swallowed: the outcome rides the PATCH response
// (name_writeback), lands in the audit touchpoint, and reaches the
// owner as a non-success toast.

import { jobberGraphQL, jobberMutation } from './jobber'
import { writeSyncLog } from './sync-log'
import {
  buildNameEditFields,
  resolveNameWriteback,
  type NameField,
  type NameWriteback,
} from './lead-name'

// Name fields only, with the ids we need nothing else from. The contact
// sync owns phones/emails; this query has no business refreshing them.
const GET_CLIENT_NAME_QUERY = /* GraphQL */ `
  query GetClientName($clientId: EncodedId!) {
    client(id: $clientId) {
      id
      firstName
      lastName
      companyName
    }
  }
`

const CLIENT_NAME_EDIT_MUTATION = /* GraphQL */ `
  mutation ClientNameEdit($clientId: EncodedId!, $input: ClientEditInput!) {
    clientEdit(clientId: $clientId, input: $input) {
      client { id }
      userErrors { message path }
    }
  }
`

export async function syncLeadNameToJobber(opts: {
  leadId: string
  locationSlug: string
  jobberClientId: string // numeric, as stored on leads.jobber_client_id
  target: Record<NameField, string> // the merged parts as stored here
  cleared: NameField[] // emptied here — never erased there, said out loud
}): Promise<NameWriteback> {
  const { leadId, locationSlug, jobberClientId, target, cleared } = opts

  // Fallback outcome when we fail BEFORE knowing a per-field plan: every
  // field we meant to push is reported failed. Silence is not an option
  // here — an unreported failure is the bug this feature is written
  // against.
  const clearedSet = new Set(cleared)
  const attempted: NameWriteback = {
    first_name: target.first_name ? 'failed' : clearedSet.has('first_name') ? 'kept_in_jobber' : 'unchanged',
    last_name: target.last_name ? 'failed' : clearedSet.has('last_name') ? 'kept_in_jobber' : 'unchanged',
    company: target.company ? 'failed' : clearedSet.has('company') ? 'kept_in_jobber' : 'unchanged',
  }

  const breadcrumb = (status: 'success' | 'error', outcome: NameWriteback, detail?: string) =>
    writeSyncLog({
      location_id: locationSlug,
      entity_id: leadId,
      entity_type: 'client',
      direction: 'outbound',
      jobber_record_id: jobberClientId,
      status,
      message:
        `Lead edit name sync; client=${jobberClientId}; ` +
        `name=first:${outcome.first_name},last:${outcome.last_name},company:${outcome.company}` +
        (detail ? `; ${detail}` : ''),
    })

  try {
    const clientGlobalId = Buffer.from(
      `gid://Jobber/Client/${jobberClientId}`,
      'utf8',
    ).toString('base64')

    const res = await jobberGraphQL(locationSlug, GET_CLIENT_NAME_QUERY, {
      clientId: clientGlobalId,
    })
    if (res.errors?.length || !res.data?.client) {
      // Includes the no-valid-token case — warn, don't block the save,
      // but report it as a failure rather than as quiet success.
      const reason = res.errors?.[0]?.message || 'client_not_found_in_jobber'
      console.warn('[name-sync] client fetch failed', { leadId, jobberClientId, reason })
      await breadcrumb('error', attempted, reason)
      return attempted
    }

    const { fields, plan } = buildNameEditFields(target, cleared, res.data.client)

    let outcome: NameWriteback
    if (Object.keys(fields).length === 0) {
      // Echo-guard half 3: Jobber already carries every value we would
      // push — converge with zero mutations. Any emptied field still
      // reports 'kept_in_jobber' through resolveNameWriteback.
      outcome = resolveNameWriteback(plan, false)
    } else {
      const edit = await jobberMutation(locationSlug, CLIENT_NAME_EDIT_MUTATION, {
        clientId: clientGlobalId,
        input: fields,
      })
      if (edit.userErrors?.length) {
        console.warn('[name-sync] clientEdit userErrors', JSON.stringify(edit.userErrors))
      }
      outcome = resolveNameWriteback(plan, !!edit.userErrors?.length)
    }

    const failed =
      outcome.first_name === 'failed' ||
      outcome.last_name === 'failed' ||
      outcome.company === 'failed'
    await breadcrumb(failed ? 'error' : 'success', outcome)
    return outcome
  } catch (err: any) {
    console.warn('[name-sync] threw', { leadId, jobberClientId, error: err?.message || String(err) })
    await breadcrumb('error', attempted, err?.message || 'unexpected_error')
    return attempted
  }
}
