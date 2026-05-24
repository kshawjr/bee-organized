import HubPage from '../_hub-page'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ notfound?: string }>
}) {
  const { notfound } = await searchParams
  return <HubPage initialRoute="clients" notFoundToast={notfound === '1'} />
}
