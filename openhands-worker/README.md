# OpenHands Worker

Run [OpenHands](https://github.com/All-Hands-AI/OpenHands) (AI-powered software development platform) on Cloudflare's edge infrastructure using the Sandbox SDK.

## Why OpenHands Worker?

Instead of running OpenHands on a local machine or VPS:

- **No hardware required** - Runs in Cloudflare Sandbox containers
- **Always on** - Auto-bootstraps on first webhook after cold start
- **Global edge** - Low latency webhook processing worldwide
- **Persistent storage** - R2 backup of config and OAuth tokens
- **Secure** - Webhook signature verification protects endpoints
- **Linear integration** - Delegates issues to OpenHands AI agent

## Requirements

- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5/month) - Required for Sandbox
- [Anthropic API key](https://console.anthropic.com/) - For Claude
- [GitHub PAT](https://github.com/settings/tokens) - For PR creation
- Linear workspace with admin access

## Quick Start

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/All-Hands-AI/OpenHands&wrangler-file=openhands-worker/wrangler.jsonc)

Or manually:

```bash
# Clone the OpenHands repository
git clone https://github.com/All-Hands-AI/OpenHands.git
cd OpenHands

# Install worker dependencies
cd openhands-worker
npm install

# Deploy (requires Docker running for container build)
npm run deploy
```

> **Important**: The deployment must be run from the `openhands-worker/` directory, but wrangler will build the Docker container from the repository root. This is necessary because the container needs access to the `openhands/` Python package.

After deployment, note your worker URL (e.g., `https://openhands-worker.your-subdomain.workers.dev`).

## Connecting to Linear

OpenHands Worker uses Linear's **OAuth Applications** with **Agent Session Events**.

### Step 1: Create a Linear OAuth Application

1. Go to **Linear Settings → API → OAuth Applications**
2. Click **Create new OAuth Application**
3. Fill in:
   - **Name**: `OpenHands` (this is how it appears in Linear)
   - **Callback URL**: `https://your-worker.workers.dev/callback`
4. Enable these toggles:
   - ✅ **Client credentials**
   - ✅ **Webhooks**
5. Configure webhook settings:
   - **Webhook URL**: `https://your-worker.workers.dev/webhook`
   - **App events**: ✅ **Agent session events** (required - makes OpenHands appear as an agent)
6. Save and copy these credentials:
   - **Client ID**
   - **Client Secret** (only shown once!)
   - **Webhook Signing Secret** (from webhook settings)

### Step 2: Create R2 Bucket

```bash
wrangler r2 bucket create openhands-worker-data
```

### Step 3: Set Secrets

```bash
# Linear OAuth credentials
wrangler secret put LINEAR_CLIENT_ID
wrangler secret put LINEAR_CLIENT_SECRET
wrangler secret put LINEAR_WEBHOOK_SECRET

# Claude API
wrangler secret put ANTHROPIC_API_KEY

# GitHub (for PR creation)
wrangler secret put GH_TOKEN
wrangler secret put GIT_USER_NAME
wrangler secret put GIT_USER_EMAIL

# Admin UI protection (recommended)
wrangler secret put GATEWAY_TOKEN
```

### Step 4: Authorize with Linear

Visit the authorization URL (replace with your values):

```
https://linear.app/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=https://YOUR_WORKER.workers.dev/callback&response_type=code&scope=write,app:assignable,app:mentionable&actor=app
```

You should see "Authorization Complete!" with your organization name.

### Step 5: Add a Repository

Open the Admin UI at `https://your-worker.workers.dev/_admin/?token=YOUR_GATEWAY_TOKEN` and use the "Add Repository" form.

You need to map each repository to a Linear team key (e.g., "ENG", "PROD"). When issues from that team are delegated to OpenHands, they'll be processed against the mapped repository.

### Step 6: Delegate an Issue

In Linear, open any issue and click **Delegate to... → OpenHands**. OpenHands will process the issue and create a PR with the fix.

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LINEAR                                          │
│  ┌──────────┐    ┌─────────────────┐                                        │
│  │  Issue   │───▶│ Delegate to...  │                                        │
│  │ TEAM-123 │    │   → OpenHands   │                                        │
│  └──────────┘    └────────┬────────┘                                        │
└───────────────────────────┼─────────────────────────────────────────────────┘
                            │ AgentSessionEvent webhook
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CLOUDFLARE WORKER                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │   Webhook    │───▶│  Find Repo   │───▶│  Bootstrap   │                   │
│  │   Handler    │    │  by Team Key │    │  if needed   │                   │
│  └──────────────┘    └──────────────┘    └──────┬───────┘                   │
└─────────────────────────────────────────────────┼───────────────────────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CLOUDFLARE SANDBOX                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │   Clone/     │───▶│   OpenHands  │───▶│   Create     │                   │
│  │   Pull Repo  │    │   Resolver   │    │   PR         │                   │
│  └──────────────┘    └──────────────┘    └──────┬───────┘                   │
└─────────────────────────────────────────────────┼───────────────────────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GITHUB                                          │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  PR #42: Fix issue TEAM-123                                   │           │
│  │  ────────────────────────────────────────────────────────────│           │
│  │  This PR fixes the issue described in Linear.                 │           │
│  └──────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. User **delegates** an issue to OpenHands in Linear
2. Linear sends an `AgentSessionEvent` webhook to your worker
3. Worker finds the repository mapped to the issue's team key
4. If container is cold, **auto-bootstraps** (restores config from R2, initializes environment)
5. Worker clones/updates the repository in the Sandbox container
6. OpenHands resolver runs with the issue description as input
7. Resolver generates a git patch with the fix
8. Worker creates a draft PR on GitHub
9. Worker posts a comment on the Linear issue with the PR link

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/webhook` | POST | Linear AgentSessionEvent receiver (auto-bootstraps) |
| `/callback` | GET | Linear OAuth callback |
| `/api/init` | POST | Initialize sandbox environment |
| `/api/status` | GET | Sandbox process and disk status |
| `/api/config` | GET | Current configuration |
| `/api/config` | POST | Update configuration |
| `/api/add-repo` | POST | Add repository (`{name, githubUrl, linearTeamKey}`) |
| `/api/exec` | POST | Execute command in sandbox |
| `/api/logs` | GET | View recent resolver logs |
| `/_admin/` | GET | Admin UI (requires `?token=GATEWAY_TOKEN`) |

## Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `LINEAR_CLIENT_ID` | Yes | Linear OAuth Application client ID |
| `LINEAR_CLIENT_SECRET` | Yes | Linear OAuth Application client secret |
| `LINEAR_WEBHOOK_SECRET` | Yes | Linear webhook signing secret |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `LLM_MODEL` | No | LLM model (default: `claude-sonnet-4-20250514`) |
| `GH_TOKEN` | Yes | GitHub PAT for PR creation |
| `GIT_USER_NAME` | Yes | Git commit author name |
| `GIT_USER_EMAIL` | Yes | Git commit author email |
| `GATEWAY_TOKEN` | Recommended | Token to protect Admin UI access |

### Where to Get Each Secret

#### LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET / LINEAR_WEBHOOK_SECRET

From your Linear OAuth Application (see [Step 1](#step-1-create-a-linear-oauth-application)).

#### ANTHROPIC_API_KEY

1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Navigate to **API Keys**
3. Click **Create Key**
4. Copy the key (starts with `sk-ant-`)

#### GH_TOKEN

1. Go to [GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token**
3. Under **Repository access**, select the repos OpenHands should access
4. Under **Permissions → Repository permissions**, enable:
   - **Contents**: Read and write
   - **Pull requests**: Read and write
   - **Metadata**: Read-only
5. Click **Generate token**

## Configuration

### Repository Mapping

Each repository mapping includes:

| Field | Description |
|-------|-------------|
| `name` | Display name for the repository |
| `githubUrl` | GitHub clone URL (HTTPS format) |
| `localPath` | Path inside the container (auto-generated) |
| `linearTeamKey` | Linear team key (e.g., "ENG", "PROD") |
| `isActive` | Whether to process issues for this repo |

Example configuration:
```json
{
  "repositories": [
    {
      "name": "backend",
      "githubUrl": "https://github.com/myorg/backend",
      "localPath": "/data/repos/backend",
      "linearTeamKey": "ENG",
      "isActive": true
    }
  ],
  "defaultLlmModel": "claude-sonnet-4-20250514",
  "maxIterations": 50
}
```

## Development

```bash
# Create .dev.vars with secrets
cp .env.example .dev.vars

# Start dev server (requires Docker)
npm run dev

# Type check
npm run typecheck

# Run tests
npm test

# View production logs
npm run tail
```

## Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- src/__tests__/webhook.test.ts
```

## OpenHands Integration

This worker uses the **OpenHands resolver** module to process issues and create PRs. Understanding this integration is key to configuring the worker correctly.

### How It Works

The OpenHands resolver (`openhands.resolver`) is a CLI tool that:
1. Takes an issue description as input
2. Runs an AI agent (CodeAct) to analyze and fix the issue
3. Captures the git diff of changes made
4. Creates a pull request with the fix

The worker invokes the resolver via CLI commands inside the Sandbox container:

```bash
# Resolve an issue (generates a patch)
python -m openhands.resolver.resolve_issue \
  --selected-repo owner/repo \
  --issue-number 123 \
  --token $GITHUB_TOKEN \
  --llm-model claude-sonnet-4-20250514 \
  --max-iterations 50

# Create a PR from the resolved issue
python -m openhands.resolver.send_pull_request \
  --selected-repo owner/repo \
  --issue-number 123 \
  --token $GITHUB_TOKEN \
  --pr-type draft
```

### Building the Container

The Dockerfile must be built from the **OpenHands repository root** (not from the `openhands-worker/` directory):

```bash
# From the OpenHands repo root
cd /path/to/OpenHands
docker build -f openhands-worker/Dockerfile -t openhands-worker .

# Or when deploying with wrangler (automatic)
cd openhands-worker
npm run deploy  # wrangler builds from repo root automatically
```

The container includes:
- Python 3.12 with the full OpenHands package
- Git and GitHub CLI for repository operations
- Wrapper scripts (`openhands-resolve`, `openhands-pr`) for easy CLI access

### Linear → GitHub Translation

Since the OpenHands resolver natively supports GitHub/GitLab issues but not Linear, the worker translates Linear issues:

1. **Linear issue delegated** → Worker receives webhook
2. **Extract issue details** → Title, description, team key
3. **Find mapped repository** → Match team key to GitHub repo
4. **Build instruction** → Convert Linear issue to resolver instruction format
5. **Run resolver** → OpenHands processes the instruction
6. **Create PR** → Worker creates a draft PR on GitHub
7. **Post comment** → Worker comments on Linear issue with PR link

### Environment Variables for OpenHands

The resolver uses these environment variables (set automatically by the worker):

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for Claude (required) |
| `GITHUB_TOKEN` | GitHub PAT for repo access and PR creation |
| `GIT_USERNAME` | Git commit author name |
| `LLM_MODEL` | Model to use (default: `claude-sonnet-4-20250514`) |

### Supported LLM Models

The resolver supports any model available through LiteLLM. Common options:

- `claude-sonnet-4-20250514` (default, recommended)
- `claude-opus-4-20250514` (more capable, slower)
- `gpt-4o` (requires `OPENAI_API_KEY`)
- `gpt-4-turbo` (requires `OPENAI_API_KEY`)

To use a different model, set the `LLM_MODEL` secret:

```bash
wrangler secret put LLM_MODEL
# Enter: gpt-4o
```

### Resolver Output

The resolver writes results to `/data/output/issue-{number}/output.jsonl`:

```json
{
  "issue": {"owner": "org", "repo": "repo", "number": 123},
  "success": true,
  "git_patch": "diff --git a/file.py b/file.py\n...",
  "result_explanation": "Fixed the bug by updating the validation logic"
}
```

The worker reads this output to determine success and extract the patch for PR creation.

## Architecture

```
openhands-worker/
├── src/
│   ├── index.ts              # Main worker entry point
│   └── __tests__/            # Test files
├── Dockerfile                # Sandbox container definition
├── wrangler.jsonc            # Cloudflare Workers config
├── package.json              # Dependencies
├── tsconfig.json             # TypeScript config
└── vitest.config.ts          # Test configuration
```

### Container Environment

The Sandbox container includes:
- Python 3.12 with Poetry
- OpenHands resolver module (installed from source)
- Git and GitHub CLI
- Pre-configured wrapper scripts (`openhands-resolve`, `openhands-pr`)

### Storage & Persistence

The worker uses Cloudflare R2 for persistent storage across container restarts:

| Data | R2 Path | Purpose |
|------|---------|---------|
| Configuration | `config/openhands.json` | Repository mappings, model settings, max iterations |
| Linear OAuth tokens | `tokens/linear-*.json` | OAuth access tokens for Linear API |

**What happens on cold start:**

1. Webhook arrives at the worker
2. Worker checks if sandbox needs bootstrapping (git not configured, dirs missing)
3. If bootstrap needed:
   - Initialize git configuration
   - Create working directories
   - Load configuration from R2
   - Clone all configured repositories
4. Process the webhook

**Secrets are NOT stored in R2** - they come from Cloudflare Worker secrets (`wrangler secret put`) and are passed as environment variables to each command.

### Durable Objects

- **Sandbox**: Manages the Cloudflare Sandbox container state

## Troubleshooting

### OpenHands doesn't appear in Linear's "Delegate to..." menu

- Verify **Agent session events** is enabled in your OAuth Application
- Ensure you completed the OAuth authorization flow
- Check that the webhook URL is correct and responding

### First webhook fails / timeout

The container may have been cold. OpenHands Worker auto-bootstraps on webhook, but the first request after a cold start may take longer. The webhook returns immediately with "accepted" status while processing continues in the background.

### Webhooks aren't being received

- Check webhook URL matches your worker: `https://your-worker.workers.dev/webhook`
- Verify `LINEAR_WEBHOOK_SECRET` matches the signing secret in Linear
- Check worker logs: `npm run tail`

### Repository cloning fails

- Verify `GH_TOKEN` has access to the repository
- Check the repository URL is correct (HTTPS format)
- View logs in Admin UI for detailed error messages

### No repository found for team

- Ensure you've added a repository mapping with the correct `linearTeamKey`
- The team key must match exactly (case-sensitive)

## Limitations

- OpenHands resolver currently only supports GitHub/GitLab issue formats natively. Linear issues are translated to instruction-based resolution.
- Container cold starts can take 30-60 seconds.
- Maximum execution time is limited by Cloudflare Workers limits.
- One repository per Linear team key (no multi-repo support per team).

## Future Improvements

- [ ] Native Linear issue handler in OpenHands resolver
- [ ] Support for PR review feedback loops
- [ ] Multi-repo support per team
- [ ] Metrics and monitoring dashboard
- [ ] HMAC-SHA256 webhook signature verification

## License

MIT
