// lib/use-realtime-channel.ts
// ─────────────────────────────────────────────────────────────
// THE ONE PLACE A REALTIME CHANNEL IS OPENED. Every subscription in the app
// goes through here so that none of them can join anonymously.
//
// THE BUG THIS CLOSES, and it had killed every live feature we shipped.
// Owners sit on Bee Hub all day and new leads never appeared. On the socket,
// four channels joined within 73ms of each other and all four replied ok —
// but the FIRST one's phx_join carried no access_token:
//
//   realtime:leads         phx_join {"config":{…},"private":false}   ← no token
//   realtime:touchpoints   phx_join {"config":{…},"access_token":"…"}
//   realtime:engagements   phx_join {"config":{…},"access_token":"…"}
//
// A channel that joins without a token is evaluated as `anon`. Our leads
// SELECT policy grants to `authenticated`, so anon matches no policy: the
// subscription is ACCEPTED, reports SUBSCRIBED, heartbeats happily — and
// delivers nothing, forever. Nothing errors. That is why it survived so long,
// and why the tests here assert on the JOIN PAYLOAD rather than on the
// subscribe status, which was green throughout.
//
// WHY IT WAS A RACE, confirmed in the installed supabase-js (2.103.0):
//   · SupabaseClient's constructor kicks off its initial auth as a
//     FIRE-AND-FORGET promise:
//       if (this.accessToken) Promise.resolve(this.accessToken())
//         .then(token => this.realtime.setAuth(token))
//   · RealtimeChannel.subscribe() attaches the token only if it is ALREADY
//     there:
//       if (this.socket.accessTokenValue) payload.access_token = …
// So a .subscribe() that runs in the same tick as createClient() joins before
// that promise resolves. The later channels won by 73ms of luck, not design —
// on a slower load they would lose it exactly the same way.
//
// THE FIX: await the token before joining. `setAuth()` with NO argument
// resolves the session through the client's own accessToken callback and, per
// _performAuth, does NOT set the manual-token flag — so supabase-js keeps
// owning refresh afterwards (its onAuthStateChange handler pushes
// TOKEN_REFRESHED / SIGNED_IN tokens to joined channels). We close the
// startup race and hand the tab straight back to the library.
//
// SUBSCRIBE ANYWAY IF AUTH FAILS. Realtime is an enhancement, never a gate:
// a signed-out or broken-auth client still opens the channel and simply
// receives nothing, which is what RLS would do regardless. Failing closed
// here would trade a silent feature for a broken one.
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase'

type Supabase = ReturnType<typeof createClient>
type Channel = ReturnType<Supabase['channel']>

/**
 * @param key   the subscription's identity — a location uuid, a lead id, the
 *              literal 'all'. Falsy means "no vocabulary yet, subscribe to
 *              nothing". The effect is keyed on THIS alone.
 * @param label names the channel in error logs, e.g. 'leads'.
 * @param build creates and configures the channel (.on(...) bindings) and
 *              returns it UNSUBSCRIBED — this hook owns subscribe/teardown.
 *              Read through a ref, so a caller that rebuilds it every render
 *              never thrashes the websocket.
 */
export function useRealtimeChannel(
  key: string | null | undefined,
  label: string,
  build: (supabase: Supabase) => Channel
) {
  const buildRef = useRef(build)
  buildRef.current = build

  useEffect(() => {
    if (!key) return

    // createClient() THROWS when NEXT_PUBLIC_SUPABASE_* are missing, and this
    // runs in a passive effect during commit — unguarded, a config gap would
    // take the whole tree down to buy live updates. Degrade loudly instead.
    let supabase: Supabase
    try {
      supabase = createClient()
    } catch (e) {
      console.error(`[realtime] ${label}: no supabase client, live updates are off:`, e)
      return
    }

    // The channel is created inside the async gate, so teardown has to cope
    // with unmounting BEFORE the token resolves — otherwise a fast
    // mount/unmount leaks a channel that joins into a dead tree.
    let channel: Channel | null = null
    let cancelled = false

    ;(async () => {
      try {
        // No argument on purpose: resolves through the client's own callback
        // and leaves refresh in supabase-js's hands.
        await supabase.realtime.setAuth()
      } catch (e) {
        // Subscribe anyway — see the header. An unauthenticated channel
        // receives nothing, which is the correct outcome, not a crash.
        console.error(`[realtime] ${label}: could not attach auth before joining:`, e)
      }
      if (cancelled) return
      channel = buildRef.current(supabase).subscribe()
    })()

    return () => {
      cancelled = true
      if (channel) supabase.removeChannel(channel)
    }
  }, [key, label])
}
