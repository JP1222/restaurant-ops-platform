export {
  authenticateWithPasskey,
  buildBrowserLogoutHref,
  deletePasskeyCredential,
  loginWithPassword,
  registerPasskey
} from "./api.ts";
export {
  DEV_AUTH_BYPASS_SESSION,
  getDevAuthBypassSession,
  type AuthBypassEnv
} from "./dev-auth-bypass.ts";
export {
  normalizePasskeyError,
  resolvePasskeyFeedback,
  type PasskeyFeedback,
  type PasskeyFlow
} from "./passkey-errors.ts";
export {
  isConditionalUiSupported,
  isPasskeyActionDisabled,
  isPasskeySupported,
  shouldShowPasskeyUnsupported,
  supportsPasskeys,
  usePasskeySupport,
  type ConditionalUiSupportCheck,
  type PasskeySupport,
  type PasskeySupportCheck
} from "./passkey-support.ts";
export type { AuthRole, AuthSession, AuthenticatedSession, PasskeySummary } from "../shared/types.ts";
export {
  buildBoardSettingsHref,
  buildLoginHref,
  buildPostLoginDestination,
  normalizeReturnToPath
} from "../shared/navigation.ts";
