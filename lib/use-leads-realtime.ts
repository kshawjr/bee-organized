import { useEffect } from 'react'
import { createClient } from '@/lib/supabase'

export type LeadsRealtimeEvent = {
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  leadId: string
}

export function useLeadsRealtime(
  locationUuid: string | null | undefined,
  onChange: (event: LeadsRealtimeEvent) => void
) {
  useEffect(() => {
    if (!locationUuid) return

    const supabase = createClient()
    const channel = supabase
      .channel(`leads:${locationUuid}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'leads',
          filter: `location_uuid=eq.${locationUuid}`,
        },
        (payload) => {
          const leadId = (payload.new as any)?.id || (payload.old as any)?.id
          if (!leadId) return
          onChange({
            type: payload.eventType as LeadsRealtimeEvent['type'],
            leadId,
          })
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [locationUuid]) // onChange intentionally omitted — caller must stabilize with useCallback
}
