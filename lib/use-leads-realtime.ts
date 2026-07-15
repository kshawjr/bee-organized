// lib/use-leads-realtime.ts
// ─────────────────────────────────────────────────────────────
// Supabase Realtime for leads: pushes lead changes that happen with no client
// event — a Jobber webhook, MAKE, website intake, another user — into the open
// Hive (Inbox included) without a reload.
//
// SIGNAL ONLY. The postgres_changes payload is one flat leads row with none of
// the Person enrichment (no joined touchpoints, engagements, addresses), so
// handing payload.new to setPeople would render a half-blank card. The caller
// takes the id and refetches in Person shape (GET /api/leads/:id), exactly as
// the engagement board does via /api/engagements?ids=.
//
// SCOPE mirrors use-engagements-realtime: locFilter carries the board's
// location vocabulary — a location uuid, or 'all' for super_admin/corporate.
// 'all' subscribes UNFILTERED and lets RLS scope delivery. This hook used to
// take a single locationUuid resolved from currentLocation/currentUser, which
// on an 'all' view silently pinned the subscription to one arbitrary location
// (or, with no location at all, subscribed to nothing) — so an admin never saw
// new leads land. leads SELECT RLS admits admins to every row and fences
// owners to their own location via the locations slug-join, so unfiltered
// delivery produces exactly the 'all' set for the people who can hold 'all'.
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase'

export type LeadsRealtimeEvent = {
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  leadId: string
}

export function useLeadsRealtime(
  locFilter: string | null | undefined,
  onChange: (event: LeadsRealtimeEvent) => void
) {
  // Latest-ref, as in use-engagements-realtime: the effect stays keyed on
  // locFilter ALONE (resubscribing per render would thrash the websocket)
  // while never invoking a stale closure. This supersedes the old "caller must
  // stabilize with useCallback" contract — a handler that closes over people
  // no longer has to be dependency-free to be correct.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!locFilter) return

    // Realtime is an ENHANCEMENT: the Hive renders from its server-rendered
    // set and router.refresh()/focus is the backstop. createClient() THROWS
    // when the NEXT_PUBLIC_SUPABASE_* vars are missing, and this runs in a
    // passive effect during commit — unguarded, a config gap would take the
    // whole tree down to buy live leads. Degrade to no-realtime instead,
    // loudly.
    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
    } catch (e) {
      console.error('[realtime] leads: no supabase client, live leads are off:', e)
      return
    }

    const scoped = locFilter !== 'all'

    const channel = supabase
      .channel(`leads:${scoped ? locFilter : 'all'}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'leads',
          ...(scoped ? { filter: `location_uuid=eq.${locFilter}` } : {}),
        },
        (payload) => {
          const leadId = (payload.new as any)?.id || (payload.old as any)?.id
          if (!leadId) return
          onChangeRef.current({
            type: payload.eventType as LeadsRealtimeEvent['type'],
            leadId,
          })
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [locFilter])
}
