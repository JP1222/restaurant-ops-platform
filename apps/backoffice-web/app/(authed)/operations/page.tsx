import { OperationsPage } from "@/components/ops/operations/operations-page";

// CI/CD status + one-click deploy panel. Lives under the Operations sidebar
// group (not Settings) so it gets a full-width standalone shell. Auth is handled
// by proxy.ts (all (authed) routes require a backoffice session); the BFF routes
// it calls re-check with requireSession.
export default function OperationsDeployPage() {
  return <OperationsPage />;
}
