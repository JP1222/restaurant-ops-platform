import { LoginScreen } from "@/components/login-screen";
import { buildPostLoginDestination, normalizeReturnToPath } from "@/lib/auth";
import { pickSearchParam, type SearchParamsRecord } from "@/lib/search-params";
import { getServerAuthSession } from "@/lib/server-auth";
import { redirect } from "next/navigation";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const params = await searchParams;
  const returnTo = normalizeReturnToPath(pickSearchParam(params.returnTo), "/board");
  const session = await getServerAuthSession();
  if (session.authenticated) {
    redirect(buildPostLoginDestination(session, returnTo));
  }

  return <LoginScreen returnTo={returnTo} />;
}
