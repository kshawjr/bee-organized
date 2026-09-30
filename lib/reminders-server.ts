// lib/reminders-server.ts
// Server-only helpers for /api/reminders (they need the service-role client,
// so they live apart from the pure lib/reminders.ts the browser also loads).
import { supabaseService } from '@/lib/supabase-service'
import type { ReminderRecord } from '@/lib/reminders'

export const REMINDER_COLS =
  'id, user_id, location_uuid, lead_id, engagement_id, partner_id, due_on, note, done_at, created_at, updated_at'

// The record a reminder points at → its location (for the access check).
// null when the record doesn't exist (or is a deleted Network person).
export async function loadRecordLocation(record: ReminderRecord): Promise<string | null> {
  if (record.key === 'lead_id') {
    const { data } = await supabaseService.from('leads').select('id, location_uuid').eq('id', record.id).maybeSingle()
    return (data as any)?.location_uuid ?? null
  }
  if (record.key === 'engagement_id') {
    const { data } = await supabaseService.from('engagements').select('id, location_uuid').eq('id', record.id).maybeSingle()
    return (data as any)?.location_uuid ?? null
  }
  const { data } = await supabaseService.from('partners').select('id, location_id, deleted_at').eq('id', record.id).maybeSingle()
  if (!data || (data as any).deleted_at) return null
  return (data as any).location_id ?? null
}

// Attach what the list needs to say WHO a reminder is about:
//   record_type  'client' | 'engagement' | 'network'
//   record_name  the person's name (an engagement reads "<client> · <title>")
//   client_id    for an engagement, the client whose card it opens under
// Reminders whose record has gone (deleted Network person) are dropped.
export async function withRecordNames(rows: any[]) {
  const ids = (k: string) => Array.from(new Set(rows.map(r => r[k]).filter(Boolean)))
  const leadIds = ids('lead_id')
  const engIds = ids('engagement_id')
  const partnerIds = ids('partner_id')

  const engs: any[] = engIds.length
    ? ((await supabaseService.from('engagements').select('id, client_id, title').in('id', engIds)).data || [])
    : []
  const allLeadIds = Array.from(new Set([...leadIds, ...engs.map(e => e.client_id).filter(Boolean)]))
  const leads: any[] = allLeadIds.length
    ? ((await supabaseService.from('leads').select('id, name').in('id', allLeadIds)).data || [])
    : []
  const partners: any[] = partnerIds.length
    ? ((await supabaseService.from('partners').select('id, name, deleted_at').in('id', partnerIds)).data || [])
    : []

  const leadName = new Map(leads.map(l => [l.id, l.name || 'Unnamed client']))
  const engById = new Map(engs.map(e => [e.id, e]))
  const partnerById = new Map(partners.map(p => [p.id, p]))

  const out: any[] = []
  for (const r of rows) {
    if (r.lead_id) {
      out.push({ ...r, record_type: 'client', record_name: leadName.get(r.lead_id) || 'Unnamed client', client_id: r.lead_id })
    } else if (r.engagement_id) {
      const e = engById.get(r.engagement_id)
      const who = (e && leadName.get(e.client_id)) || 'Unnamed client'
      out.push({ ...r, record_type: 'engagement', record_name: e?.title ? `${who} · ${e.title}` : who, client_id: e?.client_id ?? null })
    } else if (r.partner_id) {
      const p = partnerById.get(r.partner_id)
      if (!p || p.deleted_at) continue
      out.push({ ...r, record_type: 'network', record_name: p.name || 'Unnamed', client_id: null })
    }
  }
  return out
}
