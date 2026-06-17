// app/_hub-page.tsx
//
// Shared server component for all top-level Hub routes.
// Loads auth, user profile, locations, seats, leads, lookups, etc.,
// then renders <BeeHub> with the right initialRoute and optionally a
// pre-selected lead id (for /clients/[id] deep links).
//
// Used by: /, /clients, /clients/[id], /contacts, /hive, /reports,
// /settings, /admin. Each route just calls <HubPage initialRoute="..." />.

import { redirect } from 'next/navigation'
import { requireAuth, getHubUser } from '@/lib/auth'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { PARTNER_COLS, COMPANY_COLS, mapPartnerRow, mapCompanyRow } from '@/lib/crm'
import BeeHub from '@/components/BeeHub'

function mapRole(dbRole: string | null | undefined): {
  role: string
  franchiseRole: string
} {
  switch (dbRole) {
    case 'super_admin':
      return { role: 'super_admin', franchiseRole: 'owner' }
    case 'admin':
      return { role: 'corporate', franchiseRole: 'owner' }
    case 'owner':
      return { role: 'franchise', franchiseRole: 'owner' }
    case 'lite_user':
      return { role: 'franchise', franchiseRole: 'viewer' }
    default:
      return { role: 'franchise', franchiseRole: 'owner' }
  }
}

