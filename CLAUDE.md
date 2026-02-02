# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenHands is an AI-driven software development platform with a Python backend (agentic core + application server), React frontend, and multiple runtime implementations (Docker, Kubernetes, cloud-based). It supports various LLMs including Claude, GPT, and Gemini.

## Common Commands

### Build and Run
```bash
make build              # Full build: installs dependencies, sets up environment
make run                # Runs both backend and frontend
make start-backend      # Backend server on port 3000
make start-frontend     # Frontend server on port 3001
make setup-config       # Interactive setup for LLM API keys
```

### Testing
```bash
# Backend (Python)
poetry run pytest ./tests/unit/test_*.py                    # All unit tests
poetry run pytest ./tests/unit/test_xxx.py::test_func       # Single test

# Frontend (from frontend/ directory)
npm run test                    # Run all tests
npm run test -- -t "TestName"   # Run specific test
npm run test:coverage           # With coverage
```

### Linting
```bash
make lint               # All linters (frontend + backend)
make lint-backend       # Pre-commit hooks on Python code
make lint-frontend      # ESLint, Prettier, TypeScript checks
```

### Frontend Development
```bash
cd frontend
npm install && npm run dev      # Start dev server with mocking
npm run build                   # Production build
npm run typecheck               # TypeScript checking
npm run make-i18n               # Generate i18n declarations
```

## Architecture

### Directory Structure
```
openhands/              # Python backend
├── agenthub/          # Agent implementations (CodeAct, Browsing, etc.)
├── app_server/        # V1 application server (current)
├── server/            # V0 server (DEPRECATED - removal April 2026)
├── runtime/           # Code execution sandboxes (Docker, K8s, cloud)
├── llm/               # LLM routing and integration
├── core/              # Core configuration and schemas
├── storage/           # Database models and persistence
├── events/            # Event streaming system
└── resolver/          # Code resolution and patching

frontend/               # React application
├── src/
│   ├── api/           # API client layer
│   ├── components/    # UI components (features/, layout/, modals/, ui/)
│   ├── hooks/         # TanStack Query wrappers (query/, mutation/)
│   ├── state/         # Redux state management
│   └── routes/        # File-based routing
└── __tests__/         # Vitest tests

enterprise/             # Enterprise features (source-available, Polyform license)
├── server/            # Enterprise API endpoints
├── integrations/      # GitHub, GitLab, Jira, Linear, Slack
└── migrations/        # Alembic database migrations
```

### V0 vs V1 Architecture
- **V0 (Legacy)**: `openhands/server/listen.py` - Being deprecated April 2026
- **V1 (Current)**: `openhands/app_server/` - Uses OpenHands Software Agent SDK, preferred for new work

### Core Loop (Agent Execution)
```python
while True:
    prompt = agent.generate_prompt(state)
    response = llm.completion(prompt)
    action = agent.parse_response(response)
    observation = runtime.run(action)
    state = state.update(action, observation)
```

### Event-Driven Communication
EventStream is the backbone for all communication. Agent, Runtime, and Frontend communicate through events via publish/subscribe patterns.

### Frontend Data Flow
```
UI Components → TanStack Query Hooks → API Client Layer → Backend API
```
- Queries in `frontend/src/hooks/query/`
- Mutations in `frontend/src/hooks/mutation/`
- API client in `frontend/src/api/`

## Key Patterns

### Frontend Settings Patterns
1. **Immediate Save**: For entity resources (API Keys, MCP Servers) - no "Save Changes" button
2. **Manual Save**: For form-based settings - uses `isDirty` tracking with bulk saves

### Action Handling
- Actions defined in `frontend/src/types/action-type.ts`
- Handled actions in `HANDLED_ACTIONS` array in `frontend/src/state/chat-slice.ts`
- Translation keys: `ACTION_MESSAGE$ACTION_NAME`

### Adding New LLM Models (5 locations required)
1. `frontend/src/utils/verified-models.ts` - `VERIFIED_MODELS` arrays
2. `openhands/cli/utils.py` - `VERIFIED_*_MODELS`
3. `openhands/utils/llm.py` - `openhands_models` (CRITICAL)
4. `openhands/llm/llm.py` - Feature arrays
5. Run linting and frontend build to validate

### Microagents
- Public: `microagents/`
- Repo-specific: `.openhands/microagents/`
- Markdown files with optional YAML frontmatter
- With triggers: loaded when user message matches keywords
- Without triggers: always loaded into context

## Development Requirements

- Python 3.12+
- Node.js 22.x+
- Poetry >= 1.8
- Docker (unless `INSTALL_DOCKER=0`)

**Pre-commit hooks are mandatory**: Run `make install-pre-commit-hooks` before making changes.

## Tech Stack

**Backend**: FastAPI, SQLAlchemy (async), Pydantic, LiteLLM, Docker/Kubernetes SDKs
**Frontend**: React 19, Vite, TypeScript, Redux, TanStack Query, Tailwind CSS, Monaco Editor
**Testing**: pytest (backend), Vitest + MSW (frontend), Playwright (e2e)
**Quality**: Ruff + Mypy (Python), ESLint + Prettier (TypeScript)
