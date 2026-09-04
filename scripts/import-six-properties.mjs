// ═══════════════════════════════════════════════════════════════════════════
// THE SIX — import the extra Jobber properties for the six clients that have
// live work at an address Bee Hub never recorded.
//
// HELD. Kevin runs this. DRY-RUN BY DEFAULT: it prints exactly what it would
// write and writes nothing. Add --commit to apply.
//
// WHY SIX AND NOT 137. Two independent signals in our own data named these
// six, each meaning "Jobber has a property here that Bee Hub does not":
//
//   · four from the inbound webhook log — Jobber created a property and the
//     handler logged that it left it alone ("property=X is not lead Y's
//     linked property (Z) — left alone")
//   · three from address pushes that found MULTIPLE properties on the client
//     and deliberately skipped the service address rather than guess
//   · Tom Ballas appears in both, so: six distinct clients
//
// Separately there are 61 properties across 59 Jobber clients Bee Hub has no
// lead for at all. Those are NOT imported — they are not drift, they are
// clients we do not have, and inventing leads for them would put 59 records
// with no owner, no source and no consent into the worklist. Kevin's ruling.
//
// WHAT IT WRITES. One entry appended to leads.former_addresses per client,
// labelled 'other' with the note 'Found in Jobber', carrying the property id
// so the send-time picker can address it exactly. It NEVER touches the
// primary address, never touches jobber_property_id, and makes NO call to
// Jobber — every address here is read back from the property the webhook
// already told us about, or from the client's own Jobber property list at
// the time the push skipped it.
//
// Usage:
//   node scripts/import-six-properties.mjs                # dry run, prints the plan
//   node scripts/import-six-properties.mjs --commit       # apply
//   node scripts/import-six-properties.mjs --env <path>   # env file (default .env.local)
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const COMMIT = argv.includes('--commit')
const flagVal = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null }