function fmtJoined(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${months[d.getMonth()]} ${d.getFullYear()}`
  } catch {
    return ''
  }
}

function initialsFrom(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function mapTier(dbRole: string | null | undefined): string {
  switch (dbRole) {
    case 'super_admin':
      return 'corporate'
    case 'admin':
      return 'manager'
    case 'owner':
      return 'owner'
    case 'lite_user':
      return 'readonly'
    default:
      return 'readonly'
  }
}

function buildLocationUser(row: any) {
  const name = row.full_name || row.email
  return {
    id: row.id,
    name,
    initials: initialsFrom(name),
    email: row.email,
    locationId: row.location_id,
    role: row.location_id ? mapTier(row.role) : 'corporate',
    displayCategory:
      row.location_id ? 'franchise' :
      row.role === 'super_admin' ? 'development' :
      'corporate',
    status: 'active',
    joined: fmtJoined(row.created_at),
    // jobber_user_id gates assignment to Jobber jobs/assessments. Null
    // means the user is hidden from the assignment multi-select; the
    // owner can manually link from Settings → Team.
    jobberUserId: row.jobber_user_id || null,
  }
}

export default async function HubPage({
  initialRoute,
  initialSelectedLeadId,
  notFoundToast = false,
}: {
  initialRoute?: string
  initialSelectedLeadId?: string
  notFoundToast?: boolean
} = {}) {
  const authUser = await requireAuth()
  const hubUser = await getHubUser()

  if (!hubUser) {
    return (
      <div
        style={{
          padding: '4rem 1.25rem',
          textAlign: 'center',
          fontFamily: '"DM Sans", system-ui, sans-serif',
          maxWidth: '480px',
          margin: '0 auto',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>🐝</div>
        <h1
          style={{
            fontFamily: 'Georgia, serif',
            color: '#1a2e2b',
            fontSize: '24px',
            marginBottom: '12px',
          }}
        >
          Account not set up yet
        </h1>
        <p style={{ color: '#4a5e5a', fontSize: '14px', lineHeight: 1.6 }}>
          You&apos;re signed in as <strong>{authUser.email}</strong> but
          don&apos;t have a Bee Hub profile yet. Reach out to your franchise
          admin to be added to your location.
        </p>
      </div>
    )
  }

  const { role, franchiseRole } = mapRole(hubUser.role)
  const isElevated = role === 'super_admin' || role === 'corporate'
  const initialLocFilter = isElevated ? 'all' : hubUser.location_id || 'all'

  const supabase = await createServerSupabaseClient()

  let profileFields: { first_name: string | null; last_name: string | null; phone: string | null } = {
    first_name: null,
    last_name: null,
    phone: null,
  }
  {
    const { data: profileRow } = await supabaseService
      .from('hub_users')
      .select('first_name, last_name, phone')
      .eq('id', hubUser.id)
      .maybeSingle()
    if (profileRow) profileFields = profileRow as any
  }

  // Order by slot only. The editor writes `slot` as a single global sequence
  // (array index across all chapters), so slot alone reflects the user's
  // arranged order. Sorting by chapter first would force chapters into
  // alphabetical order on reload and discard manual reordering.
  const { data: slidesData } = await supabase
    .from('guide_slides')
    .select('*')
    .order('slot', { ascending: true })

  const initialGuideSlides = (slidesData || []).map((row: any) => {
    let screenshots: string[] = []
    if (Array.isArray(row.screenshots) && row.screenshots.length > 0) {
      screenshots = row.screenshots
    } else if (row.screenshot_url) {
      screenshots = [row.screenshot_url]
    }
    return {
      icon: row.icon,
      chapter: row.chapter,
      color: row.color,
      title: row.title,
      body: row.body || '',
      bullets: row.bullets || [],
      screenshot: screenshots[0] || null,
      screenshots,
    }
  })

  const { data: tierPricesRaw } = await supabaseService
    .from('tier_prices')
    .select('id, display_name, price_annual, description, sort_order, updated_at')
    .order('sort_order', { ascending: true })

  const initialTierPrices = tierPricesRaw || []

  // Order by slot only — same global-sequence reasoning as guide_slides above.
  const { data: manualSlidesRaw } = await supabaseService
    .from('manual_slides')
    .select('*')
    .order('slot', { ascending: true })

  const initialManualSlides = (manualSlidesRaw || []).map((row: any) => {
    let screenshots: string[] = []
    if (Array.isArray(row.screenshots) && row.screenshots.length > 0) {
      screenshots = row.screenshots
    } else if (row.screenshot_url) {
      screenshots = [row.screenshot_url]
    }
    return {
      icon: row.icon,
      chapter: row.chapter,
      color: row.color,
      title: row.title,
      body: row.body || '',
      bullets: row.bullets || [],
      screenshot: screenshots[0] || null,
      screenshots,
      video_url: row.video_url || null,
    }
  })

  let currentSubscription: any = null
  let currentLocation: any = null
  if (hubUser.location_id) {
    const { data: locRow, error: subErr } = await supabase
      .from('locations')
      .select(
        'id, name, subscription_status, subscription_plan, payment_source, paid_through_date, deferred_until, billing_notes, jobber_account_id, jobber_account_name, jobber_initial_import_completed_at, jobber_team_roster, jobber_team_roster_synced_at, last_sync_status, token_expiry, onboarding_state, default_drip_path, default_move_drip_path, address, city, state, zip, phone, email, timezone, sender_name, send_from_email, reply_to_email, reviews_link, calendar_link, activated_at, lifecycle_status'
      )
      .eq('id', hubUser.location_id)
      .single()

    if (subErr) console.error('[hub-page] currentSubscription error:', subErr.message)

    if (locRow) {
      currentSubscription = {
        subscription_status: locRow.subscription_status || 'deferred',
        subscription_plan: locRow.subscription_plan || null,
        payment_source: locRow.payment_source || 'none',
        paid_through_date: locRow.paid_through_date || null,
        deferred_until: locRow.deferred_until || null,
        billing_notes: locRow.billing_notes || null,
      }
      currentLocation = {
        id: locRow.id,
        name: locRow.name,
        jobber_connected: !!locRow.jobber_account_id,
        jobber_account_id: locRow.jobber_account_id || null,
        jobber_account_name: locRow.jobber_account_name || null,
        jobber_initial_import_completed_at: locRow.jobber_initial_import_completed_at || null,
        jobber_team_roster: Array.isArray(locRow.jobber_team_roster) ? locRow.jobber_team_roster : [],
        jobber_team_roster_synced_at: locRow.jobber_team_roster_synced_at || null,
        last_sync_status: locRow.last_sync_status || null,
        token_expiry: locRow.token_expiry || null,
        payment_source: locRow.payment_source || 'none',
        subscription_status: locRow.subscription_status || 'deferred',
        subscription_plan: locRow.subscription_plan || null,
        paid_through_date: locRow.paid_through_date || null,
        lifecycle_status: locRow.lifecycle_status || 'onboarding',
        onboarding_state: locRow.onboarding_state || {},
        default_drip_path: locRow.default_drip_path || null,
        default_move_drip_path: locRow.default_move_drip_path || null,
        address: locRow.address || '',
        city: locRow.city || '',
        state: locRow.state || '',
        zip: locRow.zip || '',
        phone: locRow.phone || '',
        email: locRow.email || '',
        timezone: locRow.timezone || '',
        sender_name: locRow.sender_name || '',
        send_from_email: locRow.send_from_email || '',
        reply_to_email: locRow.reply_to_email || '',
        reviews_link: locRow.reviews_link || '',
        calendar_link: locRow.calendar_link || '',
        activated_at: locRow.activated_at || null,
      }
    }
  }

  let initialSeats: any[] = []
  let initialPendingInvites: any[] = []
  if (currentLocation?.id) {
    const { data: seatsRaw, error: seatsErr } = await supabaseService
      .from('subscription_seats')
      .select(
        'id, location_id, tier, user_id, status, added_at, removed_at, prorated_cost, added_by, notes'
      )
      .eq('location_id', currentLocation.id)
      .eq('status', 'active')
      .order('added_at', { ascending: true })

    if (seatsErr) console.error('[hub-page] seats fetch error:', seatsErr.message)
    initialSeats = seatsRaw || []

    const { data: pendingRaw, error: pendingErr } = await supabaseService
      .from('pending_invites')
      .select('id, location_id, email, full_name, role, tier, invite_expires_at, accepted_at, created_at')
      .eq('location_id', currentLocation.id)
      .is('accepted_at', null)
      .order('created_at', { ascending: true })

    if (pendingErr) console.error('[hub-page] pending_invites fetch error:', pendingErr.message)
    initialPendingInvites = pendingRaw || []
  }

  let initialLocations: any[] | null = null
  let initialUsers: any[] | null = null
  if (isElevated) {
    const { data: locs, error: locsErr } = await supabaseService
      .from('locations')
      .select(
        'id, name, state, lifecycle_status, subscription_status, subscription_plan, payment_source, paid_through_date, billing_notes, jobber_account_id, last_sync_status, created_at, onboarding_state, default_drip_path, default_move_drip_path, activated_at'
      )
      .order('name', { ascending: true })

    if (locsErr) {
      console.error('[hub-page] locations fetch error:', locsErr.message)
    } else {
      console.log(`[hub-page] Fetched ${locs?.length ?? 0} locations for ${hubUser.email}`)
    }

    const { data: allUsers, error: usersErr } = await supabaseService
      .from('hub_users')
      .select('id, full_name, email, location_id, role, created_at, jobber_user_id')
      .order('full_name', { ascending: true })
      .limit(500)

    if (usersErr) console.error('[hub-page] hub_users fetch error:', usersErr.message)

    const ownersByLoc: Record<string, { name: string; userCount: number }> = {}
    const userCountByLoc: Record<string, number> = {}
    ;(allUsers || []).forEach((u: any) => {
      if (!u.location_id) return
      userCountByLoc[u.location_id] = (userCountByLoc[u.location_id] || 0) + 1
      if (u.role === 'owner' && !ownersByLoc[u.location_id]) {
        ownersByLoc[u.location_id] = {
          name: u.full_name || u.email,
          userCount: 0,
        }
      }
    })

    initialUsers = (allUsers || []).map(buildLocationUser)

    initialLocations = (locs || []).map((row: any) => {
      const lifecycle = row.lifecycle_status || 'onboarding'
      const subStatus = row.subscription_status || 'deferred'
      // lifecycle_status drives onboarding vs active; subscription_status only
      // overrides for billing UI (past_due, inactive) once the location is
      // past launch. Corp-sponsored locations stay subscription_status=
      // 'deferred' through their sponsorship window (March 2027) and must
      // still register as 'active' once lifecycle_status flips.
      const crmStatus =
        lifecycle === 'onboarding'            ? 'onboarding'
        : subStatus === 'past_due'            ? 'pastdue'
        : lifecycle === 'paused'              ? 'inactive'
        : subStatus === 'inactive'            ? 'inactive'
        :                                       'active'

      return {
        id: row.id,
        name: row.name,
        state: row.state || '',
        owner: ownersByLoc[row.id]?.name || null,
        crmStatus,
        lifecycle_status: lifecycle,
        subscription_status: subStatus,
        subscription_plan: row.subscription_plan || null,
        payment_source: row.payment_source || 'none',
        paid_through_date: row.paid_through_date || null,
        billing_notes: row.billing_notes || null,
        phone: '',
        website: '',
        reviewsLink: '',
        bookingLink: '',
        email: '',
        timezone: '',
        path: '',
        jobberConnected: !!row.jobber_account_id,
        jobberAccountId: row.jobber_account_id || null,
        last_sync_status: row.last_sync_status || null,
        leads: 0,
        revenue: 0,
        collected: 0,
        userCount: userCountByLoc[row.id] || 0,
        joinedDate: fmtJoined(row.created_at),
        onboarding_state: row.onboarding_state || {},
        default_drip_path: row.default_drip_path || null,
        default_move_drip_path: row.default_move_drip_path || null,
        activated_at: row.activated_at || null,
      }
    })
  } else if (hubUser.location_id) {
    const { data: locUsers, error: locUsersErr } = await supabase
      .from('hub_users')
      .select('id, full_name, email, location_id, role, created_at, jobber_user_id')
      .eq('location_id', hubUser.location_id)
      .order('full_name', { ascending: true })

    if (locUsersErr) console.error('[hub-page] location users fetch error:', locUsersErr.message)

    initialUsers = (locUsers || []).map(buildLocationUser)
  }

  let initialPeople: any[] = []
  let initialBinPeople: any[] = []
  {
    let q = supabaseService
      .from('leads')
      // "not junk" = false OR NULL. Jobber-imported leads leave is_junk
      // unset (NULL), and `.eq('is_junk', false)` does NOT match NULL in
      // Postgres — those leads loaded nowhere (not here, not the bin which
      // is is_junk=true) and were invisible app-wide. `is_junk IS NOT TRUE`
      // matches false and NULL, still excluding genuinely junked leads.
      .select('*')
      .not('is_junk', 'is', true)
      .order('created_at', { ascending: false })
      .limit(1000)

    if (!isElevated && hubUser.location_id) {
      q = q.eq('location_uuid', hubUser.location_id)
    }

    const { data: leadsRaw, error: leadsError } = await q

    if (leadsError) {
      console.error('[hub-page] leads fetch error:', leadsError.message)
    } else if (leadsRaw && leadsRaw.length > 0) {
      const leadIds = leadsRaw.map((l: any) => l.id)

      const [
        { data: leadNotesRaw },
        { data: touchpointsRaw },
        { data: leadContactsRaw },
        { data: leadTagsRaw },
        { data: assessmentsRaw },
        { data: serviceRequestsRaw },
        { data: quotesRaw },
        { data: jobsRaw },
        { data: invoicesRaw },
      ] = await Promise.all([
        supabaseService.from('lead_notes').select('*').in('lead_id', leadIds).order('created_at', { ascending: false }),
        supabaseService.from('touchpoints').select('*').in('lead_id', leadIds).order('occurred_at', { ascending: false }),
        supabaseService.from('lead_contacts').select('*').in('lead_id', leadIds).order('created_at', { ascending: true }),
        supabaseService.from('lead_tags').select('*').in('lead_id', leadIds),
        supabaseService.from('assessments').select('*').in('lead_id', leadIds).order('scheduled_at', { ascending: false }),
        supabaseService.from('service_requests').select('*').in('lead_id', leadIds).order('created_at', { ascending: false }),
        supabaseService.from('quotes').select('*').in('lead_id', leadIds).order('sent_at', { ascending: false }),
        supabaseService.from('jobs').select('*').in('lead_id', leadIds).order('scheduled_start', { ascending: false }),
        supabaseService.from('invoices').select('*').in('lead_id', leadIds).order('issued_at', { ascending: false }),
      ])

      const tagLookupIds = Array.from(new Set((leadTagsRaw || []).map((lt: any) => lt.tag_lookup_id)))
      let tag_lookups: Record<string, any> = {}
      if (tagLookupIds.length > 0) {
        const { data: tagLookupRows } = await supabaseService
          .from('lookups')
          .select('*')
          .in('id', tagLookupIds)
        ;(tagLookupRows || []).forEach((row: any) => {
          tag_lookups[row.id] = row
        })
      }

      const groupBy = <T extends { lead_id: string }>(rows: T[] | null) => {
        const out: Record<string, T[]> = {}
        ;(rows || []).forEach(r => {
          if (!out[r.lead_id]) out[r.lead_id] = []
          out[r.lead_id].push(r)
        })
        return out
      }

      const notesByLead       = groupBy(leadNotesRaw)
      const touchByLead       = groupBy(touchpointsRaw)
      const contactsByLead    = groupBy(leadContactsRaw)
      const tagsByLead        = groupBy(leadTagsRaw)
      const assessByLead      = groupBy(assessmentsRaw)
      const serviceReqsByLead = groupBy(serviceRequestsRaw)
      const quotesByLead      = groupBy(quotesRaw)
      const jobsByLead        = groupBy(jobsRaw)
      const invoicesByLead    = groupBy(invoicesRaw)

      const { mapLeadToPerson } = await import('@/lib/people-mapper')
      initialPeople = leadsRaw.map((row: any) =>
        mapLeadToPerson(row, {
          lead_notes:       notesByLead[row.id]       || [],
          touchpoints:      touchByLead[row.id]       || [],
          lead_contacts:    contactsByLead[row.id]    || [],
          lead_tags:        tagsByLead[row.id]        || [],
          assessments:      assessByLead[row.id]      || [],
          service_requests: serviceReqsByLead[row.id] || [],
          quotes:           quotesByLead[row.id]      || [],
          jobs:             jobsByLead[row.id]        || [],
          invoices:         invoicesByLead[row.id]    || [],
          tag_lookups,
        })
      )
      console.log(`[hub-page] Fetched ${initialPeople.length} leads + joined data for ${hubUser.email}`)
    }
  }

  // Recycle Bin: load is_junk=true leads, same location-scoping as the main
  // query. Joined-table data (notes, touchpoints, etc.) is skipped — the bin
  // only renders name/location/timestamp, and on restore the PATCH response
  // returns the full row. 90-day retention keeps this bounded.
  {
    let binQ = supabaseService
      .from('leads')
      .select('*')
      .eq('is_junk', true)
      .order('updated_at', { ascending: false })
      .limit(500)

    if (!isElevated && hubUser.location_id) {
      binQ = binQ.eq('location_uuid', hubUser.location_id)
    }

    const { data: binRaw, error: binError } = await binQ

    if (binError) {
      console.error('[hub-page] bin leads fetch error:', binError.message)
    } else if (binRaw && binRaw.length > 0) {
      const { mapLeadToPerson } = await import('@/lib/people-mapper')
      initialBinPeople = binRaw.map((row: any) => ({
        ...mapLeadToPerson(row, {}),
        deletedAt: row.updated_at || row.created_at || null,
      }))
      console.log(`[hub-page] Fetched ${initialBinPeople.length} bin leads for ${hubUser.email}`)
    }
  }

  // /clients/[id] passes initialSelectedLeadId — if the id doesn't exist in
  // the user's accessible leads (deleted, wrong location, or invalid uuid),
  // bounce to /clients with notfound=1 so the panel doesn't open and the
  // user gets a toast. initialPeople is already location-scoped above.
  if (initialSelectedLeadId) {
    const found = initialPeople.some((p: any) => p.id === initialSelectedLeadId)
    if (!found) {
      redirect('/clients?notfound=1')
    }
  }

  // Partners + Contacts (one table, `type` discriminator) and Companies — the
  // CRM module behind the "Contacts" tab. Location-scoped like leads; elevated
  // users get every location's rows. Soft-deleted rows are excluded (the recycle
  // bin re-fetches lazily / restores via the API response). Mapped to the same
  // camelCase client shape the API returns so setPartners/setCompanies snapshots
  // stay consistent across reloads and writes.
  let initialPartners: any[] = []
  let initialCompanies: any[] = []
  {
    let pq = supabaseService
      .from('partners')
      .select(PARTNER_COLS)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .limit(2000)
    let cq = supabaseService
      .from('companies')
      .select(COMPANY_COLS)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .limit(2000)

    if (!isElevated && hubUser.location_id) {
      pq = pq.eq('location_id', hubUser.location_id)
      cq = cq.eq('location_id', hubUser.location_id)
    }

    const [{ data: partnersRaw, error: partnersErr }, { data: companiesRaw, error: companiesErr }] =
      await Promise.all([pq, cq])

    if (partnersErr) console.error('[hub-page] partners fetch error:', partnersErr.message)
    else initialPartners = (partnersRaw || []).map(mapPartnerRow)

    if (companiesErr) console.error('[hub-page] companies fetch error:', companiesErr.message)
    else initialCompanies = (companiesRaw || []).map(mapCompanyRow)
  }

  const initialLookups: Record<string, any[]> = {}
  {
    const { data: lookups, error: lookupsError } = await supabaseService
      .from('lookups')
      .select('id, category, label, sort_order, color, bg_color, icon, description, attrs, is_active')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })

    if (lookupsError) {
      console.error('[hub-page] lookups fetch error:', lookupsError.message)
    } else if (lookups) {
      for (const row of lookups) {
        const cat = row.category as string
        if (!initialLookups[cat]) initialLookups[cat] = []
        initialLookups[cat].push(row)
      }
    }
  }

  return (
    <BeeHub
      initialRoute={initialRoute}
      initialSelectedLeadId={initialSelectedLeadId}
      notFoundToast={notFoundToast}
      initialRole={role}
      initialFranchiseRole={franchiseRole}
      initialLocFilter={initialLocFilter}
      initialGuideSlides={initialGuideSlides}
      initialManualSlides={initialManualSlides}
      initialTierPrices={initialTierPrices}
      initialLocations={initialLocations}
      initialUsers={initialUsers}
      initialSeats={initialSeats}
      initialPendingInvites={initialPendingInvites}
      initialLookups={initialLookups}
      initialPeople={initialPeople}
      initialBinPeople={initialBinPeople}
      initialPartners={initialPartners}
      initialCompanies={initialCompanies}
      currentSubscription={currentSubscription}
      currentLocation={currentLocation}
      currentUser={{
        id: hubUser.id,
        email: hubUser.email,
        name: hubUser.full_name || hubUser.email,
        role: hubUser.role,
        locationId: hubUser.location_id,
        first_name: profileFields.first_name,
        last_name: profileFields.last_name,
        phone: profileFields.phone,
      }}
    />
  )
}
