/**
 * Tests for OpenHands Worker
 *
 * These tests verify the worker's request handling, webhook processing,
 * and configuration management without requiring actual Cloudflare infrastructure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Cloudflare Sandbox module
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(() => ({
    exec: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    }),
  })),
  Sandbox: class {},
}));

// Import after mocking
import { getSandbox } from "@cloudflare/sandbox";

// Helper to create mock environment
function createMockEnv() {
  return {
    Sandbox: {
      idFromName: vi.fn().mockReturnValue({ toString: () => "test-id" }),
      get: vi.fn(),
    },
    OPENHANDS_STORAGE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ objects: [] }),
    },
    LINEAR_CLIENT_ID: "test-client-id",
    LINEAR_CLIENT_SECRET: "test-client-secret",
    LINEAR_WEBHOOK_SECRET: "test-webhook-secret",
    ANTHROPIC_API_KEY: "test-api-key",
    GH_TOKEN: "test-gh-token",
    GIT_USER_NAME: "Test User",
    GIT_USER_EMAIL: "test@example.com",
    GATEWAY_TOKEN: "test-gateway-token",
  };
}

// Helper to create mock execution context
function createMockCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
}

describe("OpenHands Worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Health Check", () => {
    it("should return OK for /health endpoint", async () => {
      const request = new Request("https://worker.dev/health");
      const env = createMockEnv();
      const ctx = createMockCtx();

      // Import the worker module
      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("OK");
    });
  });

  describe("Root Endpoint", () => {
    it("should return welcome message at /", async () => {
      const request = new Request("https://worker.dev/");
      const env = createMockEnv();
      const ctx = createMockCtx();

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("OpenHands Worker");
      expect(text).toContain("/_admin/");
      expect(text).toContain("/webhook");
    });
  });

  describe("Admin UI", () => {
    it("should require gateway token when configured", async () => {
      const request = new Request("https://worker.dev/_admin/");
      const env = createMockEnv();
      const ctx = createMockCtx();

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(401);
    });

    it("should allow access with correct gateway token", async () => {
      const request = new Request(
        "https://worker.dev/_admin/?token=test-gateway-token"
      );
      const env = createMockEnv();
      const ctx = createMockCtx();

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html");
    });

    it("should return HTML admin page", async () => {
      const request = new Request(
        "https://worker.dev/_admin/?token=test-gateway-token"
      );
      const env = createMockEnv();
      const ctx = createMockCtx();

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      const html = await response.text();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("OpenHands Worker Admin");
      expect(html).toContain("Repositories");
    });
  });

  describe("404 Handling", () => {
    it("should return 404 for unknown routes", async () => {
      const request = new Request("https://worker.dev/unknown-route");
      const env = createMockEnv();
      const ctx = createMockCtx();

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(404);
    });
  });
});

describe("Webhook Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should accept valid AgentSessionEvent webhook", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-123",
      webhookId: "webhook-123",
      webhookTimestamp: Date.now(),
      agentSession: {
        id: "session-123",
        issue: {
          id: "issue-123",
          identifier: "ENG-456",
          title: "Fix the bug",
          description: "There is a bug that needs fixing",
          team: {
            id: "team-123",
            name: "Engineering",
            key: "ENG",
          },
        },
      },
    };

    const request = new Request("https://worker.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": "test-signature",
      },
      body: JSON.stringify(payload),
    });

    const env = createMockEnv();
    const ctx = createMockCtx();

    const worker = await import("../index");
    const response = await worker.default.fetch(request, env as any, ctx as any);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe("accepted");
    expect(json.issue).toBe("ENG-456");

    // Verify background processing was queued
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it("should ignore non-created webhook actions", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted", // Not "created"
      organizationId: "org-123",
      webhookId: "webhook-123",
      webhookTimestamp: Date.now(),
    };

    const request = new Request("https://worker.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": "test-signature",
      },
      body: JSON.stringify(payload),
    });

    const env = createMockEnv();
    const ctx = createMockCtx();

    const worker = await import("../index");
    const response = await worker.default.fetch(request, env as any, ctx as any);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe("ignored");
  });

  it("should reject webhooks without signature when secret is configured", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
    };

    const request = new Request("https://worker.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No linear-signature header
      },
      body: JSON.stringify(payload),
    });

    const env = createMockEnv();
    const ctx = createMockCtx();

    const worker = await import("../index");
    const response = await worker.default.fetch(request, env as any, ctx as any);

    expect(response.status).toBe(401);
  });

  it("should return 400 for invalid JSON", async () => {
    const request = new Request("https://worker.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": "test-signature",
      },
      body: "not valid json",
    });

    const env = createMockEnv();
    const ctx = createMockCtx();

    const worker = await import("../index");
    const response = await worker.default.fetch(request, env as any, ctx as any);

    expect(response.status).toBe(400);
  });
});

describe("API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("/api/config", () => {
    it("should return default config when none stored", async () => {
      const request = new Request("https://worker.dev/api/config");
      const env = createMockEnv();
      const ctx = createMockCtx();

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(200);
      const config = await response.json();
      expect(config.repositories).toEqual([]);
      expect(config.maxIterations).toBe(50);
    });

    it("should return stored config when available", async () => {
      const storedConfig = {
        repositories: [
          {
            name: "test-repo",
            githubUrl: "https://github.com/test/repo",
            localPath: "/data/repos/test-repo",
            linearTeamKey: "TEST",
            isActive: true,
          },
        ],
        defaultLlmModel: "claude-opus-4-20250514",
        maxIterations: 100,
      };

      const env = createMockEnv();
      env.OPENHANDS_STORAGE.get = vi.fn().mockResolvedValue({
        text: () => Promise.resolve(JSON.stringify(storedConfig)),
      });

      const request = new Request("https://worker.dev/api/config");
      const ctx = createMockCtx();

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(200);
      const config = await response.json();
      expect(config.repositories).toHaveLength(1);
      expect(config.repositories[0].name).toBe("test-repo");
    });
  });

  describe("/api/add-repo", () => {
    it("should add a repository", async () => {
      const request = new Request("https://worker.dev/api/add-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "my-repo",
          githubUrl: "https://github.com/org/my-repo",
          linearTeamKey: "ENG",
        }),
      });

      const env = createMockEnv();
      const ctx = createMockCtx();

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.message).toBe("Repository added");

      // Verify config was saved
      expect(env.OPENHANDS_STORAGE.put).toHaveBeenCalled();
    });

    it("should reject add-repo without required fields", async () => {
      const request = new Request("https://worker.dev/api/add-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "my-repo",
          // Missing githubUrl
        }),
      });

      const env = createMockEnv();
      const ctx = createMockCtx();

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });
  });

  describe("/api/status", () => {
    it("should return sandbox status", async () => {
      const request = new Request("https://worker.dev/api/status");
      const env = createMockEnv();
      const ctx = createMockCtx();

      const mockSandbox = {
        exec: vi.fn().mockResolvedValue({
          stdout: "process output here",
          success: true,
        }),
      };
      vi.mocked(getSandbox).mockReturnValue(mockSandbox as any);

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toHaveProperty("output");
      expect(json).toHaveProperty("success");
    });
  });

  describe("/api/exec", () => {
    it("should execute command in sandbox", async () => {
      const request = new Request("https://worker.dev/api/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "ls -la" }),
      });

      const env = createMockEnv();
      const ctx = createMockCtx();

      const mockSandbox = {
        exec: vi.fn().mockResolvedValue({
          stdout: "file1\nfile2\n",
          stderr: "",
          exitCode: 0,
          success: true,
        }),
      };
      vi.mocked(getSandbox).mockReturnValue(mockSandbox as any);

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.stdout).toContain("file1");
    });
  });

  describe("/api/init", () => {
    it("should initialize sandbox environment", async () => {
      const request = new Request("https://worker.dev/api/init", {
        method: "POST",
      });

      const env = createMockEnv();
      const ctx = createMockCtx();

      const mockSandbox = {
        exec: vi.fn().mockResolvedValue({
          stdout: "",
          stderr: "",
          exitCode: 0,
          success: true,
        }),
      };
      vi.mocked(getSandbox).mockReturnValue(mockSandbox as any);

      const worker = await import("../index");
      const response = await worker.default.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);

      // Verify git config was set
      expect(mockSandbox.exec).toHaveBeenCalledWith(
        expect.stringContaining("git config")
      );
    });
  });
});

describe("Configuration Management", () => {
  it("should find repository by team key", async () => {
    const config = {
      repositories: [
        {
          name: "frontend",
          githubUrl: "https://github.com/org/frontend",
          localPath: "/data/repos/frontend",
          linearTeamKey: "FE",
          isActive: true,
        },
        {
          name: "backend",
          githubUrl: "https://github.com/org/backend",
          localPath: "/data/repos/backend",
          linearTeamKey: "BE",
          isActive: true,
        },
        {
          name: "inactive",
          githubUrl: "https://github.com/org/inactive",
          localPath: "/data/repos/inactive",
          linearTeamKey: "IN",
          isActive: false,
        },
      ],
      defaultLlmModel: "claude-sonnet-4-20250514",
      maxIterations: 50,
    };

    // Test finding active repo
    const feRepo = config.repositories.find(
      (r) => r.isActive && r.linearTeamKey === "FE"
    );
    expect(feRepo?.name).toBe("frontend");

    // Test finding another active repo
    const beRepo = config.repositories.find(
      (r) => r.isActive && r.linearTeamKey === "BE"
    );
    expect(beRepo?.name).toBe("backend");

    // Test that inactive repos are not found
    const inactiveRepo = config.repositories.find(
      (r) => r.isActive && r.linearTeamKey === "IN"
    );
    expect(inactiveRepo).toBeUndefined();

    // Test non-existent team key
    const unknownRepo = config.repositories.find(
      (r) => r.isActive && r.linearTeamKey === "UNKNOWN"
    );
    expect(unknownRepo).toBeUndefined();
  });
});

describe("Linear Issue Parsing", () => {
  it("should extract issue number from identifier", () => {
    const testCases = [
      { identifier: "ENG-123", expected: 123 },
      { identifier: "PROD-1", expected: 1 },
      { identifier: "TEST-99999", expected: 99999 },
      { identifier: "A-1", expected: 1 },
    ];

    for (const { identifier, expected } of testCases) {
      const match = identifier.match(/\d+$/);
      const issueNumber = match ? parseInt(match[0], 10) : 1;
      expect(issueNumber).toBe(expected);
    }
  });

  it("should handle identifiers without numbers", () => {
    const identifier = "NOPE";
    const match = identifier.match(/\d+$/);
    const issueNumber = match ? parseInt(match[0], 10) : 1;
    expect(issueNumber).toBe(1); // Default fallback
  });
});

describe("GitHub URL Parsing", () => {
  it("should extract owner and repo from GitHub URLs", () => {
    const testCases = [
      {
        url: "https://github.com/org/repo",
        owner: "org",
        repo: "repo",
      },
      {
        url: "https://github.com/my-org/my-repo.git",
        owner: "my-org",
        repo: "my-repo",
      },
      {
        url: "https://github.com/user/project",
        owner: "user",
        repo: "project",
      },
    ];

    for (const { url, owner, repo } of testCases) {
      const match = url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe(owner);
      expect(match![2]).toBe(repo);
    }
  });

  it("should handle invalid GitHub URLs", () => {
    const invalidUrls = [
      "https://gitlab.com/org/repo",
      "not-a-url",
      "https://github.com/",
    ];

    for (const url of invalidUrls) {
      const match = url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
      expect(match).toBeNull();
    }
  });
});
