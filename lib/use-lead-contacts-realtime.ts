// lib/use-lead-contacts-realtime.ts
// ─────────────────────────────────────────────────────────────
// Supabase Realtime for LEAD CONTACTS: a secondary contact someone else adds
// to a client appears on your open card for that client, with no reload.
//
// WHY A SEPARATE SUBSCRIPTION. use-leads-realtime carries changes to the LEAD
// row; a contact writes to lead_contacts and touches neither that nor
// touchpoints nor lead_notes, so none of the existing channels has an event
// to carry it. Third table, same gap, same shape of fix as
// use-lead-notes-realtime (94af905).
//
// NOT A SIGNAL. The flat row IS what the card renders:
// /api/clients/[id]/profile selects id, name, role, phone, email, and
// postgres_changes delivers all of those. A refetch would buy nothing.
//
// SCOPED BY LEAD, like the notes hook and for the same reason: each hook
// subscribes on its SURFACE's own vocabulary, and the client card's
// vocabulary is one client. A location filter would deliver every contact at
// the location to a card that can use one lead's worth.
//
// OPENED THROUGH use-realtime-channel, which is not optional. That primitive
// awaits the access token before joining; a channel that joins anonymously is
// accepted, reports SUBSCRIBED, and then delivers nothing forever — the bug
// that cost a day (9c5cf0a). lead_contacts' RLS policy grants to
// `authenticated` only, so an anonymous join here would be silently dead.
//
// INSERT ONLY. The merge it feeds is additive-by-id and converges on the
// snapshot, so an UPDATE would dedupe to a no-op and a DELETE has no defined
// meaning for a list that only ever gains rows this way. An edit or a removal
// by another user still needs a reload — deliberately out of scope, and
// noted here rather than half-built.
// ─────────────────────────────────────────────────────────────
import { useRef } from 'react'
import { useRealtimeChannel } from '@/lib/use-realtime-channel'

// The flat lead_contacts row, as postgres_changes delivers it.
export type LeadContactRealtimeRow = {
  id: string
  lead_id: string
  name?: string | null
  role?: string | null
  phone?: string | null
  email?: string | null
  created_at?: string | null
}

export function useLeadContactsRealtime(
  leadId: string | null | undefined,
  onInsert: (row: LeadContactRealtimeRow) => void
) {
  // Latest-ref, as in every other hook here: the effect stays keyed on leadId
  // ALONE while never invoking a stale closure.
  const onInsertRef = useRef(onInsert)
  onInsertRef.current = onInsert

  useRealtimeChannel(leadId, 'lead contacts', (supabase) =>
    supabase
      .channel(`lead_contacts:${leadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'lead_contacts',
          filter: `lead_id=eq.${leadId}`,
        },
        (payload: any) => {
          const row = payload.new as LeadContactRealtimeRow
          // No id means nothing to dedupe on; a mismatched lead_id means the
          // row is not this card's, whatever the filter let through.
          if (!row || !row.id || row.lead_id !== leadId) return
          onInsertRef.current(row)
        }
      )
  )
}
