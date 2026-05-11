import { requireAuth, getHubUser } from '@/lib/auth'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import BeeHub from '@/components/BeeHub'

// Map hub_users.role → BeeHub's internal role string
// BeeHub uses: 'super_admin' | 'corporate' | 'franchise'
// hub_users:   'super_admin' | 'admin' | 'owner' | 'lite_user'
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

export default async function HomePage() {
  // Ensure user is authenticated — redirects to /auth/login if not
  const authUser = await requireAuth()

  // Look up their hub_users row
  const hubUser = await getHubUser()

  // Authenticated but no hub_users profile → informative page (no redirect loop)
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

  // Elevated roles see all locations; franchise users scoped to their own
  const isElevated = role === 'super_admin' || role === 'corporate'
  const initialLocFilter = isElevated ? 'all' : hubUser.location_id || 'all'

  // Server-fetch guide slides so first paint already has them.
  // Empty array means BeeHub falls back to GUIDE_SLIDES defaults bundled in.
  const supabase = await createServerSupabaseClient()
  const { data: slidesData } = await supabase
    .from('guide_slides')
    .select('*')
    .order('slot', { ascending: true })

  const initialGuideSlides = (slidesData || []).map((row: any) => ({
    icon: row.icon,
    chapter: row.chapter,
    color: row.color,
    title: row.title,
    body: row.body || '',
    bullets: row.bullets || [],
    screenshot: row.screenshot_url || null,
  }))

  return (
    <BeeHub
      initialRole={role}
      initialFranchiseRole={franchiseRole}
      initialLocFilter={initialLocFilter}
      initialGuideSlides={initialGuideSlides}
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
