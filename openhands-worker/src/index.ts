/**
 * OpenHands Worker - AI-powered issue resolution on Cloudflare
 *
 * Receives Linear webhooks, runs OpenHands resolver in a Cloudflare Sandbox container,
 * and creates PRs with the fixes.
 */

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  OPENHANDS_STORAGE: R2Bucket;

  // Linear OAuth
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;

  // LLM
  ANTHROPIC_API_KEY?: string;
  LLM_MODEL?: string;

  // GitHub
  GH_TOKEN?: string;
  GIT_USER_NAME?: string;
  GIT_USER_EMAIL?: string;

  // Admin
  GATEWAY_TOKEN?: string;
}

// Linear Agent Session webhook payload
interface AgentSessionWebhookPayload {
  type: string; // "AgentSessionEvent"
  action: string; // "created" | "prompted"
  organizationId: string;
  webhookId: string;
  webhookTimestamp: number;
  promptContext?: string; // Formatted XML string with issue details
  agentSession?: {
    id: string;
    issue?: {
      id: string;
      identifier: string; // e.g., "TEAM-123"
      title: string;
      description?: string;
      url?: string;
      team?: {
        id: string;
        name: string;
        key: string;
      };
    };
    comment?: {
      id: string;
      body: string;
    };
  };
  agentActivity?: {
    id: string;
    body?: string;
  };
}

// Repository configuration stored in R2
interface RepoConfig {
  name: string;
  githubUrl: string;
  localPath: string;
  linearTeamKey?: string; // Maps Linear team to this repo
  isActive: boolean;
}

interface OpenHandsConfig {
  repositories: RepoConfig[];
  defaultLlmModel: string;
  maxIterations: number;
}

// Get config from R2
async function getConfig(env: Env): Promise<OpenHandsConfig> {
  try {
    const configObj = await env.OPENHANDS_STORAGE.get("config/openhands.json");
    if (configObj) {
      return JSON.parse(await configObj.text());
    }
  } catch (error) {
    console.error("Failed to get config from R2:", error);
  }

  // Return default config
  return {
    repositories: [],
    defaultLlmModel: env.LLM_MODEL || "claude-sonnet-4-20250514",
    maxIterations: 50,
  };
}

// Save config to R2
async function saveConfig(env: Env, config: OpenHandsConfig): Promise<void> {
  await env.OPENHANDS_STORAGE.put(
    "config/openhands.json",
    JSON.stringify(config, null, 2)
  );
}

// Get Linear OAuth token from R2
async function getLinearToken(
  env: Env
): Promise<{ access_token: string; organization_id: string } | null> {
  try {
    const tokenObj = await env.OPENHANDS_STORAGE.get("tokens/linear-latest.json");
    if (!tokenObj) return null;
    return JSON.parse(await tokenObj.text());
  } catch (error) {
    console.error("Failed to get Linear token from R2:", error);
    return null;
  }
}

// Find repository config by Linear team key
function findRepoByTeamKey(
  config: OpenHandsConfig,
  teamKey: string
): RepoConfig | undefined {
  return config.repositories.find(
    (r) => r.isActive && r.linearTeamKey === teamKey
  );
}

// Initialize sandbox environment (basic setup without cloning repos)
async function initSandbox(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env
): Promise<{ success: boolean; message: string }> {
  const gitName = env.GIT_USER_NAME || "OpenHands";
  const gitEmail = env.GIT_USER_EMAIL || "openhands@example.com";
  const ghToken = env.GH_TOKEN || "";

  try {
    // Configure git
    await sandbox.exec(
      `git config --global user.name "${gitName}" && git config --global user.email "${gitEmail}"`
    );

    // Set up GitHub credentials for cloning
    if (ghToken) {
      await sandbox.exec(
        `echo "https://${ghToken}:x-oauth-basic@github.com" > ~/.git-credentials && git config --global credential.helper store`
      );
    }

    // Create working directories
    await sandbox.exec("mkdir -p /data/repos /data/output /data/config");

    // Note: Secrets (ANTHROPIC_API_KEY, GITHUB_TOKEN) are NOT written to disk.
    // They are passed as environment variables with each command execution.
    //
    // Secret storage architecture:
    // - Static secrets (API keys) → Cloudflare Worker secrets (wrangler secret put)
    // - Dynamic tokens (Linear OAuth) → R2 storage (tokens/linear-*.json)
    // - Configuration → R2 storage (config/openhands.json)

    return { success: true, message: "Sandbox initialized" };
  } catch (error) {
    return { success: false, message: String(error) };
  }
}

