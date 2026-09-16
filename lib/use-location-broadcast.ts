// lib/use-location-broadcast.ts
// ─────────────────────────────────────────────────────────────
// Supabase Realtime BROADCAST for the open Hive — the server telling this
// location something happened, as opposed to postgres_changes, which reports
// a row that changed.
//
// WHY A BROADCAST AND NOT ANOTHER postgres_changes CHANNEL. A transferred
// lead never reached the destination. For an UPDATE, Supabase must be able to
// show the row to the subscriber in BOTH its old and new state before it
// delivers; the leads SELECT policy is location-scoped, so before the move the
// lead is at a location the receiving user cannot see and the event is never
// sent. No client code can fix that, and the alternative — widening the leads
// policy so every owner can read every location's leads — is a permanent
// security loosening bought for a transient delivery problem.
//
// A broadcast sidesteps the question entirely: it is addressed to a TOPIC,
// not derived from a row, so no row-level policy is consulted on the way out.
// It is therefore correct whatever the real reason the row event went missing.
//
// THE TOPIC IS PUBLIC. Anyone who knows a location uuid could subscribe, so
// everything sent here is ids only — a listener learns "some lead moved" and
// can do nothing with it, because reading the lead still goes through
// GET /api/leads/:id and its location check. Do not put lead content on this
// channel; that would need a PRIVATE channel, Realtime Authorization (an RLS
// policy on realtime.messages) and setAuth() on this client.
//
// SCOPE mirrors the postgres_changes hooks: locFilter carries the board's own
// location vocabulary. Unlike those, 'all' is a REAL topic here rather than an
// absence of one — the server broadcasts to `location:all` as well as to both
// ends of the move, because the all-locations view holds the unrouted transfer
// queue and cannot enumerate every location to listen for it.
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase'
import { locationTopic, LEAD_MOVED_EVENT, type LeadMovedPayload } from '@/lib/realtime-broadcast'

export type { LeadMovedPayload }

export function useLocationBroadcast(
  locFilter: string | null | undefined,
  onLeadMoved: (payload: LeadMovedPayload) => void
) {
  // Latest-ref, as in the postgres_changes hooks: the effect stays keyed on
  // locFilter ALONE while never invoking a stale closure.
  const onLeadMovedRef = useRef(onLeadMoved)
  onLeadMovedRef.current = onLeadMoved

  useEffect(() => {
    if (!locFilter) return

    // Realtime is an ENHANCEMENT: the Hive renders from its server-rendered
    // set and a reload is the backstop. createClient() THROWS on missing
    // NEXT_PUBLIC_SUPABASE_* and this runs in a passive effect during commit,
    // so an unguarded throw would take the whole tree down to buy live
    // transfers. Degrade to no-broadcast instead, loudly.
    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
    } catch (e) {
      console.error('[broadcast] no supabase client, live transfers are off:', e)
      return
    }

    const channel = supabase
      .channel(locationTopic(locFilter))
      .on('broadcast', { event: LEAD_MOVED_EVENT }, (message: any) => {
        const p = message?.payload as LeadMovedPayload | undefined
        // Ids only, and a move with no lead or no destination says nothing.
        if (!p || !p.leadId || !p.toLocationUuid) return
        onLeadMovedRef.current(p)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [locFilter])
}
