import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionFromCookies } from "@rop/auth/next";
import { LoginForm } from "@/components/login-form";
import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";

type SearchParamsRecord = Record<string, string | string[] | undefined>;

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeBackofficePath(value: string | undefined, fallback = "/") {
  if (!value || !value.startsWith("/")) {
    return fallback;
  }

  try {
    const normalized = new URL(value, "https://backoffice.local");
    return `${normalized.pathname}${normalized.search}${normalized.hash}` || fallback;
  } catch {
    return fallback;
  }
}

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const params = await searchParams;
  const returnTo = normalizeBackofficePath(pickSearchParam(params.from));
  const session = await getSessionFromCookies(await cookies(), getBackofficeAuthService(), {
    cookieName: getBackofficeSessionCookieName()
  });

  if (session) {
    redirect(returnTo);
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 p-6 md:p-10">
      <LoginForm returnTo={returnTo} />
    </div>
  );
}
