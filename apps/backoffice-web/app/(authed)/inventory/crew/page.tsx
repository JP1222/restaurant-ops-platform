"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCrew } from "@/hooks/use-crew";
import { CrewTable } from "@/components/crew/crew-table";
import { AddCrewDialog } from "@/components/crew/add-crew-dialog";
import { CrewSecurityCard } from "@/components/crew/crew-security-card";

export default function CrewPage() {
  const query = useCrew();

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Crew</h1>
          <p className="text-sm text-muted-foreground">
            Manage floor crew logins. Add or disable members and set their 6-digit PIN for the floor
            app.
          </p>
        </div>
        <AddCrewDialog />
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Crew members</CardTitle>
          <CardDescription>
            {query.data
              ? `${query.data.employees.length} member${query.data.employees.length === 1 ? "" : "s"}`
              : "Loading..."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : query.isError ? (
            <p className="text-sm text-destructive">
              Could not load crew: {query.error instanceof Error ? query.error.message : "unknown"}
            </p>
          ) : query.data ? (
            <CrewTable employees={query.data.employees} />
          ) : null}
        </CardContent>
      </Card>

      <CrewSecurityCard />
    </div>
  );
}
