import HubPage from '../_hub-page'

// /help — the Help section. Same shell as every other tab: a hard refresh or a
// shared link SSRs to the right state; in-app tab changes use pushState.
// ?tab=requests lands on the My requests tab (HelpScreen reads it on mount).
// searchParams ride into the post-login return-to so the reply email's
// /help?tab=requests survives the sign-in bounce (the issue 235 defect, at
// the new address).
export default function Page({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>
}) {
  return <HubPage initialRoute="help" initialSearchParams={searchParams} />
}
