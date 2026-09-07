import { describe, expect, test, jest } from "bun:test";
import { getBranchSha } from "../src/github/operations/branch";

// Gitea has no equivalent of GitHub's singular `GET /git/ref/{ref}` endpoint
// (confirmed against a live Gitea 1.27 instance's OpenAPI spec) - Octokit's
// git.getRef() 404s there, and setupBranch() must fall back to Gitea's
// plural `GET /git/refs/{ref}`, which always returns an array of matching
// refs rather than a single object.
function make404Error() {
  const err = new Error("404 page not found");
  (err as any).status = 404;
  return err;
}

describe("getBranchSha", () => {
  test("uses the singular GitHub endpoint when it succeeds", async () => {
    const requestMock = jest.fn();
    const octokits = {
      rest: {
        git: {
          getRef: jest.fn().mockResolvedValue({
            data: { object: { sha: "github-sha-abc" } },
          }),
        },
        request: requestMock,
      },
    } as any;

    const sha = await getBranchSha(octokits, "owner", "repo", "main");

    expect(sha).toBe("github-sha-abc");
    expect(requestMock).not.toHaveBeenCalled();
  });

  test("falls back to Gitea's plural endpoint on a 404, picking the exact ref match", async () => {
    const requestMock = jest.fn().mockResolvedValue({
      data: [
        { ref: "refs/heads/main", object: { sha: "gitea-sha-123" } },
        // A prefix-matching decoy that must not be picked over the exact match.
        { ref: "refs/heads/main-other", object: { sha: "wrong-sha" } },
      ],
    });
    const octokits = {
      rest: {
        git: { getRef: jest.fn().mockRejectedValue(make404Error()) },
        request: requestMock,
      },
    } as any;

    const sha = await getBranchSha(octokits, "owner", "repo", "main");

    expect(sha).toBe("gitea-sha-123");
    expect(requestMock).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/git/refs/{ref}",
      { owner: "owner", repo: "repo", ref: "heads/main" },
    );
  });

  test("throws when the plural endpoint has no exact match", async () => {
    const octokits = {
      rest: {
        git: { getRef: jest.fn().mockRejectedValue(make404Error()) },
        request: jest.fn().mockResolvedValue({
          data: [
            { ref: "refs/heads/main-other", object: { sha: "wrong-sha" } },
          ],
        }),
      },
    } as any;

    await expect(
      getBranchSha(octokits, "owner", "repo", "main"),
    ).rejects.toThrow("Branch 'main' not found in owner/repo");
  });

  test("propagates a non-404 error from the singular endpoint without falling back", async () => {
    const requestMock = jest.fn();
    const octokits = {
      rest: {
        git: {
          getRef: jest.fn().mockRejectedValue(new Error("network error")),
        },
        request: requestMock,
      },
    } as any;

    await expect(
      getBranchSha(octokits, "owner", "repo", "main"),
    ).rejects.toThrow("network error");
    expect(requestMock).not.toHaveBeenCalled();
  });
});
