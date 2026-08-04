"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { BackfillTab } from "@/components/ops/backfill-tab";
import { DatabaseTab } from "@/components/ops/database-tab";
import { DataQualityTab } from "@/components/ops/dq-tab";
import { JobsTab } from "@/components/ops/jobs-tab";
import { OpenInGrafana } from "@/components/ops/open-in-grafana";
import { PipelineTab } from "@/components/ops/pipeline-tab";
import { SyncHealthTab } from "@/components/ops/sync-health-tab";
import { WebhooksTab } from "@/components/ops/webhooks-tab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOpsOverview } from "@/hooks/use-ops";
import { useAiAssistantStore } from "@/stores/ai-assistant";

const OPS_TABS = ["pipeline", "sync", "jobs", "dq", "backfill", "webhooks", "database"] as const;
type OpsTab = (typeof OPS_TABS)[number];
const DEFAULT_TAB: OpsTab = "pipeline";

function asOpsTab(value: string | null): OpsTab | null {
  return value !== null && (OPS_TABS as readonly string[]).includes(value) ? (value as OpsTab) : null;
}

// Grafana is the time-series / log deep-dive plane. Only the telemetry-shaped
// tabs get an "Open in Grafana" escape hatch; Pipeline / Data Quality /
// Backfill are app-state surfaces with no Grafana representation, so a link
// there would be misleading. Each path targets a curated board provisioned
// under observability/grafana/provisioning/dashboards/ by its stable uid
// (Grafana fills in the cosmetic slug). Those boards are populated by the
// Prometheus exporters + scrape jobs in docker-compose.observability.yml.
const GRAFANA_TAB_PATH: Partial<Record<OpsTab, string>> = {
  sync: "/d/yr-sync/sync-health",
  jobs: "/d/yr-jobs/jobs",
  webhooks: "/d/yr-webhooks/webhooks",
  database: "/d/yr-database/database",
};

export function OpsPageClient() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setViewSnapshot = useAiAssistantStore((s) => s.setViewSnapshot);
  const overview = useOpsOverview();

  // Deep-linkable initial tab (the hub links to /ops?tab=<id>). The Tabs stay
  // uncontrolled so switching is instant client-side; we only mirror the active
  // value into state to drive the tab-aware "Open in Grafana" button.
  const initialTab = asOpsTab(searchParams.get("tab")) ?? DEFAULT_TAB;
  const [currentTab, setCurrentTab] = useState<OpsTab>(initialTab);
  const grafanaPath = GRAFANA_TAB_PATH[currentTab];

  useEffect(() => {
    if (!overview.data) return;
    const qs = searchParams.toString();
    setViewSnapshot({
      view: "ops",
      url: qs ? `${pathname}?${qs}` : pathname,
      data: overview.data,
      capturedAt: new Date().toISOString(),
    });
  }, [overview.data, pathname, searchParams, setViewSnapshot]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-medium tracking-tight">Operations</h1>
          <p className="text-muted-foreground">
            Live deploy pipeline + data-ingestion health: build → image → container, plus
            heartbeats, jobs, data quality, backfill, webhooks, and database storage.
          </p>
        </div>
        {grafanaPath ? <OpenInGrafana path={grafanaPath} /> : null}
      </header>

      <Tabs
        defaultValue={initialTab}
        onValueChange={(value) => {
          const tab = asOpsTab(value);
          if (tab) setCurrentTab(tab);
        }}
        className="space-y-4"
      >
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="sync">Sync Health</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="dq">Data Quality</TabsTrigger>
          <TabsTrigger value="backfill">Backfill</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="database">Database</TabsTrigger>
        </TabsList>
        <TabsContent value="pipeline">
          <PipelineTab />
        </TabsContent>
        <TabsContent value="sync">
          <SyncHealthTab />
        </TabsContent>
        <TabsContent value="jobs">
          <JobsTab />
        </TabsContent>
        <TabsContent value="dq">
          <DataQualityTab />
        </TabsContent>
        <TabsContent value="backfill">
          <BackfillTab />
        </TabsContent>
        <TabsContent value="webhooks">
          <WebhooksTab />
        </TabsContent>
        <TabsContent value="database">
          <DatabaseTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
