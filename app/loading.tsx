// app/loading.tsx
//
// The initial-load state — and the ONLY thing that can serve it.
//
// WHY NO CLIENT COMPONENT COULD DO THIS. HubPage is an async Server Component.
// On a hard load the browser sits with nothing while the server awaits auth,
// the scope resolution, and the data reads; our JavaScript has not been
// downloaded, let alone hydrated, so there is no React tree in which a loader
// could exist. BeeLoader mounted anywhere inside <BeeHub> is unreachable at
// that moment by construction. The wait genuinely happens before anything of
// ours can render.
//
// A route-level loading file is the exception: Next wraps the page segment in
// a Suspense boundary and STREAMS this fallback as HTML immediately, then
// streams the real content in when the server component resolves. It is server
// output, so it needs no hydration to appear.
//
// Two consequences that shaped the code:
//   · delay={0} — BeeLoader's usual 350ms gate is an effect, and effects do not
//     run pre-hydration. Left at the default this fallback would stream EMPTY
//     for the whole wait it exists to cover.
//   · the orbit keyframes live in app/globals.css, not in motion.jsx's
//     effect-injected block, for the same reason: no JS has run, so an injected
//     keyframe would not exist and the bee would sit frozen.
//
// Inherited by every nested segment that does not define its own, so one file
// covers /, /clients, /contacts, /hive, /reports, /settings, /admin.
//
// Fast loads still cost nothing visually: this replaces a blank white page, so
// even a 200ms appearance is strictly better than what was there before.

import BeeLoader from '@/components/hive/shared/BeeLoader'

export default function Loading() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // The warm canvas the app itself sits on, so the fallback reads as the
        // app arriving rather than as a separate white interstitial.
        background: '#f7f6f4',
        fontFamily: '"DM Sans", system-ui, sans-serif',
      }}
    >
      <BeeLoader size="screen" delay={0} label="Warming up the hive…" />
    </div>
  )
}
