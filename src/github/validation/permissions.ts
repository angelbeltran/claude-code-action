import * as core from "@actions/core";
import { isWorkflowRunEvent, type GitHubContext } from "../context";
import type { Octokit } from "@octokit/rest";

/**
 * Check if a bot actor is in the allowed bots list.
 */
function isAllowedBot(actor: string, allowedBots: string): boolean {
  const trimmed = allowedBots.trim();
  if (trimmed === "*") return true;
  if (!trimmed) return false;

  const allowedList = trimmed
    .split(",")
    .map((bot) =>
      bot
        .trim()
        .toLowerCase()
        .replace(/\[bot\]$/, ""),
    )
    .filter((bot) => bot.length > 0);

  const normalizedActor = actor.toLowerCase().replace(/\[bot\]$/, "");
  return allowedList.includes(normalizedActor);
}

/**
 * Collect the actors whose repository access should be checked. This is
 * normally just the workflow actor (GITHUB_ACTOR). For workflow_run events
 * the actor that started the upstream run is checked as well when it
 * differs, since that is the account the run originates from.
 */
function getActorsToCheck(context: GitHubContext): string[] {
  const actors = [context.actor];

  if (isWorkflowRunEvent(context)) {
    const runActor = context.payload.workflow_run?.actor?.login;
    if (runActor && !actors.includes(runActor)) {
      core.info(
        `workflow_run was started by ${runActor}; checking permissions for that actor as well`,
      );
      actors.push(runActor);
    }
  }

  return actors;
}

/**
 * Check if the actor has write permissions to the repository
 * @param octokit - The Octokit REST client
 * @param context - The GitHub context
 * @param allowedNonWriteUsers - Comma-separated list of users allowed without write permissions, or '*' for all
 * @param githubTokenProvided - Whether github_token was provided as input (not from app)
 * @returns true if the actor has write permissions, false otherwise
 */
export async function checkWritePermissions(
  octokit: Octokit,
  context: GitHubContext,
  allowedNonWriteUsers?: string,
  githubTokenProvided?: boolean,
): Promise<boolean> {
  for (const actor of getActorsToCheck(context)) {
    const allowed = await checkActorWritePermissions(
      octokit,
      context,
      actor,
      allowedNonWriteUsers,
      githubTokenProvided,
    );
    if (!allowed) return false;
  }
  return true;
}