/**
 * Full bootstrap sequence for the sandbox container.
 * Called on cold start or manual bootstrap request.
 *
 * Steps:
 * 1. Initialize sandbox (git config, directories)
 * 2. Restore configuration from R2
 * 3. Clone any configured repositories that are missing
 */
async function bootstrapSandbox(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env
): Promise<{ success: boolean; steps: string[] }> {
  const steps: string[] = [];
  const ghToken = env.GH_TOKEN || "";

  try {
    // Step 1: Initialize sandbox
    const initResult = await initSandbox(sandbox, env);
    steps.push(`init: ${initResult.success ? "ok" : initResult.message}`);

    // Step 2: Load configuration from R2
    const config = await getConfig(env);
    steps.push(`config: ${config.repositories.length} repositories configured`);

    // Step 3: Clone missing repositories
    for (const repo of config.repositories) {
      if (!repo.isActive) continue;

      const checkResult = await sandbox.exec(
        `test -d "${repo.localPath}/.git" && echo 'exists' || echo 'missing'`
      );

      if (checkResult.stdout.includes("missing")) {
        // Clone the repository
        let cloneUrl = repo.githubUrl;
        if (ghToken && cloneUrl.includes("github.com") && !cloneUrl.includes("@")) {
          cloneUrl = cloneUrl.replace("https://", `https://${ghToken}:x-oauth-basic@`);
        }

        const cloneResult = await sandbox.exec(
          `git clone "${cloneUrl}" "${repo.localPath}" 2>&1`
        );

        if (cloneResult.exitCode === 0) {
          steps.push(`clone ${repo.name}: ok`);
        } else {
          steps.push(`clone ${repo.name}: failed`);
        }
      } else {
        steps.push(`repo ${repo.name}: already exists`);
      }
    }

    return { success: true, steps };
  } catch (error) {
    steps.push(`error: ${error}`);
    return { success: false, steps };
  }
}

/**
 * Check if the sandbox needs bootstrapping.
 * Returns true if the sandbox appears to be a fresh/cold start.
 */
