// REST-based fallback for fetching issue/PR data, used when the GraphQL
// endpoint (PR_QUERY/ISSUE_QUERY/USER_QUERY in ../api/queries/github.ts)
// isn't available — notably Gitea, which has no GraphQL API at all but
// exposes a REST surface deliberately modeled after GitHub's (confirmed
// against a live Gitea 1.27 instance's OpenAPI spec: the same
// /repos/{owner}/{repo}/issues, /pulls, /pulls/{n}/{files,commits,reviews}
// paths exist with GitHub-compatible field names).
//
// This assembles the exact same GitHubPullRequest/GitHubIssue shape the
// GraphQL path produces so formatter.ts, create-prompt/, and the rest of
// fetchGitHubData() need no changes to consume either source.
//
// Known REST/GraphQL gaps, all handled by omission rather than guessing:
// - No `isMinimized` (hidden-comment) concept over REST — always false.
// - No bot/App actor discriminator on REST user objects — isBot signal
//   (GraphQL's __typename) is left unset, so actor-filtering treats every
//   REST-sourced author as human. Gitea has no bot-account concept to query
//   here either (confirmed: its User schema has no type field).
// - No `lastEditedAt` distinct from `updated_at` over REST — omitted.
// - PR review inline-comment `line` is populated from REST's `line` field
//   when present (recent Gitea/GitHub REST versions include it); older
//   Gitea versions may only return `position`, in which case `line` is left
//   null rather than guessing a translation.

import type { Octokits } from "../api/client";
import type {
  GitHubAuthor,
  GitHubComment,
  GitHubFile,
  GitHubIssue,
  GitHubPullRequest,
  GitHubReview,
  GitHubReviewComment,
} from "../types";

function toAuthor(
  user: { login?: string; name?: string | null } | null | undefined,
): GitHubAuthor | null {
  if (!user?.login) return null;
  return { login: user.login, name: user.name || undefined };
}

function toComment(c: any): GitHubComment {
  return {
    id: String(c.id),
    databaseId: String(c.id),
    body: c.body ?? "",
    author: toAuthor(c.user),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    isMinimized: false,
  };
}

function normalizeState(
  state: string | undefined,
  merged: boolean | undefined,
): string {
  if (merged) return "MERGED";
  return (state || "open").toUpperCase();
}

export async function fetchIssueDataViaRest(
  octokits: Octokits,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  const { data: issue } = await octokits.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });

  const comments = await octokits.rest.paginate(
    octokits.rest.issues.listComments,
    { owner, repo, issue_number: issueNumber, per_page: 100 },
  );

  return {
    title: issue.title,
    body: issue.body ?? "",
    author: toAuthor(issue.user),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    state: normalizeState(issue.state, false),
    labels: {
      nodes: (issue.labels || []).map((l: any) => ({
        name: typeof l === "string" ? l : l.name,
      })),
    },
    comments: { nodes: comments.map(toComment) },
  };
}

export async function fetchPullRequestDataViaRest(
  octokits: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubPullRequest> {
  const { data: pr } = await octokits.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const [comments, files, commits, reviews, reviewComments] = await Promise.all(
    [
      octokits.rest.paginate(octokits.rest.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      }),
      octokits.rest.paginate(octokits.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
      octokits.rest.paginate(octokits.rest.pulls.listCommits, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
      octokits.rest.paginate(octokits.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
      octokits.rest.paginate(octokits.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    ],
  );

  const reviewCommentsByReviewId = new Map<number, GitHubReviewComment[]>();
  for (const rc of reviewComments as any[]) {
    const reviewId = rc.pull_request_review_id;
    const mapped: GitHubReviewComment = {
      ...toComment(rc),
      path: rc.path,
      line: rc.line ?? null,
      diffHunk: rc.diff_hunk ?? null,
    };
    const bucket = reviewCommentsByReviewId.get(reviewId) ?? [];
    bucket.push(mapped);
    reviewCommentsByReviewId.set(reviewId, bucket);
  }

  const reviewNodes: GitHubReview[] = (reviews as any[]).map((r) => ({
    id: String(r.id),
    databaseId: String(r.id),
    author: toAuthor(r.user),
    body: r.body ?? "",
    state: r.state,
    submittedAt: r.submitted_at,
    comments: { nodes: reviewCommentsByReviewId.get(r.id) ?? [] },
  }));

  const headFullName = (pr.head as any)?.repo?.full_name;
  const baseFullName = (pr.base as any)?.repo?.full_name;

  const changedFiles: GitHubFile[] = (files as any[]).map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changeType: (f.status || "modified").toUpperCase(),
  }));

  return {
    title: pr.title,
    body: pr.body ?? "",
    author: toAuthor(pr.user),
    baseRefName: pr.base.ref,
    headRefName: pr.head.ref,
    headRefOid: pr.head.sha,
    isCrossRepository: Boolean(
      headFullName && baseFullName && headFullName !== baseFullName,
    ),
    headRepository: (pr.head as any)?.repo
      ? {
          owner: { login: (pr.head as any).repo.owner.login },
          name: (pr.head as any).repo.name,
        }
      : null,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    state: normalizeState(pr.state, pr.merged),
    labels: {
      nodes: (pr.labels || []).map((l: any) => ({ name: l.name })),
    },
    commits: {
      totalCount: (commits as any[]).length,
      nodes: (commits as any[]).map((c) => ({
        commit: {
          oid: c.sha,
          message: c.commit.message,
          author: {
            name: c.commit.author?.name ?? "",
            email: c.commit.author?.email ?? "",
          },
        },
      })),
    },
    files: { nodes: changedFiles },
    comments: { nodes: (comments as any[]).map(toComment) },
    reviews: { nodes: reviewNodes },
  };
}

export async function fetchUserDisplayNameViaRest(
  octokits: Octokits,
  login: string,
): Promise<string | null> {
  try {
    const { data } = await octokits.rest.users.getByUsername({
      username: login,
    });
    return data.name || null;
  } catch (error) {
    console.warn(
      `Failed to fetch user display name via REST for ${login}:`,
      error,
    );
    return null;
  }
}

/**
 * True when an error thrown by @octokit/graphql indicates the GraphQL
 * endpoint itself doesn't exist/respond (Gitea, a GraphQL-less proxy), as
 * opposed to a genuine GraphQL-level error from a real GitHub GraphQL API
 * (e.g. "Could not resolve to a PullRequest with the number X", which
 * surfaces as a 200 response with a populated `errors` array and must
 * continue to propagate as before, not silently fall back).
 */
export function isGraphQLUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  // GraphqlResponseError (a well-formed GraphQL error response) has an
  // `errors` array — that's a real answer from a real GraphQL API.
  if ("errors" in error && Array.isArray((error as any).errors)) {
    return false;
  }
  return true;
}
