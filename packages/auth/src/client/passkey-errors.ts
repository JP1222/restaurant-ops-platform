export type PasskeyFlow = "authentication" | "registration";

export type PasskeyFeedback =
  | {
      kind: "silent";
    }
  | {
      kind: "feedback";
      tone: "error" | "info";
      message: string;
    };

function readErrorName(error: unknown) {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") {
    return error.name;
  }

  return null;
}

function readErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return null;
}

function isCancelledPasskeyFlow(name: string | null, message: string | null) {
  if (name === "AbortError" || name === "NotAllowedError") {
    return true;
  }

  const normalizedMessage = message?.toLowerCase() ?? "";
  return (
    normalizedMessage.includes("timed out or was not allowed") ||
    normalizedMessage.includes("timed out or not allowed")
  );
}

export function resolvePasskeyFeedback(error: unknown, flow: PasskeyFlow): PasskeyFeedback {
  const name = readErrorName(error);
  const message = readErrorMessage(error);

  if (isCancelledPasskeyFlow(name, message)) {
    return {
      kind: "silent"
    };
  }

  if (flow === "registration" && name === "InvalidStateError") {
    return {
      kind: "feedback",
      tone: "info",
      message: "This device already has a passkey for the kitchen console. Try signing in with it instead."
    };
  }

  if (message && name === "Error") {
    return {
      kind: "feedback",
      tone: "error",
      message
    };
  }

  return {
    kind: "feedback",
    tone: "error",
    message:
      flow === "authentication"
        ? "Passkey sign-in failed. Try again or use your password instead."
        : "Passkey setup failed. Try again in a moment."
  };
}

export const normalizePasskeyError = resolvePasskeyFeedback;
