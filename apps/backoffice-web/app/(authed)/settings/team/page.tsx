"use client";

import { AddUserDialog } from "@/components/admin/add-user-dialog";
import { UsersTable } from "@/components/admin/users-table";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminUsers } from "@/hooks/use-admin-users";
import { useProfile } from "@/hooks/use-profile";

export default function TeamSettingsPage() {
  const query = useAdminUsers();
  const profile = useProfile();

  return (
    <SettingsPanel id="team" action={<AddUserDialog />}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Admin users</CardTitle>
          <CardDescription>
            {query.data
              ? `${query.data.users.length} account${query.data.users.length === 1 ? "" : "s"}`
              : "Loading..."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : query.isError ? (
            <p className="text-sm text-destructive">
              Could not load users: {query.error instanceof Error ? query.error.message : "unknown"}
            </p>
          ) : query.data ? (
            <UsersTable users={query.data.users} currentUserId={profile.data?.id} />
          ) : null}
        </CardContent>
      </Card>
    </SettingsPanel>
  );
}
