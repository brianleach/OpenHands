# OpenHands Worker Sandbox Container
# Based on Cloudflare Sandbox base image with Python 3.12+
#
# This container runs the OpenHands resolver to process issues and create PRs.
#
# Build context: Repository root (OpenHands/)
# The wrangler.jsonc sets context: ".." so paths are relative to repo root.

FROM docker.io/cloudflare/sandbox:0.7.0

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3.12 \
    python3.12-venv \
    python3-pip \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (for PR creation and repo operations)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install pipx and poetry
RUN python3.12 -m pip install --break-system-packages pipx \
    && pipx ensurepath \
    && pipx install poetry

# Create working directories
RUN mkdir -p /root/.openhands /data/repos /data/output /var/log

# =============================================================================
# Install OpenHands from source
# Build context is the repo root, so we can copy the full package
# =============================================================================
WORKDIR /opt/openhands

# Copy dependency files first for better caching
COPY pyproject.toml poetry.lock ./

# Copy the OpenHands package
COPY openhands/ ./openhands/

# Install dependencies (main only, no dev dependencies, no root package)
RUN /root/.local/bin/poetry install --only main --no-interaction --no-root

# =============================================================================
# Create wrapper scripts for running OpenHands resolver
# These provide convenient CLI access to the resolver module
# =============================================================================
RUN printf '#!/bin/bash\ncd /opt/openhands\n/root/.local/bin/poetry run python -m openhands.resolver.resolve_issue "$@"\n' > /usr/local/bin/openhands-resolve \
    && chmod +x /usr/local/bin/openhands-resolve

RUN printf '#!/bin/bash\ncd /opt/openhands\n/root/.local/bin/poetry run python -m openhands.resolver.send_pull_request "$@"\n' > /usr/local/bin/openhands-pr \
    && chmod +x /usr/local/bin/openhands-pr

# Set environment
ENV PATH="/root/.local/bin:$PATH"
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/opt/openhands

# OpenHands resolver configuration defaults
# These can be overridden via environment variables at runtime
ENV LLM_MODEL="claude-sonnet-4-20250514"
ENV MAX_ITERATIONS="50"

WORKDIR /data
