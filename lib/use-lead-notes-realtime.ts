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
// INSERT ONLY, for the reason spelled out in noteStream.js: the merge is
// additive-by-id and converges on the snapshot, so an UPDATE would dedupe to
// a no-op and a DELETE has no defined meaning for a stream that only ever
// gains rows. Notes are not edited in the UI today.
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase'

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

  useEffect(() => {
    if (!leadId) return

    // Realtime is an ENHANCEMENT: the card renders from its own fetch and a
    // reload is the backstop. createClient() THROWS when the
    // NEXT_PUBLIC_SUPABASE_* vars are missing, and this runs in a passive
    // effect during commit — unguarded, a config gap would take the client
    // card down to buy live notes. Degrade to no-realtime instead, loudly.
    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
    } catch (e) {
      console.error('[realtime] lead notes: no supabase client, live notes are off:', e)
      return
    }

    const channel = supabase
      .channel(`lead_notes:${leadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'lead_notes',
          filter: `lead_id=eq.${leadId}`,
        },
        (payload) => {
          const row = payload.new as LeadNoteRealtimeRow
          // No id means nothing to dedupe on; a mismatched lead_id means the
          // row is not this card's, whatever the filter let through.
          if (!row || !row.id || row.lead_id !== leadId) return
          onInsertRef.current(row)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [leadId])
}