async function checkActorWritePermissions(
  octokit: Octokit,
  context: GitHubContext,
  actor: string,
  allowedNonWriteUsers?: string,
  githubTokenProvided?: boolean,
): Promise<boolean> {
  const { repository } = context;
  const allowedBots = context.inputs.allowedBots ?? "";

  try {
    core.info(`Checking permissions for actor: ${actor}`);

    // Check if we should bypass permission checks for this user
    if (allowedNonWriteUsers && githubTokenProvided) {
      const allowedUsers = allowedNonWriteUsers.trim();
      if (allowedUsers === "*") {
        core.warning(
          `⚠️ SECURITY WARNING: Bypassing write permission check for ${actor} due to allowed_non_write_users='*'. This should only be used for workflows with very limited permissions.`,
        );
        return true;
      } else if (allowedUsers) {
        const allowedUserList = allowedUsers
          .split(",")
          .map((u) => u.trim())
          .filter((u) => u.length > 0);
        if (allowedUserList.includes(actor)) {
          core.warning(
            `⚠️ SECURITY WARNING: Bypassing write permission check for ${actor} due to allowed_non_write_users configuration. This should only be used for workflows with very limited permissions.`,
          );
          return true;
        }
      }
    }

    // Check if the actor is a GitHub App (bot user with [bot] suffix).
    // Usernames cannot contain "[" or "]", so the suffix is a reliable
    // bot signal that doesn't require an API lookup.
    if (actor.endsWith("[bot]")) {
      core.info(`Actor is a GitHub App: ${actor}`);
      return true;
    }

    // For all other actors, resolve the account via the collaborator
    // permission endpoint. allowed_bots is only consulted in the catch
    // block below, after the API has confirmed the actor is not a regular
    // user account (e.g. GitHub Apps like Copilot whose GITHUB_ACTOR is
    // "Copilot" rather than "Copilot[bot]").
    const response = await octokit.repos.getCollaboratorPermissionLevel({
      owner: repository.owner,
      repo: repository.repo,
      username: actor,
    });

    const permissionLevel = response.data.permission;
    core.info(`Permission level retrieved: ${permissionLevel}`);

    if (permissionLevel === "admin" || permissionLevel === "write") {
      core.info(`Actor has write access: ${permissionLevel}`);
      return true;
    } else {
      core.warning(`Actor has insufficient permissions: ${permissionLevel}`);
      return false;
    }
  } catch (error) {
    // Handle 404 errors for non-user actors (e.g. GitHub Apps like Copilot
    // whose GITHUB_ACTOR doesn't end with [bot]).
    // The collaborator permission API only works for user accounts.
    if (error instanceof Error && error.message.includes("is not a user")) {
      core.info(
        `Actor ${actor} is not a GitHub user (likely a GitHub App). Checking allowed_bots...`,
      );
      if (isAllowedBot(actor, allowedBots)) {
        core.info(
          `Non-user actor ${actor} is in allowed_bots list, granting access`,
        );
        return true;
      }
      core.warning(
        `Non-user actor ${actor} is not in allowed_bots list. Add it to allowed_bots or use '*' to allow all bots.`,
      );
      return false;
    }

    // Gitea's collaborator-permission endpoint is more restrictive than
    // GitHub's: it 403s with "Only admins can query all permissions, repo
    // admins can query all repo permissions, collaborators can query only
    // their own" for some token/actor combinations that do in fact have
    // write access (observed even for the repo owner). Since the repo GET
    // response's `permissions` field always reflects the *authenticated
    // token's own* access and isn't subject to that restriction, fall back
    // to it when the checked actor is that same token's own account.
    let usedGiteaAutomaticTokenHint = false;
    if ((error as { status?: number }).status === 403) {
      try {
        const [{ data: authedUser }, { data: repo }] = await Promise.all([
          octokit.users.getAuthenticated(),
          octokit.repos.get({
            owner: repository.owner,
            repo: repository.repo,
          }),
        ]);

        if (authedUser.login.toLowerCase() === actor.toLowerCase()) {
          const hasWriteAccess = Boolean(
            repo.permissions?.push || repo.permissions?.admin,
          );
          core.info(
            `Collaborator-permission lookup was forbidden; actor ${actor} is the authenticated token's own account, ` +
              `which reports push=${repo.permissions?.push} admin=${repo.permissions?.admin} on this repo`,
          );
          if (hasWriteAccess) return true;
          core.warning(
            `Actor ${actor} (token owner) has no push/admin access to the repository`,
          );
          return false;
        }
        core.info(
          `Collaborator-permission lookup was forbidden, and actor ${actor} differs from the authenticated ` +
            `token's own account (${authedUser.login}); the fallback via repo GET only reveals the token's ` +
            `own access, not ${actor}'s, so it cannot be used here.`,
        );
      } catch (fallbackError) {
        core.warning(
          `Fallback permission check via repo GET also failed: ${fallbackError}`,
        );
        // Fall through to the original error below.
      }
      // Gitea's built-in per-job Actions token (the value Gitea injects when
      // a workflow references `secrets.GITHUB_TOKEN`/a repo secret populated
      // from it) has no "administration" scope in its permission model at
      // all (see https://docs.gitea.com/usage/actions/token-permissions/) —
      // no `permissions:` block in the workflow can grant it rights to query
      // another user's collaborator permission, and it isn't tied to a real
      // user account for the fallback above to match against either. This
      // 403 is the signature of that structural limitation, not something a
      // workflow permissions change can fix.
      usedGiteaAutomaticTokenHint = true;
    }

    core.error(`Failed to check permissions: ${error}`);
    const giteaHint = usedGiteaAutomaticTokenHint
      ? " If this token is Gitea's built-in per-job Actions token, note that it has no 'administration' " +
        "scope and can never query another user's collaborator permission (see " +
        "https://docs.gitea.com/usage/actions/token-permissions/) — use a real personal/bot access token " +
        "with repo-admin rights as github_token instead, or set allowed_non_write_users to bypass this " +
        "check for trusted actors."
      : "";
    throw new Error(
      `Failed to check permissions for ${actor}: ${error}${giteaHint}`,
    );
  }
}
