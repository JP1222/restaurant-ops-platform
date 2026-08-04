"use client";

import type { KitchenBoardSettings } from "@rop/contracts";
import { ManageInBackofficeLink } from "@/components/manage-in-backoffice-link";

type DeliverectStatusCardProps = {
  deliverect: KitchenBoardSettings["providers"]["deliverect"];
};

/**
 * Read-only status display for the Deliverect integration. Replaces the
 * editable Deliverect form that used to live on the Floor's settings drawer
 * (Phase 4.5.3 — Iron Law #4: Deliverect credentials are managed in
 * Backoffice).
 *
 * The Floor only ever needs to know:
 *   - whether the integration is wired up at all (enabled + has config), and
 *   - which physical store location the row points at (so kitchen staff can
 *     sanity-check that they're looking at the right merchant).
 *
 * Credentials (apiToken, hmacSecret) never reach the Floor anymore — the
 * kds-api `serializeDeliverectProvider` writes empty strings into those
 * fields for the Floor's `GET /api/kds/settings` response.
 */
export function DeliverectStatusCard({ deliverect }: DeliverectStatusCardProps) {
  const hasConfig = deliverect.enabled || deliverect.externalLocationId.length > 0;
  const environmentLabel = deliverect.environment === "production" ? "Production" : "Staging";

  return (
    <div className="settings-deliverect-status">
      <div className="settings-deliverect-status-row">
        {hasConfig ? (
          <>
            <span className="settings-deliverect-badge is-connected">Connected</span>
            <span className="settings-deliverect-meta">
              {environmentLabel}
              {deliverect.externalLocationId ? ` · Location ${deliverect.externalLocationId}` : ""}
            </span>
          </>
        ) : (
          <>
            <span className="settings-deliverect-badge is-disconnected">Not configured</span>
            <span className="settings-deliverect-meta settings-deliverect-meta-empty">
              No Deliverect credentials on file
            </span>
          </>
        )}
      </div>

      <div className="settings-provider-status-grid">
        <div className="settings-provider-status-card">
          <span className="settings-provider-status-label">Register webhook</span>
          <strong>{deliverect.registerWebhookStatus ?? "Not seen yet"}</strong>
          <small>{deliverect.lastRegisterWebhookAt ?? "No register webhook received yet."}</small>
        </div>
        <div className="settings-provider-status-card">
          <span className="settings-provider-status-label">Orders webhook</span>
          <strong>{deliverect.ordersWebhookStatus ?? "Not seen yet"}</strong>
          <small>{deliverect.lastOrderWebhookAt ?? "No order webhook received yet."}</small>
        </div>
      </div>

      <p className="settings-readonly-note">
        Credentials and channel routing live in the Backoffice. <ManageInBackofficeLink path="/admin/integrations" label="Set up in Backoffice" />
      </p>
    </div>
  );
}
