// lib/jobber-contact-sync.ts
//
// Lead-edit trigger for the Jobber contact write-back (feedback #2/#4 —
// Ankur's case). d51b764 wired the write-back only into send-to-jobber's
// matched-existing path, which a lead that is ALREADY jobber-linked never
// passes through: editing their phone/email in Bee Hub left Jobber stale.
// This module pushes contact edits at PATCH time instead.
//
// Fetches the linked client's phones/emails BY CLIENT ID — not by email
// search like the send path: the email may be exactly the field being
// edited, so a search on it would miss the client. The diff→ClientEditInput
// rails are shared with the send path (lib/jobber-contact-writeback.ts):
// edit primary-else-first, add when the client has none, omit when the
// value is already present anywhere on the client, never delete.
//
// ECHO GUARD — one user edit converges to at most one Jobber mutation:
//   1. Our clientEdit makes Jobber fire CLIENT_UPDATE back at us. That
//      handler (handleClientUpdate → upsertLead) writes the lead row
//      directly — it never goes through PATCH /api/leads/:id — so the
//      trigger cannot re-fire from the echo by construction.
//   2. The echo overwrites lead.phone/email with Jobber's primary values,
//      which after our edit ARE the pushed values (we edit the primary-
//      else-first entry, or add-as-primary when none exist). If Jobber
//      reformats them, diffContactPatch's normalized compare still treats
//      the next same-number save as unchanged.
//   3. Belt-and-suspenders: even when a diff-vs-DB says "changed", the
//      fetch-at-push diff omits values already present anywhere on the
//      client — applying the same value is a no-op and no mutation is sent.

import { jobberGraphQL, jobberMutation } from './jobber'
import { writeSyncLog } from './sync-log'
import {
  buildContactEditFields,
  resolveContactWriteback,
  type ContactWriteback,
} from './jobber-contact-writeback'

// Same shape the send path's FIND_CLIENT_QUERY returns for a matched node,
// minus the search: entry ids are required for *ToEdit targeting.
const GET_CLIENT_CONTACTS_QUERY = /* GraphQL */ `
  query GetClientContacts($clientId: EncodedId!) {
    client(id: $clientId) {
      id
      phones { id number primary }
      emails { id address primary }
    }
  }
`

// Contact fields only — the lead-edit trigger has no business refreshing
// names (the send path owns that).
const CLIENT_CONTACT_EDIT_MUTATION = /* GraphQL */ `
  mutation ClientContactEdit($clientId: EncodedId!, $input: ClientEditInput!) {
    clientEdit(clientId: $clientId, input: $input) {
      client { id }
      userErrors { message path }
    }
  }
`

// Never throws — the lead save has already succeeded by the time this runs,
// and no Jobber-side failure may undo that. Outcome rides the PATCH
// response + a sync_log breadcrumb (entity_type 'client': the sync_log
// CHECK constraint has no 'lead' value; entity_id carries the lead uuid).
export async function syncLeadContactToJobber(opts: {
  leadId: string
  locationSlug: string
  jobberClientId: string // numeric, as stored on leads.jobber_client_id
  phone: string // '' = field not being synced
  email: string
}): Promise<ContactWriteback> {
  const { leadId, locationSlug, jobberClientId, phone, email } = opts
  // Fallback outcome when we fail before knowing a per-field plan: every
  // field we meant to push is reported failed, untouched ones unchanged.
  const attempted: ContactWriteback = {
    phone: phone ? 'failed' : 'unchanged',
    email: email ? 'failed' : 'unchanged',
  }

  const breadcrumb = (status: 'success' | 'error', outcome: ContactWriteback, detail?: string) =>
    writeSyncLog({
      location_id: locationSlug,
      entity_id: leadId,
      entity_type: 'client',
      direction: 'outbound',
      jobber_record_id: jobberClientId,
      status,
      message:
        `Lead edit contact sync; client=${jobberClientId}; ` +
        `contact=phone:${outcome.phone},email:${outcome.email}` +
        (detail ? `; ${detail}` : ''),
    })

  try {
    const clientGlobalId = Buffer.from(
      `gid://Jobber/Client/${jobberClientId}`,
      'utf8',
    ).toString('base64')

    const res = await jobberGraphQL(locationSlug, GET_CLIENT_CONTACTS_QUERY, {
      clientId: clientGlobalId,
    })
    if (res.errors?.length || !res.data?.client) {
      // Includes the no-valid-token case — warn, don't block the save.
      const reason = res.errors?.[0]?.message || 'client_not_found_in_jobber'
      console.warn('[contact-sync] client fetch failed', { leadId, jobberClientId, reason })
      await breadcrumb('error', attempted, reason)
      return attempted
    }

    const { fields, plan } = buildContactEditFields({ phone, email }, res.data.client)

    let outcome: ContactWriteback
    if (plan.phone === 'none' && plan.email === 'none') {
      // Echo-guard half 3: Jobber already carries the value(s) — converge
      // with zero mutations.
      outcome = { phone: 'unchanged', email: 'unchanged' }
    } else {
      const edit = await jobberMutation(locationSlug, CLIENT_CONTACT_EDIT_MUTATION, {
        clientId: clientGlobalId,
        input: fields,
      })
      if (edit.userErrors?.length) {
        console.warn('[contact-sync] clientEdit userErrors', JSON.stringify(edit.userErrors))
      }
      outcome = resolveContactWriteback(plan, !!edit.userErrors?.length)
    }

    const failed = outcome.phone === 'failed' || outcome.email === 'failed'
    await breadcrumb(failed ? 'error' : 'success', outcome)
    return outcome
  } catch (err: any) {
    console.warn('[contact-sync] threw', { leadId, jobberClientId, error: err?.message || String(err) })
    await breadcrumb('error', attempted, err?.message || 'unexpected_error')
    return attempted
  }
}
