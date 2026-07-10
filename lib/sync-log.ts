import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy-init: modules that import a writeSyncLog caller (e.g.
// jobber-import.ts) must stay loadable without Supabase env — the client
// is only constructed on first write, inside writeSyncLog's try/catch,
// preserving its never-throw contract.
let client: SupabaseClient | null = null
const supabaseClient = () =>
  (client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  ))

export type SyncLogLandedStatus = 'landed' | 'not_landed' | 'na'

export async function writeSyncLog({
  location_id,
  entity_id,
  entity_type = 'client',
  direction = 'inbound',
  zoho_record_id,
  jobber_record_id,
  status,
  message,
  landed_status,
}: {
  // null = event that can't be scoped to a location (unknown Jobber
  // account, unparseable-but-signature-valid payload). Requires the
  // sync_log_landed_status.sql migration (location_id DROP NOT NULL).
  location_id:      string | null
  entity_id:        string
  entity_type?:     'client' | 'request' | 'quote' | 'job' | 'invoice' | 'payment' | 'note' | 'location' | 'property' | 'assessment' | 'engagement'
  direction?:       'inbound' | 'outbound'
  zoho_record_id?:  string
  jobber_record_id?: string
  status:           'success' | 'error'
  message:          string
  // Webhook rows only — recorded outcome of the landed check
  // (lib/webhook-landed.ts). Omitted entirely for non-webhook callers
  // so this module keeps working against a pre-migration schema.
  landed_status?:   SyncLogLandedStatus
}) {
  try {
    // supabase-js does not throw on insert failure — it resolves with
    // { error }. Check it, or a rejected row (constraint, missing
    // column pre-migration) vanishes without a trace.
    const { error } = await supabaseClient().from('sync_log').insert({
      location_id,
      direction,
      entity_type,
      entity_id,
      zoho_record_id:  zoho_record_id  || null,
      jobber_record_id: jobber_record_id || null,
      status,
      message,
      ...(landed_status !== undefined ? { landed_status } : {}),
    })
    if (error) console.error('Failed to write sync log:', error.message)
  } catch (err) {
    console.error('Failed to write sync log:', err)
  }
}
