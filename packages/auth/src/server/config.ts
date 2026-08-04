export type AuthServiceConfig = {
  appBaseUrl: string;
  webauthnRpId?: string | undefined;
  webauthnRpName: string;
  webSessionTtlHours: number;
  webLoginUsername?: string | undefined;
  webLoginPasswordHash?: string | undefined;
  webLoginDisplayName: string;
};
