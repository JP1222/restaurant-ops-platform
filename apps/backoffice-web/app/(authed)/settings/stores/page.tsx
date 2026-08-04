"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { StoresTable } from "@/components/stores/stores-table";

export default function StoresSettingsPage() {
  return (
    <SettingsPanel
      id="stores"
      action={
        <Button asChild size="sm" className="h-[38px] rounded-[9px]">
          <Link href="/settings/stores/new">
            <Plus className="mr-1.5 size-4" />
            Add store
          </Link>
        </Button>
      }
    >
      <StoresTable />
    </SettingsPanel>
  );
}
