import HubPage from './_hub-page'

// The root route is the ONLY Hub route whose query string is load-bearing for a
// logged-out visitor: the feedback reply email links to /?feedback=1 (issue
// 233), and that param is what opens the reply once the app mounts. Next gives
// a page its searchParams; HubPage folds them into the post-login `next` so the
// param survives the sign-in bounce instead of being dropped at the door
// (issue 235 defect A).
export default function Home({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>
}) {
  return <HubPage initialSearchParams={searchParams} />
}
