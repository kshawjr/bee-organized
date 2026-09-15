// lib/use-touchpoints-realtime.ts
// ─────────────────────────────────────────────────────────────
// Supabase Realtime for TOUCHPOINTS: someone else's logged call — another bee
// at the same location, or a webhook — reaches the open Hive without a reload.
//
// WHY THIS EXISTS AS A SECOND SUBSCRIPTION. use-leads-realtime already carries
// every change to a LEAD row, and BeeHub's handler refetches the whole person
// on any of them, so stage moves and field edits are already live. Logging a
// call writes to the TOUCHPOINTS table and never touches the lead row, so
// leads realtime never fires for it. That is the entire gap, and it is why
// this cannot be folded into the leads channel: there is no leads event to
// fold it into.
//
// NOT A SIGNAL — unlike use-leads-realtime. That hook refetches because its
// payload is a flat leads row missing all the Person enrichment. Here the flat
// row IS the whole truth: people-mapper's touchpointToTimelineEntry reads
// id/kind/method/label/occurred_at/status and nothing else, all of them
// columns on this row. A refetch would buy nothing and cost a request per
// logged call across every open tab.
//
// SCOPE mirrors use-leads-realtime exactly — locFilter carries the board's
// location vocabulary (a location uuid, or 'all' for super_admin/corporate),
// and 'all' subscribes UNFILTERED so RLS scopes delivery. touchpoints carries
// its own location_uuid (populated on every row in production — verified
// 2026-09-15, 3914/3914, no nulls), so the filtered case needs no join.
//
// INSERT ONLY, deliberately. A touchpoint is an APPEND to a timeline: the
// merge it feeds is additive-by-id and converges on the server snapshot, so
// an UPDATE would dedupe to a no-op and a DELETE has no defined meaning for
// an override that only ever ADDS rows the snapshot hasn't shown yet. Taking
// '*' here would invite a second opinion about timeline membership, which is
// the one thing peopleTouchPatch's header tells us not to build. The snapshot
// remains the authority; this only shortens the wait for it.
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase'

// The flat touchpoints row, as postgres_changes delivers it. Only the fields
// touchpointToTimelineEntry projects, plus the lead_id that says whose it is.
export type TouchpointRealtimeRow = {
  id: string
  lead_id: string
  kind?: string | null
  method?: string | null
  label?: string | null
  occurred_at?: string | null
  status?: string | null
}

export function useTouchpointsRealtime(
  locFilter: string | null | undefined,
  onInsert: (row: TouchpointRealtimeRow) => void
) {
  // Latest-ref, as in use-leads-realtime: the effect stays keyed on locFilter
  // ALONE (resubscribing per render would thrash the websocket) while never
  // invoking a stale closure.
  const onInsertRef = useRef(onInsert)
  onInsertRef.current = onInsert

  useEffect(() => {
    if (!locFilter) return

    // Realtime is an ENHANCEMENT: the Hive renders from its server-rendered
    // set and router.refresh()/focus is the backstop. createClient() THROWS
    // when the NEXT_PUBLIC_SUPABASE_* vars are missing, and this runs in a
    // passive effect during commit — unguarded, a config gap would take the
    // whole tree down to buy live touchpoints. Degrade to no-realtime
    // instead, loudly.
    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
    } catch (e) {
      console.error('[realtime] touchpoints: no supabase client, live touchpoints are off:', e)
      return
    }

    const scoped = locFilter !== 'all'

    const channel = supabase
      .channel(`touchpoints:${scoped ? locFilter : 'all'}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'touchpoints',
          ...(scoped ? { filter: `location_uuid=eq.${locFilter}` } : {}),
        },
        (payload) => {
          const row = payload.new as TouchpointRealtimeRow
          // A row with no id can't be deduped, and one with no lead_id has
          // nobody to belong to. Either way there is nothing safe to merge.
          if (!row || !row.id || !row.lead_id) return
          onInsertRef.current(row)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [locFilter])
}
