import { describe, expect, it, jest } from "bun:test";
import {
  fetchIssueDataViaRest,
  fetchPullRequestDataViaRest,
  fetchUserDisplayNameViaRest,
  isGraphQLUnavailableError,
} from "../src/github/data/rest-fetcher";
import { fetchGitHubData } from "../src/github/data/fetcher";

describe("isGraphQLUnavailableError", () => {
  it("treats a well-formed GraphqlResponseError (has .errors) as a real GraphQL failure, not unavailability", () => {
    const error = { message: "boom", errors: [{ message: "not found" }] };
    expect(isGraphQLUnavailableError(error)).toBe(false);
  });

  it("treats a transport-level failure (no .errors) as GraphQL unavailability", () => {
    expect(isGraphQLUnavailableError(new Error("404 Not Found"))).toBe(true);
    expect(isGraphQLUnavailableError({ status: 404 })).toBe(true);
    expect(isGraphQLUnavailableError(undefined)).toBe(true);
  });
});

describe("fetchIssueDataViaRest", () => {
  it("assembles a GitHubIssue-shaped object from Gitea/GitHub-compatible REST responses", async () => {
    const rest: any = {
      issues: {
        get: jest.fn().mockResolvedValue({
          data: {
            title: "Bug: things broke",
            body: "steps to repro",
            user: { login: "reporter" },
            created_at: "2024-01-15T10:00:00Z",
            updated_at: "2024-01-15T10:30:00Z",
            state: "open",
            labels: [{ name: "bug" }],
          },
        }),
        listComments: jest.fn().mockResolvedValue({
          data: [
            {
              id: 42,
              body: "looking into it",
              user: { login: "maintainer" },
              created_at: "2024-01-15T11:00:00Z",
              updated_at: "2024-01-15T11:00:00Z",
            },
          ],
        }),
      },
    };
    rest.paginate = jest.fn(async (method: any, params: any) => {
      const res = await method(params);
      return res.data;
    });

    const issue = await fetchIssueDataViaRest(
      { rest } as any,
      "owner",
      "repo",
      5,
    );

    expect(issue.title).toBe("Bug: things broke");
    expect(issue.state).toBe("OPEN");
    expect(issue.author).toEqual({ login: "reporter", name: undefined });
    expect(issue.labels.nodes).toEqual([{ name: "bug" }]);
    expect(issue.comments.nodes).toHaveLength(1);
    expect(issue.comments.nodes[0]?.body).toBe("looking into it");
    expect(issue.comments.nodes[0]?.databaseId).toBe("42");
    expect(issue.comments.nodes[0]?.isMinimized).toBe(false);
  });
});

