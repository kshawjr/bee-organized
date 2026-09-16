// lib/use-engagements-realtime.ts
// ─────────────────────────────────────────────────────────────
// Supabase Realtime for the engagement board: pushes stage moves that happen
// with no client event — another user's close, a Jobber webhook's
// maybeAdvanceEngagementStage, an import derivation, MAKE — into the open
// board without a reload.
//
// SIGNAL ONLY. The postgres_changes payload is one flat engagements row with
// none of the board enrichment (no client_name, no repeat_count, no child
// arrays), so handing payload.new to the reconcile would churn boardSignature
// and blank the card. Callers take the id and refetch in board shape
// (/api/engagements?ids=), exactly as handleLeadsRealtime does for leads.
//
// UPDATE only, deliberately: reconcileServerRows drops rows absent from
// baseById, so an INSERT would be swallowed anyway — new-engagement-appears
// is its own build. DELETE needs REPLICA IDENTITY FULL to carry an id.
// ─────────────────────────────────────────────────────────────
import { useRef } from 'react'
import { useRealtimeChannel } from '@/lib/use-realtime-channel'

export type EngagementRealtimeEvent = {
  engagementId: string
}

// locFilter carries the board's location vocabulary: a location uuid, or
// 'all' for super_admin/corporate.
export function useEngagementsRealtime(
  locFilter: string | null | undefined,
  onChange: (event: EngagementRealtimeEvent) => void
) {
  // Latest-ref: the board's handler closes over engagements/sessionEngagements
  // and so changes identity on most renders. Reading it through a ref keeps
  // the effect keyed on locFilter ALONE — resubscribing per render would
  // thrash the websocket — while never invoking a stale closure (which would
  // reconcile against a stale baseById and silently drop the move). This is
  // why the hook does not inherit use-leads-realtime's "caller must stabilize
  // with useCallback" contract.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Scope: filter server-side when the board is pinned to one location.
  // When locFilter is 'all' (super_admin/corporate) we subscribe UNFILTERED
  // and let RLS scope delivery rather than opening a channel per visible
  // location: the engagements SELECT policy already admits admins to every
  // row and fences everyone else to location_uuid = their own, so RLS
  // produces exactly the 'all' set for the people who can hold 'all'. A
  // single-location filter here would be plain wrong, and a channel fan-out
  // would duplicate a guarantee the database already makes.
  const scoped = !!locFilter && locFilter !== 'all'

  // Opened through use-realtime-channel so the access token is attached
  // BEFORE the join — see that file: a channel that joins anonymously is
  // accepted, reports SUBSCRIBED, and then delivers nothing.
  //
  // `locFilter ?? 'all'` is deliberate and is NOT the same guard the other
  // hooks use. This hook has never had an `if (!locFilter) return`: a board
  // with no location vocabulary yet still subscribes, unfiltered, and leans
  // on RLS. Passing the bare locFilter would newly make that case subscribe
  // to nothing — a silent behaviour change to the board. `scoped` above is
  // still computed from the REAL locFilter, so the filter itself is unchanged.
  useRealtimeChannel(locFilter ?? 'all', 'engagements', (supabase) =>
    supabase
      .channel(`engagements:${scoped ? locFilter : 'all'}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'engagements',
          ...(scoped ? { filter: `location_uuid=eq.${locFilter}` } : {}),
        },
        (payload: any) => {
          const engagementId = (payload.new as any)?.id
          if (!engagementId) return
          onChangeRef.current({ engagementId })
        }
      )
  )
}
