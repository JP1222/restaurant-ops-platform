import { PairScreen } from "@/components/pair-screen";
import { pickSearchParam, type SearchParamsRecord } from "@/lib/search-params";

// Device pairing (ADR-0818 Phase-2b). A floor device opens `/pair?code=…` (the
// link/QR a manager generated in Backoffice) and is redeemed + redirected into
// its store's board/display. With no `?code` it shows pairing instructions + a
// manager sign-in link.
export default async function PairPage({
  searchParams
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const params = await searchParams;
  const code = pickSearchParam(params.code) ?? null;
  return <PairScreen code={code} />;
}
