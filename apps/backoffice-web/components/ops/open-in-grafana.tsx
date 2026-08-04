import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

// External Grafana origin for the self-hosted observability stack
// (docker-compose.observability.yml -> metrics.example.com). Hardcoded
// like the other external origins in hub-client.tsx: a stable public hostname,
// not a secret.
export const GRAFANA_ORIGIN = "https://metrics.example.com";

export function OpenInGrafana({ path, label = "Open in Grafana" }: { path: string; label?: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={`${GRAFANA_ORIGIN}${path}`} target="_blank" rel="noopener noreferrer">
        {label}
        <ExternalLink />
      </a>
    </Button>
  );
}
