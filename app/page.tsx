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

  // ─── Guide slides ───
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

  // ─── User's own location subscription (for onboarding variant) ───
  let currentSubscription: any = null
  if (hubUser.location_id) {
    const { data: locRow, error: subErr } = await supabase
      .from('locations')
      .select(
        'id, name, subscription_status, subscription_plan, payment_source, paid_through_date, deferred_until, billing_notes'
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
    }
  }

  // ─── All locations for admin views (elevated users only) ───
  // Use service-role client to bypass RLS — avoids the SSR cookie-refresh
  // silent-fail pattern that returns empty arrays on stale sessions.
  // Auth has already been verified via requireAuth + getHubUser + isElevated.
  let initialLocations: any[] | null = null
  if (isElevated) {
    const { data: locs, error: locsErr } = await supabaseService
      .from('locations')
      .select(
        'id, name, state, lifecycle_status, subscription_status, subscription_plan, payment_source, paid_through_date, billing_notes, jobber_account_id, created_at'
      )
      .order('name', { ascending: true })

    if (locsErr) {
      console.error('[page.tsx] locations fetch error:', locsErr.message)
    } else {
      console.log(`[page.tsx] Fetched ${locs?.length ?? 0} locations for ${hubUser.email}`)
    }

    const { data: owners, error: ownersErr } = await supabaseService
      .from('hub_users')
      .select('id, full_name, email, location_id, role')
      .in('role', ['owner', 'admin'])

    if (ownersErr) console.error('[page.tsx] owners fetch error:', ownersErr.message)

    const ownersByLoc: Record<string, { name: string; userCount: number }> = {}
    const userCountByLoc: Record<string, number> = {}
    ;(owners || []).forEach((u: any) => {
      if (!u.location_id) return
      userCountByLoc[u.location_id] = (userCountByLoc[u.location_id] || 0) + 1
      if (u.role === 'owner' && !ownersByLoc[u.location_id]) {
        ownersByLoc[u.location_id] = {
          name: u.full_name || u.email,
          userCount: 0,
        }
      }
    })

    initialLocations = (locs || []).map((row: any) => {
      const lifecycle = row.lifecycle_status || 'onboarding'
      const subStatus = row.subscription_status || 'deferred'
      const crmStatus =
        subStatus === 'past_due'
          ? 'pastdue'
          : lifecycle === 'paused'
            ? 'inactive'
            : lifecycle

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
        leads: 0,
        revenue: 0,
        collected: 0,
        userCount: userCountByLoc[row.id] || 0,
        joinedDate: fmtJoined(row.created_at),
      }
    })
  }

  return (
    <BeeHub
      initialRole={role}
      initialFranchiseRole={franchiseRole}
      initialLocFilter={initialLocFilter}
      initialGuideSlides={initialGuideSlides}
      initialLocations={initialLocations}
      currentSubscription={currentSubscription}
      currentUser={{
        id: hubUser.id,
        email: hubUser.email,
        name: hubUser.full_name || hubUser.email,
        role: hubUser.role,
        locationId: hubUser.location_id,
      }}
    />
  )
}
