import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Stub the env module before importing the client so the client reads the
// stub instead of requiring real env vars during the test run.
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    ANALYTICS_ADMIN_TOKEN: "test",
    INTERNAL_ANALYTICS_API_URL: "http://localhost:3100",
    GITHUB_PIPELINE_TOKEN: "ghp_test",
    GITHUB_REPO_OWNER: "example-org",
    GITHUB_REPO_NAME: "restaurant-ops-platform",
    BACKOFFICE_SESSION_COOKIE_NAME: "rop_backoffice_session",
  }),
}));

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("githubApi", () => {
  it("listRecentRuns maps snake_case GH payload to camelCase summaries", async () => {
    const { githubApi } = await import("@/lib/github");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 1,
              name: "CI",
              workflow_id: 42,
              workflow_name: "CI",
              head_branch: "main",
              head_sha: "abc123",
              event: "push",
              status: "completed",
              conclusion: "success",
              run_number: 11,
              run_attempt: 1,
              created_at: "2026-05-20T00:00:00Z",
              updated_at: "2026-05-20T00:01:00Z",
              run_started_at: "2026-05-20T00:00:00Z",
              html_url: "https://github.com/example-org/restaurant-ops-platform/actions/runs/1",
              actor: { login: "example-org" },
              display_title: "fix: foo",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const runs = await githubApi.listRecentRuns({ perPage: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 1,
      workflowName: "CI",
      headBranch: "main",
      headSha: "abc123",
      runNumber: 11,
      actorLogin: "example-org",
      displayTitle: "fix: foo",
    });
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(
      "https://api.github.com/repos/example-org/restaurant-ops-platform/actions/runs?per_page=5",
    );
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer ghp_test",
      Accept: "application/vnd.github+json",
    });
  });

  it("listJobs flattens steps and maps fields", async () => {
    const { githubApi } = await import("@/lib/github");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jobs: [
            {
              id: 99,
              run_id: 1,
              name: "Build kds-api (arm64)",
              status: "completed",
              conclusion: "success",
              started_at: "2026-05-20T00:00:00Z",
              completed_at: "2026-05-20T00:00:43Z",
              runner_name: "mac-mini-1",
              html_url: "https://github.com/x/y/actions/runs/1/job/99",
              steps: [
                {
                  name: "Build & push",
                  status: "completed",
                  conclusion: "success",
                  number: 1,
                  started_at: "2026-05-20T00:00:10Z",
                  completed_at: "2026-05-20T00:00:40Z",
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const jobs = await githubApi.listJobs(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("Build kds-api (arm64)");
    expect(jobs[0]?.runnerName).toBe("mac-mini-1");
    expect(jobs[0]?.steps).toHaveLength(1);
    expect(jobs[0]?.steps[0]?.name).toBe("Build & push");
  });

  it("throws GithubApiError on non-2xx with status preserved", async () => {
    const { githubApi, GithubApiError } = await import("@/lib/github");
    fetchMock.mockResolvedValueOnce(
      new Response("rate limit", { status: 403 }),
    );
    await expect(githubApi.listRecentRuns()).rejects.toBeInstanceOf(GithubApiError);
    try {
      fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
      await githubApi.getRun(7);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GithubApiError);
      expect((e as InstanceType<typeof GithubApiError>).status).toBe(404);
    }
  });
});