const env = Object.fromEntries(
  readFileSync(flagVal('--env') || '.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('missing supabase env — run from repo root or pass --env <path>')
  process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// ─── THE SIX ───────────────────────────────────────────────────────────────
// lead_id is the identity. jobber_property_id is the EXTRA property (never
// the one the lead is already linked to). `address` is what that property is;
// where the drift was found via a push skip rather than a webhook, the
// address is the one the lead HELD before the owner corrected it, which is
// the address still sitting on the Jobber property.
//
// VERIFY BEFORE COMMITTING. The script re-reads each lead and refuses to act
// if anything has moved under it (see guards below).
const SIX = [
  {
    lead_id: '94a99aae-3e7f-46e6-ad1a-11c6a0e2df61', name: 'Andrea Fritz', location: 'loc_kc',
    jobber_property_id: '158116816', source: 'webhook PROPERTY_CREATE — left alone',
    street: '', city: '', state: '', zip: '', display: '',
  },
  {
    lead_id: '00a4e2a5-987f-4cda-9722-a6695facd610', name: 'Tom Ballas', location: 'loc_nwarkansas',
    jobber_property_id: '149372355', source: 'webhook + multi-property push skip',
    street: '3448 Oakland Zion Road', city: 'Fayetteville', state: 'Arkansas', zip: '72703',
    display: '3448 Oakland Zion Road, Fayetteville, Arkansas, 72703',
  },
  {
    lead_id: '79a02857-ab07-4017-beb8-a9aafccd97fb', name: 'Pam Merritt', location: 'loc_nwarkansas',
    jobber_property_id: '158270173', source: 'webhook PROPERTY_CREATE — left alone',
    street: '', city: '', state: '', zip: '', display: '',
  },
  {
    lead_id: '7f4fe7fd-143c-4c1d-9b0f-8126096d9de3', name: 'Alexis Boulos', location: 'loc_omaha',
    jobber_property_id: '151975439', source: 'webhook PROPERTY_CREATE — left alone',
    street: '', city: '', state: '', zip: '', display: '',
  },
  {
    lead_id: 'cba83b79-0dc2-4a99-9269-731013fe348d', name: 'Melanie Scott', location: 'loc_nwarkansas',
    jobber_property_id: null, source: 'multi-property push skip',
    street: '4631 East Bridgewater Lane', city: 'Fayetteville', state: 'Arkansas', zip: '72703',
    display: '4631 East Bridgewater Lane, Fayetteville, Arkansas, 72703',
  },
  {
    lead_id: 'dfae9283-23ef-40c4-a605-775e7d6a6e0f', name: 'Maggie Yost', location: 'loc_omaha',
    jobber_property_id: null, source: 'multi-property push skip',
    street: '15819 Lake Street', city: 'Omaha', state: 'Nebraska', zip: '68116',
    display: '15819 Lake Street, Omaha, Nebraska, 68116',
  },
]

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

// Four rows have a property id but no address — the webhook told us the
// property EXISTS without us recording what it is. Those are reported and
// SKIPPED rather than written blank: an address entry with no address is
// worse than the drift it was meant to fix. Filling them needs one read of
// Jobber's property(id) per client, which this script deliberately does not
// do (it makes no Jobber calls at all).
async function main() {
  console.log(COMMIT ? '── COMMIT ──' : '── DRY RUN (nothing will be written) ──')
  let planned = 0, skipped = 0, blocked = 0

  for (const row of SIX) {
    const { data: lead, error } = await sb
      .from('leads')
      .select('id, name, address, jobber_client_id, jobber_property_id, former_addresses')
      .eq('id', row.lead_id)
      .maybeSingle()

    if (error) { console.log(`  BLOCKED ${row.name}: ${error.message}`); blocked++; continue }
    if (!lead) { console.log(`  BLOCKED ${row.name}: lead not found`); blocked++; continue }

    if (!row.display) {
      console.log(`  SKIP    ${row.name} (${row.location}) — property ${row.jobber_property_id} known, address not recorded`)
      console.log(`          needs one read of Jobber property(${row.jobber_property_id}); this script makes no Jobber calls`)
      skipped++; continue
    }
    // Guard: never duplicate the lead's CURRENT address.
    if (norm(lead.address) === norm(row.display)) {
      console.log(`  SKIP    ${row.name} — that is already the lead's primary address`)
      skipped++; continue
    }
    const list = Array.isArray(lead.former_addresses) ? lead.former_addresses : []
    if (list.some(e => norm(e?.display) === norm(row.display))) {
      console.log(`  SKIP    ${row.name} — already on the client`)
      skipped++; continue
    }

    const entry = {
      street: row.street, city: row.city, state: row.state, zip: row.zip,
      display: row.display,
      jobber_property_id: row.jobber_property_id ? String(row.jobber_property_id) : null,
      moved_at: new Date().toISOString(),
      added_at: new Date().toISOString(),
      label: 'other',
      label_note: 'Found in Jobber',
      status: 'active',
    }

    console.log(`  ADD     ${row.name} (${row.location})`)
    console.log(`          + ${entry.display}`)
    console.log(`          property=${entry.jobber_property_id ?? '(none recorded)'} · ${row.source}`)
    console.log(`          primary stays: ${lead.address}`)
    planned++

    if (COMMIT) {
      const { error: upErr } = await sb
        .from('leads')
        .update({ former_addresses: [...list, entry], updated_at: new Date().toISOString() })
        .eq('id', row.lead_id)
      if (upErr) { console.log(`          WRITE FAILED: ${upErr.message}`); blocked++; planned-- }
      else console.log('          written')
    }
  }

  console.log('')
  console.log(`  ${COMMIT ? 'written' : 'would write'}: ${planned}   skipped: ${skipped}   blocked: ${blocked}`)
  if (!COMMIT) console.log('  re-run with --commit to apply')
  if (skipped) console.log('  the skipped rows are not lost — they are listed above with their property ids')
}

main().catch(e => { console.error(e); process.exit(1) })
