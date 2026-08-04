"use client";

import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";

export type PasskeySupport = boolean | null;
export type PasskeySupportCheck = () => boolean;
export type ConditionalUiSupportCheck = () => Promise<boolean>;

export function supportsPasskeys(checkSupport: PasskeySupportCheck = browserSupportsWebAuthn): boolean {
  try {
    return checkSupport();
  } catch {
    return false;
  }
}

export const isPasskeySupported = supportsPasskeys;

export async function isConditionalUiSupported(
  checkSupport: ConditionalUiSupportCheck = browserSupportsWebAuthnAutofill
): Promise<boolean> {
  try {
    return await checkSupport();
  } catch {
    return false;
  }
}

export function usePasskeySupport(checkSupport = supportsPasskeys): PasskeySupport {
  const [passkeySupport, setPasskeySupport] = useState<PasskeySupport>(null);

  useEffect(() => {
    try {
      setPasskeySupport(checkSupport());
    } catch {
      setPasskeySupport(false);
    }
  }, [checkSupport]);

  return passkeySupport;
}

export function isPasskeyActionDisabled(passkeySupport: PasskeySupport, isBusy: boolean) {
  return passkeySupport !== true || isBusy;
}

export function shouldShowPasskeyUnsupported(passkeySupport: PasskeySupport) {
  return passkeySupport === false;
}