describe("fetchPullRequestDataViaRest", () => {
  it("assembles a GitHubPullRequest-shaped object, normalizing state and deriving isCrossRepository", async () => {
    const rest: any = {
      pulls: {
        get: jest.fn().mockResolvedValue({
          data: {
            title: "Add feature",
            body: "does the thing",
            user: { login: "contributor" },
            base: { ref: "main", repo: { full_name: "owner/repo" } },
            head: {
              ref: "feature-x",
              sha: "abc123",
              repo: {
                full_name: "fork-owner/repo",
                owner: { login: "fork-owner" },
                name: "repo",
              },
            },
            created_at: "2024-01-15T10:00:00Z",
            updated_at: "2024-01-15T10:30:00Z",
            additions: 10,
            deletions: 2,
            state: "closed",
            merged: true,
            labels: [{ name: "enhancement" }],
          },
        }),
        listFiles: jest.fn().mockResolvedValue({
          data: [
            {
              filename: "a.ts",
              additions: 5,
              deletions: 1,
              status: "modified",
            },
          ],
        }),
        listCommits: jest.fn().mockResolvedValue({
          data: [
            {
              sha: "abc123",
              commit: {
                message: "add feature",
                author: { name: "contributor", email: "c@example.com" },
              },
            },
          ],
        }),
        listReviews: jest.fn().mockResolvedValue({
          data: [
            {
              id: 900,
              user: { login: "reviewer" },
              body: "looks good",
              state: "APPROVED",
              submitted_at: "2024-01-15T11:00:00Z",
            },
          ],
        }),
        listReviewComments: jest.fn().mockResolvedValue({
          data: [
            {
              id: 901,
              pull_request_review_id: 900,
              path: "a.ts",
              line: 12,
              diff_hunk: "@@ -1,1 +1,1 @@",
              body: "nit: rename this",
              user: { login: "reviewer" },
              created_at: "2024-01-15T11:00:00Z",
              updated_at: "2024-01-15T11:00:00Z",
            },
          ],
        }),
      },
      issues: {
        listComments: jest.fn().mockResolvedValue({
          data: [
            {
              id: 42,
              body: "conversation comment",
              user: { login: "someone" },
              created_at: "2024-01-15T10:15:00Z",
              updated_at: "2024-01-15T10:15:00Z",
            },
          ],
        }),
      },
    };
    rest.paginate = jest.fn(async (method: any, params: any) => {
      const res = await method(params);
      return res.data;
    });

    const pr = await fetchPullRequestDataViaRest(
      { rest } as any,
      "owner",
      "repo",
      7,
    );

    expect(pr.state).toBe("MERGED");
    expect(pr.isCrossRepository).toBe(true);
    expect(pr.headRepository).toEqual({
      owner: { login: "fork-owner" },
      name: "repo",
    });
    expect(pr.files?.nodes).toEqual([
      { path: "a.ts", additions: 5, deletions: 1, changeType: "MODIFIED" },
    ]);
    expect(pr.commits.totalCount).toBe(1);
    expect(pr.commits.nodes[0]?.commit.oid).toBe("abc123");
    expect(pr.comments.nodes[0]?.body).toBe("conversation comment");
    expect(pr.reviews.nodes).toHaveLength(1);
    expect(pr.reviews.nodes[0]?.state).toBe("APPROVED");
    expect(pr.reviews.nodes[0]?.comments.nodes).toHaveLength(1);
    expect(pr.reviews.nodes[0]?.comments.nodes[0]?.path).toBe("a.ts");
    expect(pr.reviews.nodes[0]?.comments.nodes[0]?.line).toBe(12);
  });

  it("treats a same-owner head repo as not cross-repository", async () => {
    const rest: any = {
      pulls: {
        get: jest.fn().mockResolvedValue({
          data: {
            title: "x",
            body: "",
            user: { login: "a" },
            base: { ref: "main", repo: { full_name: "owner/repo" } },
            head: {
              ref: "branch",
              sha: "sha1",
              repo: {
                full_name: "owner/repo",
                owner: { login: "owner" },
                name: "repo",
              },
            },
            created_at: "2024-01-15T10:00:00Z",
            state: "open",
          },
        }),
        listFiles: jest.fn().mockResolvedValue({ data: [] }),
        listCommits: jest.fn().mockResolvedValue({ data: [] }),
        listReviews: jest.fn().mockResolvedValue({ data: [] }),
        listReviewComments: jest.fn().mockResolvedValue({ data: [] }),
      },
      issues: { listComments: jest.fn().mockResolvedValue({ data: [] }) },
    };
    rest.paginate = jest.fn(async (method: any, params: any) => {
      const res = await method(params);
      return res.data;
    });

    const pr = await fetchPullRequestDataViaRest(
      { rest } as any,
      "owner",
      "repo",
      1,
    );
    expect(pr.isCrossRepository).toBe(false);
    expect(pr.state).toBe("OPEN");
  });
});

describe("fetchUserDisplayNameViaRest", () => {
  it("returns the user's display name", async () => {
    const rest = {
      users: {
        getByUsername: jest
          .fn()
          .mockResolvedValue({ data: { name: "Real Name" } }),
      },
    };
    const name = await fetchUserDisplayNameViaRest({ rest } as any, "someuser");
    expect(name).toBe("Real Name");
  });

  it("returns null on failure instead of throwing", async () => {
    const rest = {
      users: {
        getByUsername: jest.fn().mockRejectedValue(new Error("not found")),
      },
    };
    const name = await fetchUserDisplayNameViaRest({ rest } as any, "someuser");
    expect(name).toBeNull();
  });
});

describe("fetchGitHubData GraphQL-unavailable fallback", () => {
  it("falls back to REST when the GraphQL endpoint is unavailable (Gitea-shaped)", async () => {
    const graphql = jest
      .fn()
      .mockRejectedValue(new Error("404 page not found"));
    const rest: any = {
      issues: {
        get: jest.fn().mockResolvedValue({
          data: {
            title: "Gitea issue",
            body: "body",
            user: { login: "author" },
            created_at: "2024-01-15T10:00:00Z",
            state: "open",
            labels: [],
          },
        }),
        listComments: jest.fn().mockResolvedValue({ data: [] }),
      },
    };
    rest.paginate = jest.fn(async (method: any, params: any) => {
      const res = await method(params);
      return res.data;
    });

    const result = await fetchGitHubData({
      octokits: { graphql, rest } as any,
      repository: "owner/repo",
      prNumber: "9",
      isPR: false,
      triggerTime: "2024-01-15T12:00:00Z",
    });

    expect(graphql).toHaveBeenCalled();
    expect(rest.issues.get).toHaveBeenCalled();
    expect((result.contextData as any).title).toBe("Gitea issue");
  });

  it("does not fall back and rethrows on a genuine GitHub GraphQL error", async () => {
    const graphqlError = Object.assign(
      new Error("Could not resolve to a PullRequest"),
      {
        errors: [{ message: "Could not resolve to a PullRequest" }],
      },
    );
    const graphql = jest.fn().mockRejectedValue(graphqlError);
    const rest: any = { issues: {}, paginate: jest.fn() };

    await expect(
      fetchGitHubData({
        octokits: { graphql, rest } as any,
        repository: "owner/repo",
        prNumber: "9",
        isPR: false,
        triggerTime: "2024-01-15T12:00:00Z",
      }),
    ).rejects.toThrow("Failed to fetch issue data");

    expect(rest.paginate).not.toHaveBeenCalled();
  });
});
