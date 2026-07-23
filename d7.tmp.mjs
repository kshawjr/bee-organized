import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}})
for (let i=0;i<4;i++){
  const { data } = await sb.from('import_jobs').select('status,phase,processed_records,total_records,location_claim_at,error_message').eq('location_id','loc_kc').eq('type','jobber_clients').order('started_at',{ascending:false}).limit(1)
  const r = data?.[0]; if(!r){console.log('read null, retry');}
  else console.log(`[${new Date().toISOString()}] ${r.status} ${r.processed_records}/${r.total_records} claim=${r.location_claim_at??'NULL'} "${r.phase}"`)
  await new Promise(s=>setTimeout(s,40000))
}
const { data: l } = await sb.from('sync_log').select('created_at,status,message').eq('entity_type','location').order('created_at',{ascending:false}).limit(6)
for (const x of l||[]) console.log(x.created_at, x.status, String(x.message).replace('[continuation] ','').slice(0,110))
