// scripts/mailchimp-webhook-setup.mts
//
// FL-131: sets up Mailchimp's "someone joined" notification on ONE list —
// Test Location's — pointing at Bee Hub's live address. Kevin runs it, after
// the code is live (Mailchimp checks the address answers when it is set up).
//
//   node scripts/mailchimp-webhook-setup.mts           # look only: says what it would do
//   node scripts/mailchimp-webhook-setup.mts --yes     # sets it up
//
// Refuses every location but the ones lib/mailchimp-rollout.ts opens (today:
// Test Location). Refuses if this list already has a notification to Bee Hub.
// Reads Mailchimp's token from the location's row at run time and never
// prints it, or the key in the address.
//
// Asks Mailchimp for "subscribe" only, from every kind of add: the person
// themselves (a form), someone in the Mailchimp app, and another program.

import { readFileSync } from 'node:fs'
import { MAILCHIMP_OPEN_LOCATIONS } from '../lib/mailchimp-rollout.ts'
import { mailchimpWebhookUrl } from '../lib/mailchimp-webhook-key.ts'

const ORIGIN = 'https://beehive.beeorganized.com'
const YES = process.argv.includes('--yes')

const env: Record<string, string> = {}
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL, SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SB_URL || !SB_KEY) { console.error('No database settings in .env.local. Nothing done.'); process.exit(1) }

const ids = Object.keys(MAILCHIMP_OPEN_LOCATIONS)
if (ids.length !== 1) { console.error(`Expected exactly one open location, found ${ids.length}. Nothing done.`); process.exit(1) }
const LOC = ids[0]

const r = await fetch(`${SB_URL}/rest/v1/locations?id=eq.${LOC}&select=id,name,mailchimp_connected,mailchimp_list_id,mailchimp_list_name,mailchimp_access_token,mailchimp_server_prefix`, {
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
})
const [loc] = await r.json() as any[]
if (!loc) { console.error('Location not found. Nothing done.'); process.exit(1) }
if (loc.name !== MAILCHIMP_OPEN_LOCATIONS[LOC]) { console.error(`That id is "${loc.name}", not "${MAILCHIMP_OPEN_LOCATIONS[LOC]}". Nothing done.`); process.exit(1) }
if (!loc.mailchimp_connected || !loc.mailchimp_list_id || !loc.mailchimp_access_token || !loc.mailchimp_server_prefix) {
  console.error(`${loc.name} is not connected to a Mailchimp list. Nothing done.`); process.exit(1)
}
const token: string = loc.mailchimp_access_token
const hide = (s: string) => s.split(token).join('[token]').replace(/([?&]k=)[0-9a-f]+/g, '$1[key]')

const url = mailchimpWebhookUrl(ORIGIN, token, LOC)
if (!url) { console.error('Could not make the address. Nothing done.'); process.exit(1) }
const base = `https://${loc.mailchimp_server_prefix}.api.mailchimp.com/3.0/lists/${loc.mailchimp_list_id}/webhooks`
const auth = { Authorization: `Bearer ${token}` }

const listed = await fetch(base, { headers: auth })
const lj: any = await listed.json().catch(() => ({}))
if (listed.status !== 200) { console.error(hide(`Mailchimp answered ${listed.status} reading the notifications. Nothing done.`)); process.exit(1) }
const hooks: any[] = Array.isArray(lj.webhooks) ? lj.webhooks : []
const ours = hooks.filter((h) => String(h.url || '').startsWith(`${ORIGIN}/api/mailchimp/webhook`))

console.log(`Location:  ${loc.name}`)
console.log(`List:      ${loc.mailchimp_list_name || loc.mailchimp_list_id}`)
console.log(`Notifications already on this list: ${hooks.length} (to Bee Hub: ${ours.length})`)
console.log(`Would set up: ${hide(url)}`)
console.log('  events:  subscribe only')
console.log('  from:    the person (forms), someone in the Mailchimp app, another program')

if (ours.length) { console.log('\nThis list already notifies Bee Hub. Nothing done.'); process.exit(0) }
if (!YES) { console.log('\nLook only. Nothing was changed. Run again with --yes to set it up.'); process.exit(0) }

const made = await fetch(base, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url,
    events: { subscribe: true, unsubscribe: false, profile: false, cleaned: false, upemail: false, campaign: false },
    sources: { user: true, admin: true, api: true },
  }),
})
const mj: any = await made.json().catch(() => ({}))
if (made.status !== 200) { console.error(hide(`Mailchimp refused (${made.status}): ${mj.detail || mj.title || ''}`)); process.exit(1) }
console.log(`\nSet up. Mailchimp's id for it: ${mj.id}`)
