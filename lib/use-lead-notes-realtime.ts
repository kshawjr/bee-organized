// lib/use-lead-notes-realtime.ts
// ─────────────────────────────────────────────────────────────
// Supabase Realtime for LEAD NOTES: a note someone else writes on a client
// appears on your open card for that client, with no reload.
//
// WHY A THIRD SUBSCRIPTION. use-leads-realtime carries every change to a LEAD
// row; use-touchpoints-realtime carries logged calls. A note writes to
// lead_notes and touches neither, so neither channel has an event to carry it.
// Same gap as touchpoints, same shape of fix.
//
// NOT A SIGNAL — like use-touchpoints-realtime, unlike use-leads-realtime.
// The flat row IS what the card renders: /api/clients/[id]/profile selects
// id, kind, text, user_label, created_at (+ engagement_id for job notes), and
// postgres_changes delivers all of those. A refetch would buy nothing.
//
// SCOPED BY LEAD, not by location. This is the one deliberate difference from
// use-touchpoints-realtime, and it is the same principle rather than a
// departure from it: each hook subscribes on its SURFACE's own vocabulary.
// The Inbox watches a location because it shows a location's worklist; the
// client card watches ONE client because that is the whole of what it shows.
// A location filter here would deliver every note at the location to a card
// that can use one lead's worth, and the merge would drop the rest.
//
// RLS still scopes delivery underneath, so a lead_id someone may not see
// yields nothing even though the filter names it. That is defence in depth,
// not the primary guard: lead_notes carries its first SELECT policy in
// migrations/lead_notes_realtime_rls.sql, derived from the lead.
//
// INSERT ONLY, and this was RE-DECIDED when edit and delete shipped rather
// than left as an assumption. Notes ARE edited and deleted in the UI now, so
// the original reasoning ("not edited today") expired. The decision stands,
// for two harder reasons:
//
//   · A DELETE event cannot be authorised here. lead_notes has REPLICA
//     IDENTITY DEFAULT and RLS enabled, so the old record carries only the
//     PRIMARY KEY — and Supabase's docs are explicit that with RLS on, even
//     `replica identity full` does not change that. Our policy authorises a
//     note through its LEAD, which the old record does not carry, and delete
//     events are not filterable either. A DELETE path here would be code that
//     very likely never fires. Building it would be the half-thought thing.
//
//   · Shipping UPDATE alone would be WORSE than shipping neither. A watcher
//     would see edits live but keep a deleted note on screen — so a note
//     edited and then deleted would show the edit and never leave. "It
//     disappeared for the author and stayed for everyone else" is precisely
//     the failure to avoid; one reload for both verbs is coherent, half of it
//     is not.
//
// SO: another watcher sees an edit or a deletion on their next reload. The
// author's own card updates immediately (noteStream's replaceNote/removeNote).
// If this is ever revisited, the thing to establish FIRST is whether a DELETE
// event arrives at all for an RLS-protected table — everything else follows
// from that answer.
// ─────────────────────────────────────────────────────────────
import { useRef } from 'react'
import { useRealtimeChannel } from '@/lib/use-realtime-channel'

// The flat lead_notes row, as postgres_changes delivers it.
export type LeadNoteRealtimeRow = {
  id: string
  lead_id: string
  kind?: string | null
  text?: string | null
  user_label?: string | null
  created_at?: string | null
  engagement_id?: string | null
}

export function useLeadNotesRealtime(
  leadId: string | null | undefined,
  onInsert: (row: LeadNoteRealtimeRow) => void
) {
  // Latest-ref, as in the other two hooks: the effect stays keyed on leadId
  // ALONE while never invoking a stale closure.
  const onInsertRef = useRef(onInsert)
  onInsertRef.current = onInsert

  // Opened through use-realtime-channel so the access token is attached
  // BEFORE the join. That matters more here than anywhere: lead_notes' RLS
  // policy grants to `authenticated` only, so an anonymous join would be
  // accepted and then deliver nothing at all.
  useRealtimeChannel(leadId, 'lead notes', (supabase) =>
    supabase
      .channel(`lead_notes:${leadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'lead_notes',
          filter: `lead_id=eq.${leadId}`,
        },
        (payload: any) => {
          const row = payload.new as LeadNoteRealtimeRow
          // No id means nothing to dedupe on; a mismatched lead_id means the
          // row is not this card's, whatever the filter let through.
          if (!row || !row.id || row.lead_id !== leadId) return
          onInsertRef.current(row)
        }
      )
  )
}
