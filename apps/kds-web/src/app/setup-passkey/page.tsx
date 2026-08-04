import { buildBoardSettingsHref, normalizeReturnToPath } from "@/lib/auth";
import { pickSearchParam, type SearchParamsRecord } from "@/lib/search-params";
import { requireServerAuthSession } from "@/lib/server-auth";
import { redirect } from "next/navigation";

export default async function SetupPasskeyPage({
  searchParams
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const params = await searchParams;
  const returnTo = normalizeReturnToPath(pickSearchParam(params.returnTo), "/board");
  await requireServerAuthSession(`/setup-passkey?returnTo=${encodeURIComponent(returnTo)}`);
  redirect(buildBoardSettingsHref(returnTo));
}
