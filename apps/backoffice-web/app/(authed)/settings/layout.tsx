import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";

// Settings center shell. Fills the padded <main> as a self-contained bordered
// surface: a fixed second-level nav on the left (rail on md+, horizontal strip
// on mobile) and an independently-scrolling content area on the right.
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border md:flex-row">
      <SettingsNav />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
