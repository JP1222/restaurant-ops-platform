import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { KitchenBoardSettings } from "@rop/contracts";
import { DeliverectStatusCard } from "@/components/deliverect-status-card";
import { ManageInBackofficeLink } from "@/components/manage-in-backoffice-link";

/**
 * Phase 4.5.3 — Floor settings drawer read-only treatment.
 *
 * Renders the read-only Deliverect status card and Manage-in-Backoffice link
 * to static markup and asserts no editable inputs or decrypted secrets appear
 * in the output. The board-screen.tsx itself is too large + stateful to
 * mount inline; the building blocks here are the new components that
 * compose the read-only treatment.
 */

const originalEnv = process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL;
  } else {
    process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL = originalEnv;
  }
});

function deliverectConfig(
  overrides: Partial<KitchenBoardSettings["providers"]["deliverect"]> = {}
): KitchenBoardSettings["providers"]["deliverect"] {
  return {
    enabled: false,
    environment: "staging",
    externalLocationId: "",
    locationId: "",
    channelLinkId: "",
    apiToken: "",
    hmacSecret: "",
    registerWebhookStatus: null,
    ordersWebhookStatus: null,
    lastRegisterWebhookAt: null,
    lastOrderWebhookAt: null,
    ...overrides
  };
}

describe("DeliverectStatusCard", () => {
  it("renders a Connected badge with environment + location when configured", () => {
    const markup = renderToStaticMarkup(
      <DeliverectStatusCard
        deliverect={deliverectConfig({
          enabled: true,
          environment: "production",
          externalLocationId: "STORE-123"
        })}
      />
    );

    expect(markup).toContain("Connected");
    expect(markup).toContain("Production");
    expect(markup).toContain("STORE-123");
  });

  it("renders a Not configured badge when the row is empty", () => {
    const markup = renderToStaticMarkup(
      <DeliverectStatusCard deliverect={deliverectConfig()} />
    );

    expect(markup).toContain("Not configured");
    expect(markup).toContain("No Deliverect credentials on file");
  });

  it("never renders an editable input, select, or textarea", () => {
    const markup = renderToStaticMarkup(
      <DeliverectStatusCard
        deliverect={deliverectConfig({
          enabled: true,
          environment: "production",
          externalLocationId: "STORE-9",
          channelLinkId: "CL-1"
        })}
      />
    );

    expect(markup).not.toMatch(/<input\b/i);
    expect(markup).not.toMatch(/<select\b/i);
    expect(markup).not.toMatch(/<textarea\b/i);
  });

  it("never reveals a decrypted secret even if the payload accidentally has one", () => {
    // The kds-api Floor path forces apiToken / hmacSecret to "", but defense
    // in depth: even if a future refactor lets a secret through, the status
    // card must not echo it back into the DOM.
    const leaked = "should-never-appear-on-floor";
    const markup = renderToStaticMarkup(
      <DeliverectStatusCard
        deliverect={deliverectConfig({
          enabled: true,
          environment: "production",
          externalLocationId: "STORE-leak",
          apiToken: leaked,
          hmacSecret: leaked
        })}
      />
    );

    expect(markup).not.toContain(leaked);
  });

  it("links to /admin/integrations on the Backoffice host", () => {
    process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL = "https://backoffice.example.com";

    const markup = renderToStaticMarkup(
      <DeliverectStatusCard deliverect={deliverectConfig()} />
    );

    expect(markup).toContain("https://backoffice.example.com/admin/integrations");
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });
});

describe("ManageInBackofficeLink", () => {
  it("falls back to the production Backoffice host when env is unset", () => {
    const markup = renderToStaticMarkup(<ManageInBackofficeLink path="/admin/board" />);
    expect(markup).toContain("https://backoffice.example.com/admin/board");
    expect(markup).toContain("Manage in Backoffice");
  });

  it("honors a custom label", () => {
    const markup = renderToStaticMarkup(
      <ManageInBackofficeLink path="/admin/integrations" label="Set up in Backoffice" />
    );
    expect(markup).toContain("Set up in Backoffice");
    expect(markup).not.toContain("Manage in Backoffice");
  });
});
