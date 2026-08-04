import { Sparkles } from "lucide-react";
import { SetPasswordForm } from "@/components/auth/set-password-form";

export const dynamic = "force-dynamic";

// Public, logged-out page (allow-listed in proxy.ts). A user redeems a one-time
// setup link here to choose their own password (ADR-0029 P2).
export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-5 py-16">
      <div className="w-full max-w-[408px]">
        <div className="mb-5 flex items-center justify-center gap-2">
          <Sparkles className="size-[22px] text-accent" />
          <span className="text-lg font-semibold tracking-tight">Example Kitchen</span>
        </div>
        <SetPasswordForm token={token ?? ""} />
        <p className="mt-4 text-center text-[11.5px] text-muted-foreground">Example Kitchen backoffice</p>
      </div>
    </div>
  );
}
