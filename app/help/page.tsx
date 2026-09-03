import HubPage from '../_hub-page'

// /help — the Help section. Same shell as every other tab: a hard refresh or a
// shared link SSRs to the right state; in-app tab changes use pushState.
// ?tab=requests lands on the My requests tab (HelpScreen reads it on mount).
export default function Page() {
  return <HubPage initialRoute="help" />
}
