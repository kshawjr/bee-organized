import { requireAuth, getHubUser } from '@/lib/auth'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
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

// hub_users.role (enforced auth role) → TeamSection's tier-display role
// (FRANCHISE_ROLES key, drives Queen Bee / Hive Keeper / Worker Bee /
// Honey Watcher chip + seat pricing). admin → manager is a placeholder
// until subscription_seats lands and lets us derive tier from purchased
// seat instead of from auth role.
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
    // Users with no location_id are corporate-tier (org-level seats);
    // matches the USERS_DATA mock convention and keeps location-less
    // admins from falling through both filters in UsersTab.
    role: row.location_id ? mapTier(row.role) : 'corporate',
    displayCategory:
      row.location_id ? 'franchise' :
      row.role === 'super_admin' ? 'development' :
      'corporate',
    status: 'active',
    joined: fmtJoined(row.created_at),
  }
}

export default async function HomePage() {
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

  // Cookie-bound client — used for user-scoped reads (their own location, guide slides)
  const supabase = await createServerSupabaseClient()

  // ─── Profile fields (Pass 2) ───
  // getHubUser() returns the basics; explicit select for the new profile
  // columns lets us pre-fill the onboarding profile step without depending
  // on lib/auth.ts. Falls back to empty if unmigrated.
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

  // ─── Guide slides ───
  const { data: slidesData } = await supabase
    .from('guide_slides')
    .select('*')
    .order('chapter', { ascending: true })
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

  // ─── Tier prices (single source of truth for seat pricing) ───
  // Service-role read so an unmigrated table never breaks rendering for
  // franchise users. Write path (/api/admin/tier-prices PUT) re-checks role.
  const { data: tierPricesRaw } = await supabaseService
    .from('tier_prices')
    .select('id, display_name, price_annual, description, sort_order, updated_at')
    .order('sort_order', { ascending: true })

  const initialTierPrices = tierPricesRaw || []

  // ─── Manual slides (Hive Hub Manual — second guide system) ───
  // Service-role read so an unmigrated table never breaks rendering for
  // franchise users. Write path (/api/manual-slides POST) re-checks role.
  const { data: manualSlidesRaw } = await supabaseService
    .from('manual_slides')
    .select('*')
    .order('chapter', { ascending: true })
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

  // ─── User's own location: subscription + Jobber connection state ───
  // Single query, two derived prop shapes (subscription/billing vs.
  // connection-status). Real franchise owners get both; super_admin /
  // corporate get null (they don't have a location-scoped UI).
  let currentSubscription: any = null
  let currentLocation: any = null
  if (hubUser.location_id) {
    const { data: locRow, error: subErr } = await supabase
      .from('locations')
      .select(
        'id, name, subscription_status, subscription_plan, payment_source, paid_through_date, deferred_until, billing_notes, jobber_account_id, last_sync_status, token_expiry, onboarding_state, default_drip_path, default_move_drip_path, address, city, state, zip, phone, email, timezone, sender_name, send_from_email, reply_to_email, reviews_link, calendar_link, activated_at, lifecycle_status'
      )
      .eq('id', hubUser.location_id)
      .single()

    if (subErr) console.error('[page.tsx] currentSubscription error:', subErr.message)

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
        last_sync_status: locRow.last_sync_status || null,
        token_expiry: locRow.token_expiry || null,
        payment_source: locRow.payment_source || 'none',
        subscription_status: locRow.subscription_status || 'deferred',
        subscription_plan: locRow.subscription_plan || null,
        paid_through_date: locRow.paid_through_date || null,
        lifecycle_status: locRow.lifecycle_status || 'onboarding',
        // Onboarding persistence — read on every page load for cross-device
        // continuity. OnboardingChecklist seeds React state from this and
        // falls back to sessionStorage if absent. Writes go through
        // /api/onboarding/progress.
        onboarding_state: locRow.onboarding_state || {},
        default_drip_path: locRow.default_drip_path || 'general-a',
        default_move_drip_path: locRow.default_move_drip_path || 'move-a',
        // Pass 2 — location-step content fields. Used to pre-fill the
        // location form on remount so partial onboarders see their progress.
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

  // ─── Subscription seats for the current user's location ───
  // Service-role read so an unmigrated table never breaks rendering for
  // franchise users pre-migration. Returns active seats only — Dispatch 2
  // surfaces inactive history through Admin > Billing if needed.
  // Super_admin / corporate (no location_id) get an empty array — they dig
  // into specific locations via the Admin tab.
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

    if (seatsErr) console.error('[page.tsx] seats fetch error:', seatsErr.message)
    initialSeats = seatsRaw || []

    // Pending invites count against the per-tier seat pool. InviteTeamMember
    // subtracts these from available seats so the UI matches what the API
    // gates on — without this, owner sees "1 available" but POST returns 409.
    const { data: pendingRaw, error: pendingErr } = await supabaseService
      .from('pending_invites')
      .select('id, location_id, email, full_name, role, tier, invite_expires_at, accepted_at, created_at')
      .eq('location_id', currentLocation.id)
      .is('accepted_at', null)
      .order('created_at', { ascending: true })

    if (pendingErr) console.error('[page.tsx] pending_invites fetch error:', pendingErr.message)
    initialPendingInvites = pendingRaw || []
  }

  // ─── All locations for admin views (elevated users only) ───
  // Use service-role client to bypass RLS — avoids the SSR cookie-refresh
  // silent-fail pattern that returns empty arrays on stale sessions.
  // Auth has already been verified via requireAuth + getHubUser + isElevated.
  let initialLocations: any[] | null = null
  // Team roster: full org for elevated, location-scoped for franchise.
  // Null falls back to USERS_DATA mock in App / TeamSection (view-as paths).
  let initialUsers: any[] | null = null
  if (isElevated) {
    const { data: locs, error: locsErr } = await supabaseService
      .from('locations')
      .select(
        'id, name, state, lifecycle_status, subscription_status, subscription_plan, payment_source, paid_through_date, billing_notes, jobber_account_id, last_sync_status, created_at, onboarding_state, default_drip_path, default_move_drip_path, activated_at'
      )
      .order('name', { ascending: true })

    if (locsErr) {
      console.error('[page.tsx] locations fetch error:', locsErr.message)
    } else {
      console.log(`[page.tsx] Fetched ${locs?.length ?? 0} locations for ${hubUser.email}`)
    }

    // Single hub_users fetch powers ownersByLoc + userCountByLoc (location
    // table) AND initialUsers (Team tab / AdminScreen UsersTab). Broader
    // than the prior `owners`-only query so super_admin/corporate see every
    // seat, not just owners+admins. Cap at 500 — headroom for franchise
    // growth without unbounded read cost.
    const { data: allUsers, error: usersErr } = await supabaseService
      .from('hub_users')
      .select('id, full_name, email, location_id, role, created_at')
      .order('full_name', { ascending: true })
      .limit(500)

    if (usersErr) console.error('[page.tsx] hub_users fetch error:', usersErr.message)

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
      // Prefer subscription_status as the source of truth. lifecycle_status
      // is a secondary lever ('paused' overrides to inactive); a null/missing
      // lifecycle_status should NOT drag an active subscription back to
      // 'onboarding' (prior bug — Test Location showed onboarding badge
      // despite subscription_status='active').
      const crmStatus =
        subStatus === 'past_due'              ? 'pastdue'
        : lifecycle === 'paused'              ? 'inactive'
        : subStatus === 'inactive'            ? 'inactive'
        : subStatus === 'active'              ? 'active'
        :                                       'onboarding'

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
        // Onboarding persistence (admin views — read-only here; surfaced
        // for future super_admin dashboards showing per-location progress)
        onboarding_state: row.onboarding_state || {},
        default_drip_path: row.default_drip_path || 'general-a',
        default_move_drip_path: row.default_move_drip_path || 'move-a',
        activated_at: row.activated_at || null,
      }
    })
  } else if (hubUser.location_id) {
    // Franchise owner / admin / lite_user: scope users to their location.
    // Cookie-bound client respects RLS — caller has already been verified
    // by requireAuth + getHubUser above.
    const { data: locUsers, error: locUsersErr } = await supabase
      .from('hub_users')
      .select('id, full_name, email, location_id, role, created_at')
      .eq('location_id', hubUser.location_id)
      .order('full_name', { ascending: true })

    if (locUsersErr) console.error('[page.tsx] location users fetch error:', locUsersErr.message)

    initialUsers = (locUsers || []).map(buildLocationUser)
  }

  // ─── Hive clients (leads) — Phase 3A ───
  // Read-only initial hydration. Joined tables (lead_notes, touchpoints,
  // lead_contacts, lead_tags, jobs, invoices, assessments) come in Phase 3B.
  // For now: just the leads themselves, location-scoped and mapped through
  // lib/people-mapper.
  let initialPeople: any[] = []
  {
    let q = supabaseService
      .from('leads')
      .select('*')
      .eq('is_junk', false)
      .order('created_at', { ascending: false })
      .limit(1000)

    // Scope by location for non-elevated users
    if (!isElevated && hubUser.location_id) {
      q = q.eq('location_uuid', hubUser.location_id)
    }

    const { data: leadsRaw, error: leadsError } = await q

    if (leadsError) {
      console.error('[page.tsx] leads fetch error:', leadsError.message)
    } else if (leadsRaw) {
      const { mapLeadToPerson } = await import('@/lib/people-mapper')
      initialPeople = leadsRaw.map(mapLeadToPerson)
      console.log(`[page.tsx] Fetched ${initialPeople.length} leads for ${hubUser.email}`)
    }
  }

  // ─── Admin-managed lookups (Sitting 1A) ───
  // Single query for all active lookups, grouped client-side by category.
  // Cheap (~150 rows seeded). Result feeds the in-memory getter hydration
  // in BeeHub.jsx so the existing constant-fallback pattern picks up DB data.
  const initialLookups: Record<string, any[]> = {}
  {
    const { data: lookups, error: lookupsError } = await supabaseService
      .from('lookups')
      .select('id, category, label, sort_order, color, bg_color, icon, description, attrs, is_active')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })

    if (lookupsError) {
      console.error('[page.tsx] lookups fetch error:', lookupsError.message)
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
      currentSubscription={currentSubscription}
      currentLocation={currentLocation}
      currentUser={{
        id: hubUser.id,
        email: hubUser.email,
        name: hubUser.full_name || hubUser.email,
        role: hubUser.role,
        locationId: hubUser.location_id,
        // Pass 2 — profile fields for pre-filling the profile step form
        first_name: profileFields.first_name,
        last_name: profileFields.last_name,
        phone: profileFields.phone,
      }}
    />
  )
}