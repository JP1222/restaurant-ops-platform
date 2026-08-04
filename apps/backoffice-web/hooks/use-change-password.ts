"use client";

import { useMutation } from "@tanstack/react-query";
import type {
  PasswordChangeRequest,
  PasswordMutationResponse,
  PasswordRejection,
} from "@rop/contracts";

export type ChangePasswordResult = PasswordMutationResponse | PasswordRejection;

// Calls the session-gated BFF change-password route. Validation outcomes
// (wrong current password, breached, …) return 200 with a discriminated
// result; only auth/transport failures throw.
export function useChangePassword() {
  return useMutation<ChangePasswordResult, Error, PasswordChangeRequest>({
    mutationFn: async (body) => {
      const response = await fetch("/api/auth/password/change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Your session has expired — sign in again.");
        }
        throw new Error("Couldn't reach the server. Please try again.");
      }

      return (await response.json()) as ChangePasswordResult;
    },
  });
}
