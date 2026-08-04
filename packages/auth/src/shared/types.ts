// db-auth account roles — mirrors the WebAdminRole enum (contracts
// WebAdminRoleSchema). OWNER/MANAGER are active; ADMIN is deprecated and
// migrates to OWNER (ADR-0029).
export type AuthRole = "OWNER" | "MANAGER" | "ADMIN";

export type AuthSession =
  | {
      authenticated: false;
    }
  | {
      authenticated: true;
      username: string;
      displayName: string;
      hasPasskeys: boolean;
    };

export type AuthenticatedSession = Extract<AuthSession, { authenticated: true }>;

export interface PasskeySummary {
  readonly credentialId: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly transports: string[];
}
