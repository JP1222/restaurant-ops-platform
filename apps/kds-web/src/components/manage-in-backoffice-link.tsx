"use client";

import { getBackofficeAdminUrl } from "@/lib/env";

type ManageInBackofficeLinkProps = {
  /**
   * Path under the Backoffice admin tree the link should open, e.g.
   * `/admin/board` or `/admin/integrations`. Leading slash optional.
   */
  path: string;
  /** Visible label, e.g. "Manage in Backoffice". */
  label?: string;
};

/**
 * Inline affordance the Floor surfaces use to redirect operators to the
 * Backoffice when they try to edit a read-only field. Phase 4.5.3 introduces
 * these on operator-config + Deliverect rows so the Floor never offers an
 * edit affordance for a field it cannot persist (Iron Law #4).
 *
 * The link opens in a new tab so the Floor session keeps running on the
 * kitchen tablet while the operator edits the value from a desktop browser.
 */
export function ManageInBackofficeLink({ path, label = "Manage in Backoffice" }: ManageInBackofficeLinkProps) {
  return (
    <a
      className="manage-link"
      href={getBackofficeAdminUrl(path)}
      target="_blank"
      rel="noreferrer noopener"
    >
      {label}
    </a>
  );
}
