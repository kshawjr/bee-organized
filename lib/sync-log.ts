import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function writeSyncLog({
  location_id,
  entity_id,
  zoho_record_id,
  jobber_record_id,
  status,
  message,
}: {
  location_id: string
  entity_id: string
  zoho_record_id?: string
  jobber_record_id?: string
  status: 'success' | 'error'
  message: string
}) {
  try {
    await supabase.from('sync_log').insert({
      location_id,
      direction: 'inbound',
      entity_type: 'client',
      entity_id,
      zoho_record_id: zoho_record_id || null,
      jobber_record_id: jobber_record_id || null,
      status,
      message,
    })
  } catch (err) {
    console.error('Failed to write sync log:', err)
  }
}