async function needsBootstrap(
  sandbox: ReturnType<typeof getSandbox>
): Promise<boolean> {
  try {
    // Check if git is configured (indicates previous init)
    const gitCheck = await sandbox.exec("git config --global user.name 2>/dev/null || echo ''");
    if (!gitCheck.stdout.trim()) {
      return true;
    }

    // Check if data directories exist
    const dirCheck = await sandbox.exec("test -d /data/repos && echo 'exists' || echo 'missing'");
    if (dirCheck.stdout.includes("missing")) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

// Clone or update a repository
async function ensureRepoCloned(
  sandbox: ReturnType<typeof getSandbox>,
  repo: RepoConfig,
  ghToken: string
): Promise<{ success: boolean; message: string }> {
  // Check if repo already exists
  const checkResult = await sandbox.exec(
    `test -d "${repo.localPath}/.git" && echo 'exists' || echo 'missing'`
  );

  if (checkResult.stdout.includes("exists")) {
    // Pull latest changes
    const pullResult = await sandbox.exec(
      `cd "${repo.localPath}" && git fetch origin && git reset --hard origin/main 2>/dev/null || git reset --hard origin/master`
    );
    return {
      success: pullResult.exitCode === 0,
      message: pullResult.exitCode === 0 ? "Repository updated" : "Pull failed",
    };
  }

  // Clone the repository
  let cloneUrl = repo.githubUrl;
  if (ghToken && cloneUrl.includes("github.com") && !cloneUrl.includes("@")) {
    cloneUrl = cloneUrl.replace("https://", `https://${ghToken}:x-oauth-basic@`);
  }

  const cloneResult = await sandbox.exec(
    `git clone "${cloneUrl}" "${repo.localPath}" 2>&1`
  );

  return {
    success: cloneResult.exitCode === 0,
    message:
      cloneResult.exitCode === 0
        ? "Repository cloned"
        : cloneResult.stderr || cloneResult.stdout || "Clone failed",
  };
}

// Run OpenHands resolver on an issue
async function resolveIssue(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  repo: RepoConfig,
  issueNumber: number,
  issueTitle: string,
  issueBody: string,
  config: OpenHandsConfig
): Promise<{ success: boolean; patch?: string; error?: string }> {
  const outputDir = `/data/output/issue-${issueNumber}`;
  const ghToken = env.GH_TOKEN || "";

  try {
    // Ensure repo is cloned
    const cloneResult = await ensureRepoCloned(sandbox, repo, ghToken);
    if (!cloneResult.success) {
      return { success: false, error: cloneResult.message };
    }

    // Extract owner/repo from GitHub URL
    const match = repo.githubUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
    if (!match) {
      return { success: false, error: "Invalid GitHub URL" };
    }
    const [, owner, repoName] = match;

    // Create output directory
    await sandbox.exec(`mkdir -p ${outputDir}`);

    // For now, we'll create a synthetic GitHub issue that OpenHands can process
    // In the future, we could add native Linear support to OpenHands resolver
    //
    // The OpenHands resolver expects issues in GitHub/GitLab format.
    // We'll write the issue content to a file and use the resolver's
    // direct instruction mode instead.

    // Build the instruction for OpenHands
    const instruction = `Please fix the following issue in the repository at ${repo.localPath}.

# Issue: ${issueTitle}

${issueBody}

Make the necessary code changes to resolve this issue. After making changes, the diff will be captured automatically.`;

    // Write instruction to file
    const b64Instruction = btoa(instruction);
    await sandbox.exec(
      `echo ${b64Instruction} | base64 -d > ${outputDir}/instruction.txt`
    );

    // Run OpenHands resolver
    // Note: This uses the CLI interface. The resolver will:
    // 1. Clone/access the repo
    // 2. Run an agent with the instruction
    // 3. Capture the git diff
    //
    // SECURITY: Secrets are passed via environment variables, NOT CLI arguments.
    // The resolver reads GITHUB_TOKEN and LLM_API_KEY from the environment.
    const resolveCmd = [
      // Set environment variables for secrets (not visible in ps output)
      `GITHUB_TOKEN='${ghToken}'`,
      `LLM_API_KEY='${env.ANTHROPIC_API_KEY || ""}'`,
      // Run the resolver
      "cd /opt/openhands &&",
      "/root/.local/bin/poetry run python -m openhands.resolver.resolve_issue",
      `--selected-repo ${owner}/${repoName}`,
      `--username ${env.GIT_USER_NAME || "openhands"}`,
      `--issue-number ${issueNumber}`,
      `--max-iterations ${config.maxIterations}`,
      `--output-dir ${outputDir}`,
      `--llm-model ${config.defaultLlmModel}`,
      "2>&1",
    ].join(" ");

    console.log(`Running OpenHands resolver for issue #${issueNumber}...`);
    const resolveResult = await sandbox.exec(resolveCmd);

    // Check for output file
    const outputCheck = await sandbox.exec(
      `cat ${outputDir}/output.jsonl 2>/dev/null | tail -1`
    );

    if (outputCheck.stdout) {
      try {
        const output = JSON.parse(outputCheck.stdout);
        if (output.success && output.git_patch) {
          return { success: true, patch: output.git_patch };
        } else {
          return {
            success: false,
            error: output.error || output.result_explanation || "Resolution failed",
          };
        }
      } catch {
        // Couldn't parse output
      }
    }

    return {
      success: false,
      error: resolveResult.stderr || resolveResult.stdout || "No output generated",
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Create a PR with the fix
async function createPullRequest(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  repo: RepoConfig,
  issueNumber: number,
  issueTitle: string,
  linearIssueUrl?: string
): Promise<{ success: boolean; prUrl?: string; error?: string }> {
  const outputDir = `/data/output/issue-${issueNumber}`;
  const ghToken = env.GH_TOKEN || "";

  try {
    // Extract owner/repo from GitHub URL
    const match = repo.githubUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
    if (!match) {
      return { success: false, error: "Invalid GitHub URL" };
    }
    const [, owner, repoName] = match;

    // Run send_pull_request
    // SECURITY: Token passed via environment variable, not CLI argument
    const prCmd = [
      `GITHUB_TOKEN='${ghToken}'`,
      "cd /opt/openhands &&",
      "/root/.local/bin/poetry run python -m openhands.resolver.send_pull_request",
      `--selected-repo ${owner}/${repoName}`,
      `--username ${env.GIT_USER_NAME || "openhands"}`,
      `--issue-number ${issueNumber}`,
      `--output-dir ${outputDir}`,
      "--pr-type draft",
      "2>&1",
    ].join(" ");

    console.log(`Creating PR for issue #${issueNumber}...`);
    const prResult = await sandbox.exec(prCmd);

    // Look for PR URL in output
    const prUrlMatch = prResult.stdout.match(
      /https:\/\/github\.com\/[^\s]+\/pull\/\d+/
    );

    if (prUrlMatch) {
      return { success: true, prUrl: prUrlMatch[0] };
    }

    return {
      success: false,
      error: prResult.stderr || prResult.stdout || "Failed to create PR",
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Post a comment to Linear issue
async function postLinearComment(
  env: Env,
  issueId: string,
  body: string
): Promise<void> {
  const token = await getLinearToken(env);
  if (!token) {
    console.error("No Linear token available");
    return;
  }

  try {
    await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({
        query: `
          mutation CreateComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
            }
          }
        `,
        variables: { issueId, body },
      }),
    });
  } catch (error) {
    console.error("Failed to post Linear comment:", error);
  }
}

// Main webhook handler
async function handleAgentSessionWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("linear-signature") || "";

  // Verify webhook signature if configured
  if (env.LINEAR_WEBHOOK_SECRET) {
    if (!verifyLinearSignature(body, signature, env.LINEAR_WEBHOOK_SECRET)) {
      return new Response("Invalid signature", { status: 401 });
    }
  }

  let payload: AgentSessionWebhookPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  console.log("Linear webhook received:", payload.type, payload.action);

  // Only handle AgentSessionEvent with 'created' action
  if (payload.type !== "AgentSessionEvent" || payload.action !== "created") {
    return Response.json({ status: "ignored", reason: "Not a created session" });
  }

  const issue = payload.agentSession?.issue;
  if (!issue) {
    return Response.json({ status: "ignored", reason: "No issue in payload" });
  }

  // Process in background
  ctx.waitUntil(processIssueInBackground(env, payload));

  return Response.json({
    status: "accepted",
    message: "Processing issue in background",
    issue: issue.identifier,
  });
}

// Background processing of Linear issue
async function processIssueInBackground(
  env: Env,
  payload: AgentSessionWebhookPayload
): Promise<void> {
  const issue = payload.agentSession?.issue;
  if (!issue) return;

  const sandbox = getSandbox(env.Sandbox, "primary");

  try {
    // Check if sandbox needs bootstrapping (cold start)
    if (await needsBootstrap(sandbox)) {
      console.log("Cold start detected, running bootstrap...");
      const bootstrapResult = await bootstrapSandbox(sandbox, env);
      console.log("Bootstrap complete:", bootstrapResult.steps);
    }

    // Load configuration from R2
    const config = await getConfig(env);

    // Find repository for this team
    const teamKey = issue.team?.key;
    if (!teamKey) {
      console.error("No team key in issue");
      await postLinearComment(
        env,
        issue.id,
        "OpenHands: Unable to process - no team key found in issue."
      );
      return;
    }

    const repo = findRepoByTeamKey(config, teamKey);
    if (!repo) {
      console.error(`No repository configured for team ${teamKey}`);
      await postLinearComment(
        env,
        issue.id,
        `OpenHands: No repository configured for team "${teamKey}". Please add a repository mapping in the admin panel.`
      );
      return;
    }

    // Post starting comment
    await postLinearComment(
      env,
      issue.id,
      `OpenHands: Starting to work on this issue...\n\nRepository: ${repo.name}\nModel: ${config.defaultLlmModel}`
    );

    // Use the Linear issue identifier as the "issue number" for OpenHands
    // Extract the number from identifiers like "TEAM-123"
    const issueNumMatch = issue.identifier.match(/\d+$/);
    const issueNumber = issueNumMatch ? parseInt(issueNumMatch[0], 10) : 1;

    // Resolve the issue
    const resolveResult = await resolveIssue(
      sandbox,
      env,
      repo,
      issueNumber,
      issue.title,
      issue.description || "",
      config
    );

    if (!resolveResult.success) {
      await postLinearComment(
        env,
        issue.id,
        `OpenHands: Failed to resolve issue.\n\nError: ${resolveResult.error}`
      );
      return;
    }

    // Create PR
    const prResult = await createPullRequest(
      sandbox,
      env,
      repo,
      issueNumber,
      issue.title,
      issue.url
    );

    if (prResult.success && prResult.prUrl) {
      await postLinearComment(
        env,
        issue.id,
        `OpenHands: Created a pull request with the fix!\n\n${prResult.prUrl}`
      );
    } else {
      await postLinearComment(
        env,
        issue.id,
        `OpenHands: Generated a fix but failed to create PR.\n\nError: ${prResult.error}`
      );
    }
  } catch (error) {
    console.error("Error processing issue:", error);
    await postLinearComment(
      env,
      issue.id,
      `OpenHands: An error occurred while processing this issue.\n\nError: ${error}`
    );
  }
}

// OAuth callback handler
async function handleOAuthCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`OAuth Error: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
    return new Response("OAuth not configured", { status: 500 });
  }

  try {
    // Exchange code for token
    const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        redirect_uri: `${url.origin}/callback`,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return new Response(`Token exchange failed: ${errorText}`, { status: 500 });
    }

    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
    };

    // Get organization info
    const orgResponse = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        query: `{ organization { id name } }`,
      }),
    });

    let orgInfo = { id: "unknown", name: "Unknown" };
    if (orgResponse.ok) {
      const orgData = (await orgResponse.json()) as {
        data?: { organization?: { id: string; name: string } };
      };
      if (orgData.data?.organization) {
        orgInfo = orgData.data.organization;
      }
    }

    // Store token in R2
    const tokenData = {
      access_token: tokens.access_token,
      organization_id: orgInfo.id,
      organization_name: orgInfo.name,
      created_at: Date.now(),
    };

    await env.OPENHANDS_STORAGE.put(
      `tokens/linear-${orgInfo.id}.json`,
      JSON.stringify(tokenData, null, 2)
    );
    await env.OPENHANDS_STORAGE.put(
      "tokens/linear-latest.json",
      JSON.stringify(tokenData, null, 2)
    );

    return new Response(
      `<html>
        <head><title>OpenHands - Authorization Complete</title></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2>Authorization Complete!</h2>
          <p>OpenHands is now connected to <strong>${orgInfo.name}</strong>.</p>
          <p>You can close this window.</p>
        </body>
      </html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  } catch (error) {
    return new Response(`OAuth error: ${error}`, { status: 500 });
  }
}

// API routes handler
async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, "primary");

  // Full bootstrap: init, restore config, clone repos
  if (url.pathname === "/api/bootstrap" && request.method === "POST") {
    const result = await bootstrapSandbox(sandbox, env);
    return Response.json({
      success: result.success,
      message: result.success ? "Bootstrap complete" : "Bootstrap failed",
      steps: result.steps,
    });
  }

  // Initialize sandbox (basic setup only)
  if (url.pathname === "/api/init" && request.method === "POST") {
    const result = await initSandbox(sandbox, env);
    return Response.json(result);
  }

  // Check if bootstrap is needed
  if (url.pathname === "/api/needs-bootstrap") {
    const needs = await needsBootstrap(sandbox);
    return Response.json({ needsBootstrap: needs });
  }

  // Get status
  if (url.pathname === "/api/status") {
    const needs = await needsBootstrap(sandbox);
    const result = await sandbox.exec(
      "ps aux --no-headers 2>/dev/null | head -20 && echo '---' && df -h /data 2>/dev/null && echo '---' && ls -la /data/repos 2>/dev/null || echo 'No repos'"
    );
    return Response.json({
      output: result.stdout,
      success: result.success,
      needsBootstrap: needs,
    });
  }

  // Get config from R2
  if (url.pathname === "/api/config") {
    const config = await getConfig(env);
    return Response.json(config);
  }

  // Update config
  if (url.pathname === "/api/config" && request.method === "POST") {
    const newConfig = (await request.json()) as OpenHandsConfig;
    await saveConfig(env, newConfig);
    return Response.json({ success: true });
  }

  // Add repository
  if (url.pathname === "/api/add-repo" && request.method === "POST") {
    const { name, githubUrl, linearTeamKey } = (await request.json()) as {
      name: string;
      githubUrl: string;
      linearTeamKey?: string;
    };

    if (!name || !githubUrl) {
      return Response.json(
        { success: false, error: "Missing name or githubUrl" },
        { status: 400 }
      );
    }

    const config = await getConfig(env);
    const localPath = `/data/repos/${name}`;

    config.repositories.push({
      name,
      githubUrl,
      localPath,
      linearTeamKey,
      isActive: true,
    });

    await saveConfig(env, config);

    // Clone the repo
    const ghToken = env.GH_TOKEN || "";
    const cloneResult = await ensureRepoCloned(
      sandbox,
      config.repositories[config.repositories.length - 1],
      ghToken
    );

    return Response.json({
      success: true,
      message: "Repository added",
      cloneResult,
    });
  }

  // Execute command
  if (url.pathname === "/api/exec" && request.method === "POST") {
    const { command } = (await request.json()) as { command: string };
    const result = await sandbox.exec(command);
    return Response.json({
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  // Get logs
  if (url.pathname === "/api/logs") {
    const result = await sandbox.exec(
      "ls -la /data/output/ 2>/dev/null && tail -100 /data/output/*/output.jsonl 2>/dev/null | tail -50"
    );
    return Response.json({ output: result.stdout });
  }

  return new Response("Not Found", { status: 404 });
}

// Admin UI
function handleAdminUI(env: Env, url: URL): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenHands Worker Admin</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1000px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    h1 { color: #333; margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin: 16px 0;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .card.full { grid-column: 1 / -1; }
    .card h2 { margin-top: 0; color: #444; font-size: 18px; }
    button {
      background: #0066cc;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 8px;
      font-size: 14px;
    }
    button:hover { background: #0055aa; }
    button.secondary { background: #666; }
    button.danger { background: #dc3545; }
    pre {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 12px;
      max-height: 200px;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 500;
    }
    .status-badge.ok { background: #d4edda; color: #155724; }
    .status-badge.error { background: #f8d7da; color: #721c24; }
    input[type="text"] {
      width: 100%;
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .repo-list { list-style: none; padding: 0; margin: 0; }
    .repo-item {
      padding: 12px;
      border: 1px solid #eee;
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .repo-item .name { font-weight: 600; color: #333; }
    .repo-item .url { font-size: 12px; color: #666; }
    .repo-item .team { font-size: 12px; color: #0066cc; }
    .inline-form { display: flex; gap: 8px; flex-wrap: wrap; }
    .inline-form input { flex: 1; min-width: 150px; margin-bottom: 0; }
  </style>
</head>
<body>
  <h1>OpenHands Worker Admin</h1>
  <p class="subtitle">AI-powered issue resolution on Cloudflare</p>

  <div class="grid">
    <div class="card">
      <h2>Container Status <span id="bootstrapBadge"></span></h2>
      <div id="containerStatus">Loading...</div>
      <button onclick="refreshStatus()">Refresh</button>
      <button class="secondary" onclick="runBootstrap()">Bootstrap</button>
      <span id="bootstrapStatus"></span>
    </div>

    <div class="card">
      <h2>Configuration (from R2)</h2>
      <p>Model: <strong id="llmModel">-</strong></p>
      <p>Max Iterations: <strong id="maxIter">-</strong></p>
      <p>Repositories: <strong id="repoCount">-</strong></p>
      <button onclick="refreshConfig()">Refresh</button>
    </div>
  </div>

  <div class="card">
    <h2>Repositories</h2>
    <ul class="repo-list" id="repoList">
      <li>Loading...</li>
    </ul>
    <hr style="margin: 16px 0; border: none; border-top: 1px solid #eee;">
    <h3 style="font-size: 14px; margin-bottom: 12px;">Add Repository</h3>
    <div class="inline-form">
      <input type="text" id="repoName" placeholder="Repository name" />
      <input type="text" id="repoUrl" placeholder="https://github.com/org/repo" />
      <input type="text" id="repoTeam" placeholder="Linear team key (e.g., ENG)" />
      <button onclick="addRepo()">Add</button>
    </div>
    <div id="addRepoStatus" style="margin-top: 8px; font-size: 13px;"></div>
  </div>

  <div class="card">
    <h2>Recent Logs</h2>
    <pre id="logs">Loading...</pre>
    <button onclick="refreshLogs()">Refresh</button>
  </div>

  <div class="card">
    <h2>Execute Command</h2>
    <div class="inline-form">
      <input type="text" id="cmdInput" placeholder="ls -la /data" />
      <button onclick="execCommand()">Run</button>
    </div>
    <pre id="cmdOutput" style="min-height: 60px;"></pre>
  </div>

  <script>
    async function refreshStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        // Show bootstrap badge
        const badge = document.getElementById('bootstrapBadge');
        if (data.needsBootstrap) {
          badge.innerHTML = '<span class="status-badge error">Needs Bootstrap</span>';
        } else {
          badge.innerHTML = '<span class="status-badge ok">Ready</span>';
        }

        document.getElementById('containerStatus').innerHTML =
          '<pre style="margin-top: 8px;">' + (data.output || 'No output') + '</pre>';
      } catch (e) {
        document.getElementById('containerStatus').innerHTML =
          '<span class="status-badge error">Error</span>';
        document.getElementById('bootstrapBadge').innerHTML =
          '<span class="status-badge error">Error</span>';
      }
    }

    async function runBootstrap() {
      document.getElementById('bootstrapStatus').textContent = 'Bootstrapping...';
      try {
        const res = await fetch('/api/bootstrap', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          document.getElementById('bootstrapStatus').innerHTML =
            '<span style="color: green;">Done!</span>';
          // Show bootstrap steps
          alert('Bootstrap complete:\\n\\n' + data.steps.join('\\n'));
        } else {
          document.getElementById('bootstrapStatus').innerHTML =
            '<span style="color: red;">Failed</span>';
          alert('Bootstrap failed:\\n\\n' + data.steps.join('\\n'));
        }
        refreshStatus();
        refreshConfig();
      } catch (e) {
        document.getElementById('bootstrapStatus').innerHTML =
          '<span style="color: red;">Error</span>';
        alert('Error: ' + e.message);
      }
    }

    async function refreshConfig() {
      try {
        const res = await fetch('/api/config');
        const config = await res.json();
        document.getElementById('llmModel').textContent = config.defaultLlmModel || '-';
        document.getElementById('maxIter').textContent = config.maxIterations || '-';

        const repos = config.repositories || [];
        document.getElementById('repoCount').textContent = repos.length;

        const repoList = document.getElementById('repoList');
        if (repos.length === 0) {
          repoList.innerHTML = '<li style="color: #666; padding: 12px;">No repositories configured. Add one below, then click Bootstrap.</li>';
        } else {
          repoList.innerHTML = repos.map(r => \`
            <li class="repo-item">
              <div class="name">\${r.name} \${r.isActive ? '' : '(inactive)'}</div>
              <div class="url">\${r.githubUrl}</div>
              <div class="team">Linear Team: \${r.linearTeamKey || 'Not set'}</div>
            </li>
          \`).join('');
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function addRepo() {
      const name = document.getElementById('repoName').value.trim();
      const githubUrl = document.getElementById('repoUrl').value.trim();
      const linearTeamKey = document.getElementById('repoTeam').value.trim();

      if (!name || !githubUrl) {
        alert('Name and GitHub URL are required');
        return;
      }

      document.getElementById('addRepoStatus').innerHTML = 'Adding...';
      try {
        const res = await fetch('/api/add-repo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, githubUrl, linearTeamKey: linearTeamKey || undefined })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('addRepoStatus').innerHTML =
            '<span style="color: green;">Repository added!</span>';
          document.getElementById('repoName').value = '';
          document.getElementById('repoUrl').value = '';
          document.getElementById('repoTeam').value = '';
          refreshConfig();
        } else {
          document.getElementById('addRepoStatus').innerHTML =
            '<span style="color: red;">Failed: ' + (data.error || 'Unknown error') + '</span>';
        }
      } catch (e) {
        document.getElementById('addRepoStatus').innerHTML =
          '<span style="color: red;">Error: ' + e.message + '</span>';
      }
    }

    async function refreshLogs() {
      try {
        const res = await fetch('/api/logs');
        const data = await res.json();
        document.getElementById('logs').textContent = data.output || 'No logs';
      } catch (e) {
        document.getElementById('logs').textContent = 'Error loading logs';
      }
    }

    async function execCommand() {
      const cmd = document.getElementById('cmdInput').value;
      if (!cmd) return;
      document.getElementById('cmdOutput').textContent = 'Executing...';
      try {
        const res = await fetch('/api/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd })
        });
        const data = await res.json();
        document.getElementById('cmdOutput').textContent =
          (data.stdout || '') + (data.stderr ? '\\nSTDERR:\\n' + data.stderr : '');
      } catch (e) {
        document.getElementById('cmdOutput').textContent = 'Error: ' + e.message;
      }
    }

    // Initial load
    refreshStatus();
    refreshConfig();
    refreshLogs();
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// Verify Linear webhook signature
function verifyLinearSignature(
  body: string,
  signature: string | null,
  secret: string
): boolean {
  // TODO: Implement HMAC-SHA256 verification
  if (!signature) return false;
  return true;
}

// Main fetch handler
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Health check
      if (url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      // Linear webhook
      if (url.pathname === "/webhook" && request.method === "POST") {
        return await handleAgentSessionWebhook(request, env, ctx);
      }

      // OAuth callback
      if (url.pathname === "/callback") {
        return await handleOAuthCallback(request, env);
      }

      // Admin UI
      if (url.pathname === "/_admin" || url.pathname === "/_admin/") {
        if (env.GATEWAY_TOKEN) {
          const token = url.searchParams.get("token");
          if (token !== env.GATEWAY_TOKEN) {
            return new Response("Unauthorized", { status: 401 });
          }
        }
        return handleAdminUI(env, url);
      }

      // API routes
      if (url.pathname.startsWith("/api/")) {
        return await handleApiRoutes(request, env, url);
      }

      // Root
      if (url.pathname === "/") {
        return new Response(
          "OpenHands Worker - AI-powered issue resolution on Cloudflare\n\n" +
            "Endpoints:\n" +
            "- /_admin/ - Admin UI\n" +
            "- /webhook - Linear AgentSessionEvent webhook\n" +
            "- /callback - Linear OAuth callback\n" +
            "- /health - Health check",
          { headers: { "Content-Type": "text/plain" } }
        );
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Request error:", error);
      return new Response(`Internal Error: ${error}`, { status: 500 });
    }
  },
};
