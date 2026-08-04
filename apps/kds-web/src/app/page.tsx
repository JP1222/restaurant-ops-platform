import { redirect } from "next/navigation";
import { buildLoginHref } from "@/lib/auth";
import { searchParamsToQueryString, type SearchParamsRecord } from "@/lib/search-params";
import { getServerAuthSession } from "@/lib/server-auth";

export default async function HomePage({
  searchParams
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const params = await searchParams;
  const boardPath = `/board${searchParamsToQueryString(params)}`;
  const session = await getServerAuthSession();
  redirect(session.authenticated ? boardPath : buildLoginHref(boardPath));
}
