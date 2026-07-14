import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // Internal sweeper / self-chain POSTs authenticate via x-import-continue-secret
  // rather than a Supabase session — bypass auth entirely for those requests.
  const internalSecret = process.env.CRON_SECRET
  if (
    internalSecret &&
    request.headers.get('x-import-continue-secret') === internalSecret
  ) {
    return NextResponse.next()
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet: { name: string; value: string; options?: object }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // ── Layer 1 (PRIMARY lockout): a hub_user whose access has been removed
  // (hub_users.disabled_at IS NOT NULL) is bounced from every app route,
  // even with a valid session. This is the authoritative gate — it must lock
  // them out on its own, independent of the Supabase auth ban (Layer 2).
  //
  // Exempt paths keep the removed user able to SEE the notice and sign out:
  //   /access-removed   — the notice page itself (avoid a redirect loop)
  //   /auth             — login / callback / invite
  //   /api/auth         — sign-out endpoint
  const path = request.nextUrl.pathname
  const isExempt =
    path === '/access-removed' ||
    path.startsWith('/auth') ||
    path.startsWith('/api/auth')

  if (user && !isExempt) {
    // Self-read via the session client (RLS lets a caller read their own row).
    const { data: me } = await supabase
      .from('hub_users')
      .select('disabled_at')
      .eq('id', user.id)
      .single()

    if (me?.disabled_at) {
      if (path.startsWith('/api/')) {
        return NextResponse.json(
          { error: 'access_removed' },
          { status: 403 },
        )
      }
      const url = request.nextUrl.clone()
      url.pathname = '/access-removed'
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/cron|api/import).*)'],
}