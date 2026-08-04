import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type FC } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AdminUsersError,
  useAdminUsers,
  useCreateAdminUser,
  useDeleteAdminUser
} from "@/hooks/use-admin-users";

// The admin-users hooks share a single `fetchJson` that turns the kds-api
// machine error codes (surfaced by the BFF either as a bare `{ error: <code> }`
// or wrapped as `{ upstream: { error: <code> } }`) into operator-facing copy.
// This suite drives the REAL exported hooks (no copied mapping) against a mocked
// `fetch`, asserting:
//   - each code maps to its exact human string,
//   - both envelope shapes (bare + upstream-wrapped) resolve the same code,
//   - the raw envelope / machine code never leaks into the surfaced message,
//   - the thrown error preserves `code` + `status` for logs,
//   - 401 short-circuits to the session-expired copy,
//   - an unrecognized body falls back to the generic copy.
// We render through @tanstack/react-query so the production query/mutation
// closures (the only place `fetchJson` is reachable) run unchanged.

const EXPECTED_COPY = {
  last_admin: "You can't delete the only account.",
  last_owner: "At least one Owner must remain.",
  last_login_method:
    "This is the account's only sign-in method — set a password or add another passkey first.",
  username_taken: "That username is already taken.",
  user_not_found: "That account no longer exists.",
  passkey_not_found: "That passkey was already removed."
} as const;

type Code = keyof typeof EXPECTED_COPY;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false }
    }
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderHook<T>(useHook: () => T): Promise<{ current: T }> {
  const client = makeClient();
  const captured: { current: T } = { current: undefined as unknown as T };
  const Probe: FC = () => {
    captured.current = useHook();
    return null;
  };
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe))
    );
  });
  return captured;
}

// Resolve the error a hook surfaces. For the query hook we wait for the failed
// fetch to settle; for mutation hooks we trigger `mutate` then wait.
async function captureQueryError(): Promise<unknown> {
  const hook = await renderHook(() => useAdminUsers());
  for (let i = 0; i < 50 && !hook.current.isError; i++) {
    await flush();
  }
  return hook.current.error;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("admin-users fetchJson error mapping", () => {
  test.each(Object.entries(EXPECTED_COPY) as [Code, string][])(
    "maps a bare { error: %s } body to its human string and never leaks the code",
    async (code, copy) => {
      global.fetch = vi.fn(async () => jsonResponse(409, { error: code })) as typeof fetch;

      const error = await captureQueryError();

      expect(error).toBeInstanceOf(AdminUsersError);
      const adminError = error as AdminUsersError;
      expect(adminError.message).toBe(copy);
      expect(adminError.code).toBe(code);
      expect(adminError.status).toBe(409);
      // The surfaced message must be human copy, not the machine code itself.
      expect(adminError.message).not.toContain(code);
      expect(adminError.message).not.toMatch(/upstream/i);
    }
  );

  test.each(Object.entries(EXPECTED_COPY) as [Code, string][])(
    "maps an upstream-wrapped { upstream: { error: %s } } body the same way",
    async (code, copy) => {
      global.fetch = vi.fn(
        async () => jsonResponse(409, { error: "upstream_error", upstream: { error: code } })
      ) as typeof fetch;

      const error = (await captureQueryError()) as AdminUsersError;

      expect(error).toBeInstanceOf(AdminUsersError);
      expect(error.message).toBe(copy);
      expect(error.code).toBe(code);
      // The "upstream_error" envelope marker must not be what the operator sees.
      expect(error.message).not.toMatch(/upstream/i);
    }
  );

  test("never surfaces the raw { upstream: ... } object in the message", async () => {
    global.fetch = vi.fn(
      async () => jsonResponse(409, { error: "upstream_error", upstream: { error: "username_taken" } })
    ) as typeof fetch;

    const error = (await captureQueryError()) as AdminUsersError;
    expect(error.message).toBe(EXPECTED_COPY.username_taken);
    expect(error.message).not.toContain("{");
    expect(error.message).not.toContain("upstream");
  });

  test("falls back to generic copy for an unrecognized error code", async () => {
    global.fetch = vi.fn(async () => jsonResponse(500, { error: "kaboom" })) as typeof fetch;

    const error = (await captureQueryError()) as AdminUsersError;
    expect(error.message).toBe("Something went wrong. Please try again.");
    expect(error.code).toBeUndefined();
    expect(error.status).toBe(500);
  });

  test("falls back to generic copy when the body is not JSON", async () => {
    global.fetch = vi.fn(
      async () => new Response("<html>502</html>", { status: 502 })
    ) as typeof fetch;

    const error = (await captureQueryError()) as AdminUsersError;
    expect(error.message).toBe("Something went wrong. Please try again.");
    expect(error.code).toBeUndefined();
  });

  test("a 401 short-circuits to the session-expired copy, ignoring the body", async () => {
    global.fetch = vi.fn(
      async () => jsonResponse(401, { error: "username_taken" })
    ) as typeof fetch;

    const error = (await captureQueryError()) as AdminUsersError;
    expect(error.message).toBe("Your session has expired — sign in again.");
    expect(error.status).toBe(401);
    // The body code must NOT win over the 401 short-circuit.
    expect(error.code).toBeUndefined();
  });

  test("maps the same way through a mutation hook (DELETE last_owner)", async () => {
    global.fetch = vi.fn(async () => jsonResponse(409, { error: "last_owner" })) as typeof fetch;

    const hook = await renderHook(() => useDeleteAdminUser("acct_1"));
    let thrown: unknown;
    await act(async () => {
      try {
        await hook.current.mutateAsync();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(AdminUsersError);
    expect((thrown as AdminUsersError).message).toBe(EXPECTED_COPY.last_owner);
    expect((thrown as AdminUsersError).code).toBe("last_owner");
  });

  test("maps username_taken through the create mutation hook", async () => {
    global.fetch = vi.fn(async () => jsonResponse(409, { error: "username_taken" })) as typeof fetch;

    const hook = await renderHook(() => useCreateAdminUser());
    let thrown: unknown;
    await act(async () => {
      try {
        await hook.current.mutateAsync({ username: "taken", displayName: "Taken" });
      } catch (error) {
        thrown = error;
      }
    });

    expect((thrown as AdminUsersError).message).toBe(EXPECTED_COPY.username_taken);
    expect((thrown as AdminUsersError).code).toBe("username_taken");
  });
});
