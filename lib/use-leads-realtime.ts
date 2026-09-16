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
import { useRef } from 'react'
import { useRealtimeChannel } from '@/lib/use-realtime-channel'

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

  // Opening the channel is use-realtime-channel's job: it awaits the access
  // token before joining, which is the whole of the anon-join bug. THIS
  // channel is the one that was caught joining without a token — it
  // subscribes first, so it lost the startup race every time.
  useRealtimeChannel(locFilter, 'leads', (supabase) => {
    const scoped = locFilter !== 'all'
    return supabase
      .channel(`leads:${scoped ? locFilter : 'all'}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'leads',
          ...(scoped ? { filter: `location_uuid=eq.${locFilter}` } : {}),
        },
        (payload: any) => {
          const leadId = (payload.new as any)?.id || (payload.old as any)?.id
          if (!leadId) return
          onChangeRef.current({
            type: payload.eventType as LeadsRealtimeEvent['type'],
            leadId,
          })
        }
      )
  })
}
