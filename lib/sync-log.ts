import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function writeSyncLog({
  location_id,
  entity_id,
  entity_type = 'client',
  direction = 'inbound',
  zoho_record_id,
  jobber_record_id,
  status,
  message,
}: {
  location_id:      string
  entity_id:        string
  entity_type?:     'client' | 'request' | 'quote' | 'job' | 'invoice' | 'payment' | 'note' | 'location' | 'property' | 'assessment' | 'engagement'
  direction?:       'inbound' | 'outbound'
  zoho_record_id?:  string
  jobber_record_id?: string
  status:           'success' | 'error'
  message:          string
}) {
  try {
    await supabase.from('sync_log').insert({
      location_id,
      direction,
      entity_type,
      entity_id,
      zoho_record_id:  zoho_record_id  || null,
      jobber_record_id: jobber_record_id || null,
      status,
      message,
    })
  } catch (err) {
    console.error('Failed to write sync log:', err)
  }
}