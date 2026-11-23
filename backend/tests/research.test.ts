import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  loadDoneIds,
  researchApp,
  type FetchedPage,
  type ResearchDeps,
} from "../src/research.js";
import type { AppRecordT, SeedAppT } from "../src/config/schema.js";

const sampleSeed: SeedAppT = {
  id: 21,
  name: "Slack",
  category: "Comms and Messaging",
  hint: "https://api.slack.com/docs",
};

const samplePage: FetchedPage = {
  url: "https://api.slack.com/docs",
  finalUrl: "https://api.slack.com/docs",
  httpStatus: 200,
  ok: true,
  textExcerpt: "Slack Web API uses OAuth 2.0 tokens for workspace apps.",
  fetchedAt: "2026-11-23T10:00:00.000Z",
};

const rawLlmOutput = {
  oneLiner: "Team messaging platform with Web API and Bot tokens.",
  authMethods: ["oauth2", "bearer_token"],
  accessModel: "self_serve_free",
  apiSurface: {
    type: "rest",
    breadth: "wide",
    docsUrl: "https://api.slack.com/docs",
  },
  hasMcp: "official_mcp",
  buildability: {
    verdict: "toolkit_ready",
  },
  evidenceUrls: [
    {
      url: "https://api.slack.com/docs",
      kind: "docs",
      quote: "Slack Web API uses OAuth 2.0 tokens.",
      fetchedAt: "2026-11-23T10:00:00.000Z",
      httpStatus: 200,
    },
  ],
  confidence: "high",
};

describe("loadDoneIds (Shubham 20% Kernel #1)", () => {
  it("returns empty Set when checkpoint file does not exist", () => {
    const missing = path.join(os.tmpdir(), `nonexistent-${Date.now()}.jsonl`);
    const ids = loadDoneIds(missing);
    expect(ids.size).toBe(0);
  });

  it("loads valid numeric ids and safely skips blank/corrupted lines", () => {
    const tmpFile = path.join(os.tmpdir(), `checkpoints-${Date.now()}.jsonl`);
    fs.writeFileSync(
      tmpFile,
      [
        JSON.stringify({ id: 1, name: "Salesforce" }),
        "",
        "{corrupted json line",
        JSON.stringify({ id: 21, name: "Slack" }),
      ].join("\n"),
      "utf-8",
    );

    const ids = loadDoneIds(tmpFile);
    fs.unlinkSync(tmpFile);

    expect(ids.size).toBe(2);
    expect(ids.has(1)).toBe(true);
    expect(ids.has(21)).toBe(true);
  });
});

describe("researchApp (Shubham 20% Kernel #2)", () => {
  it("skips already-checkpointed apps and returns null without fetching", async () => {
    const fetchPage = vi.fn();
    const deps: ResearchDeps = {
      doneIds: new Set([21]),
      fetchPage,
      lookupComposio: vi.fn(),
      extractJson: vi.fn(),
      appendCheckpoint: vi.fn(),
    };

    const result = await researchApp(sampleSeed, deps);
    expect(result).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("fetches page + Composio catalog, retries once on LLM failure, validates with Zod, and appends checkpoint", async () => {
    const saved: AppRecordT[] = [];
    let calls = 0;

    const deps: ResearchDeps = {
      doneIds: new Set<number>(),
      fetchPage: vi.fn().mockResolvedValue(samplePage),
      lookupComposio: vi.fn().mockResolvedValue("yes"),
      extractJson: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) throw new Error("transient 429");
        return rawLlmOutput;
      }),
      appendCheckpoint: vi.fn((rec) => saved.push(rec)),
    };

    const record = await researchApp(sampleSeed, deps);
    expect(record).not.toBeNull();
    expect(record?.id).toBe(21);
    expect(record?.composioExisting).toBe("yes");
    expect(deps.extractJson).toHaveBeenCalledTimes(2);
    expect(deps.appendCheckpoint).toHaveBeenCalledTimes(1);
    expect(saved.length).toBe(1);
  });
});
