// lib/zoho.ts
// ─────────────────────────────────────────────────────────────
// Zoho CRM API client. Handles token caching and common queries.
// getZohoToken() is exported so lib/jobber.ts can use it when
// writing refreshed Jobber tokens back to Zoho.
// ─────────────────────────────────────────────────────────────

const ZOHO_API_BASE = process.env.ZOHO_API_BASE!

let cachedToken: string | null = null
let tokenExpiry = 0

export async function getZohoToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken

  const res = await fetch(
    `https://accounts.zoho.com/oauth/v2/token?grant_type=refresh_token` +
    `&client_id=${process.env.ZOHO_CLIENT_ID}` +
    `&client_secret=${process.env.ZOHO_CLIENT_SECRET}` +
    `&refresh_token=${process.env.ZOHO_REFRESH_TOKEN}`,
    { method: 'POST', cache: 'no-store' }
  )
  const data = await res.json()
  if (!data.access_token) throw new Error('Failed to get Zoho token: ' + JSON.stringify(data))

  cachedToken = data.access_token
  tokenExpiry = Date.now() + 55 * 60 * 1000 // 55 min (token lasts 60)
  return cachedToken!
}

// Zoho signals failure two ways: an HTTP status, and a status:'error' body.
// Only the second was ever checked, so a 401/429/500 whose body carries no
// status:'error' read as an empty-but-successful response. Check the status
// first. 204 is NOT a failure — it is Zoho's genuine "no records".
async function assertZohoOk(res: Response, what: string) {
  if (res.ok) return
  const body = await res.text().catch(() => '')
  throw new Error(
    `${what} failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
  )
}

export async function zohoGet(path: string) {
  const token = await getZohoToken()
  const res = await fetch(`${ZOHO_API_BASE}/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: 'no-store',
  })
  await assertZohoOk(res, `Zoho GET ${path.split('?')[0]}`)
  // 204 = no records matched; body is empty and JSON.parse would throw.
  if (res.status === 204) return {}
  return res.json()
}

export async function zohoUpdate(module: string, id: string, data: object) {
  const token = await getZohoToken()
  const res = await fetch(`${ZOHO_API_BASE}/${module}`, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [{ id, ...data }] }),
    cache: 'no-store',
  })
  return res.json()
}

const LOCATION_FIELDS = [
  'Name', 'Location_ID', 'Email', 'Phone_Number', 'Time_Zone', 'CRM_Status',
  'Jobber_Account_ID', 'Jobber_Access_Token', 'Jobber_Refresh_Token',
  'Jobber_Client_ID_App', 'Jobber_Secret_App', 'Token_Expiry', 'Token_Expiry_Display',
  'Last_Sync_Status', 'Group_Email', 'Configure_Location_to_Jobber',
  'Booking_Link', 'Google_Reviews', 'Jobber_URL', 'Website', 'FAQ_Doc',
  'Group_ID', 'Owner',
].join(',')

export async function getZohoLocations() {
  const data = await zohoGet(`Locations?fields=${LOCATION_FIELDS}&per_page=200`)
  return data.data || []
}

export async function getZohoLocation(locationId: string) {
  const data = await zohoGet(
    `Locations/search?criteria=(Location_ID:equals:${locationId})&fields=${LOCATION_FIELDS}`
  )
  return data.data?.[0] || null
}

// ─── Location notification contacts ───────────────────────────────
// The individual people a location's lead notifications fan out to today
// live in Zoho as the Location's related CONTACTS (each an internal
// @beeorganized.com staff record, Contact_Type "Zee Bee"/"Team Member").
// This is the Zoho-side equivalent of B1's in-interface recipients, used
// for the ~non-interface locations that have no hub_users. `locationSlug`
// is the Zoho Location_ID (e.g. 'loc_seattle').
//
// Throws on any API failure so callers can FAIL LOUD — a location must
// never silently resolve to zero recipients because of a swallowed error.
// A genuinely empty related list (HTTP 204) resolves to [] (not an error).
// Successful reads are cached briefly (correctness over caching: a short
// TTL, and on a transient failure we serve the last good list rather than
// drop a real recipient).

export type ZohoNotificationContact = {
  name: string
  email: string
  opted_out: boolean
  // First/Last are ALREADY inside NOTIF_CONTACT_FIELDS below — the mapping just
  // used to collapse them into `name` and drop them. Surfaced verbatim (no
  // extra API cost, no widened selection) so the seed can write
  // lead_notification_externals.first_name/last_name without splitting a full
  // name on whitespace. Null when Zoho carries only a Full_Name.
  first_name: string | null
  last_name: string | null
}

const NOTIF_CONTACT_FIELDS = 'Full_Name,First_Name,Last_Name,Email,Email_Opt_Out'
const notifContactsCache = new Map<
  string,
  { at: number; contacts: ZohoNotificationContact[] }
>()
const NOTIF_CONTACTS_TTL_MS = 5 * 60 * 1000 // 5 min

export async function getZohoLocationNotificationContacts(
  locationSlug: string,
): Promise<ZohoNotificationContact[]> {
  const cached = notifContactsCache.get(locationSlug)
  if (cached && Date.now() - cached.at < NOTIF_CONTACTS_TTL_MS) return cached.contacts

  try {
    const loc = await getZohoLocation(locationSlug)
    if (!loc?.id) {
      throw new Error(`no Zoho Location for Location_ID=${locationSlug}`)
    }

    const token = await getZohoToken()
    const res = await fetch(
      `${ZOHO_API_BASE}/Locations/${loc.id}/Contacts?fields=${NOTIF_CONTACT_FIELDS}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` }, cache: 'no-store' },
    )

    // 204 (or any empty body) = the location genuinely has no related contacts.
    if (res.status === 204) {
      notifContactsCache.set(locationSlug, { at: Date.now(), contacts: [] })
      return []
    }

    await assertZohoOk(res, `Zoho Contacts read for ${locationSlug}`)

    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    if (data.status === 'error') {
      throw new Error(`Zoho Contacts read failed: ${data.code || data.message}`)
    }

    const seen = new Set<string>()
    const contacts: ZohoNotificationContact[] = []
    for (const c of data.data || []) {
      const email = typeof c.Email === 'string' ? c.Email.trim() : ''
      if (!email) continue
      const key = email.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const name =
        (c.Full_Name && c.Full_Name !== email && String(c.Full_Name).trim()) ||
        [c.First_Name, c.Last_Name].filter(Boolean).join(' ').trim() ||
        email
      const trimmed = (v: unknown) =>
        typeof v === 'string' && v.trim() ? v.trim() : null
      contacts.push({
        name,
        email,
        opted_out: c.Email_Opt_Out === true,
        first_name: trimmed(c.First_Name),
        last_name: trimmed(c.Last_Name),
      })
    }

    notifContactsCache.set(locationSlug, { at: Date.now(), contacts })
    return contacts
  } catch (err: any) {
    // Serve the last good list rather than drop real recipients on a
    // transient failure — but make it visible.
    const stale = notifContactsCache.get(locationSlug)
    if (stale) {
      console.error(
        `[zoho] notification-contacts fetch failed for ${locationSlug}; serving cached list (${stale.contacts.length}): ${err?.message}`,
      )
      return stale.contacts
    }
    throw err
  }
}