import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import YAML from "yaml";
import { AppRecord, CATEGORIES, Evidence, SeedApp } from "../src/config/schema.js";

const validEvidence = {
  url: "https://api.slack.com/docs",
  kind: "docs" as const,
  quote: "Use OAuth 2.0 to obtain access tokens for Slack Web API methods.",
  fetchedAt: "2026-11-23T10:00:00.000Z",
  httpStatus: 200,
};

const validApp = {
  id: 21,
  name: "Slack",
  category: "Comms and Messaging" as const,
  oneLiner: "Team messaging platform with Web API and Bot tokens.",
  authMethods: ["oauth2" as const, "bearer_token" as const],
  accessModel: "self_serve_free" as const,
  apiSurface: {
    type: "rest" as const,
    breadth: "wide" as const,
    docsUrl: "https://api.slack.com/docs",
  },
  hasMcp: "official_mcp" as const,
  composioExisting: "yes" as const,
  buildability: {
    verdict: "toolkit_ready" as const,
  },
  evidenceUrls: [validEvidence],
  confidence: "high" as const,
};

describe("Evidence schema (Shubham 20% Kernel #1)", () => {
  it("accepts a valid evidence object", () => {
    const res = Evidence.safeParse(validEvidence);
    expect(res.success).toBe(true);
  });

  it("rejects a malformed evidence URL", () => {
    const res = Evidence.safeParse({ ...validEvidence, url: "not-a-url" });
    expect(res.success).toBe(false);
  });

  it("rejects an invalid kind", () => {
    const res = Evidence.safeParse({ ...validEvidence, kind: "reddit" });
    expect(res.success).toBe(false);
  });
});

describe("AppRecord schema (Shubham 20% Kernel #2)", () => {
  it("accepts a valid record and applies default false flags", () => {
    const res = AppRecord.safeParse(validApp);
    expect(res.success).toBe(true);
    if (res.success) {
      expect((res.data as { pass2Verified?: boolean }).pass2Verified).toBe(false);
      expect((res.data as { auditedByHuman?: boolean }).auditedByHuman).toBe(false);
    }
  });

  it("rejects an auth method outside the enum", () => {
    const res = AppRecord.safeParse({ ...validApp, authMethods: ["magic"] });
    expect(res.success).toBe(false);
  });

  it("rejects a record with zero evidence URLs", () => {
    const res = AppRecord.safeParse({ ...validApp, evidenceUrls: [] });
    expect(res.success).toBe(false);
  });

  it("rejects an out-of-range id (101)", () => {
    const res = AppRecord.safeParse({ ...validApp, id: 101 });
    expect(res.success).toBe(false);
  });
});

describe("seed/apps.yaml integrity (Phase 1 exit criterion)", () => {
  it("parses to exactly 100 unique ids (1..100) with 10 apps per category", () => {
    const raw = fs.readFileSync(path.resolve("seed/apps.yaml"), "utf-8");
    const items = YAML.parse(raw) as unknown[];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(100);

    const parsed = items.map((item) => SeedApp.parse(item));
    const uniqueIds = new Set(parsed.map((a) => a.id));
    expect(uniqueIds.size).toBe(100);
    for (let i = 1; i <= 100; i++) {
      expect(uniqueIds.has(i)).toBe(true);
    }

    for (const cat of CATEGORIES) {
      expect(parsed.filter((a) => a.category === cat).length).toBe(10);
    }
  });
});
