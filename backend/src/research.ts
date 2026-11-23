import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import YAML from "yaml";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { Composio } from "@composio/core";
import { loadEnv, type EnvT } from "./config/env.js";
import {
  AppRecord,
  SeedApp,
  type AppRecordT,
  type SeedAppT,
} from "./config/schema.js";

// --- 80% BOILERPLATE: Constants, Fetcher, Composio Catalog, Multi-LLM Failover ---

export const DATA_DIR = path.resolve("data");
export const CHECKPOINT_PATH = path.join(DATA_DIR, "checkpoints.jsonl");
export const SEED_PATH = path.resolve("seed/apps.yaml");

export const SYSTEM_PROMPT = `You are a Product Ops research agent at Composio.
For ONE SaaS app, return a single JSON object matching the AppRecord schema.
Rules:
1. Use ONLY the fetched page content plus verified official docs knowledge grounded in the source.
2. If a fact is not stated on an official page, use the enum value "unknown" - never guess.
3. Copy a short verbatim quote supporting your finding into evidenceUrls[0].quote (max 500 chars).
4. At least one official docs URL is mandatory in evidenceUrls.
5. Prefer developer docs over marketing pages.
Return JSON only.`;

export interface FetchedPage {
  url: string;
  finalUrl: string;
  httpStatus: number;
  ok: boolean;
  textExcerpt: string;
  fetchedAt: string;
}

export interface ResearchDeps {
  doneIds: Set<number>;
  fetchPage: (url: string) => Promise<FetchedPage>;
  lookupComposio: (appName: string) => Promise<"yes" | "no" | "unknown">;
  extractJson: (app: SeedAppT, page: FetchedPage) => Promise<Record<string, unknown>>;
  appendCheckpoint: (record: AppRecordT) => void;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

export async function fetchOfficialPage(
  url: string,
  timeoutMs = 12000,
): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchedAt = new Date().toISOString();

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ComposioResearchAgent/1.0)",
        Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
      },
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, svg, iframe").remove();
    const textExcerpt = $("body").text().replace(/\s+/g, " ").trim().slice(0, 2200);

    return {
      url,
      finalUrl: res.url || url,
      httpStatus: res.status,
      ok: res.ok,
      textExcerpt,
      fetchedAt,
    };
  } catch {
    return {
      url,
      finalUrl: url,
      httpStatus: 0,
      ok: false,
      textExcerpt: "",
      fetchedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function createComposioLookup(
  apiKey: string,
): Promise<(appName: string) => Promise<"yes" | "no" | "unknown">> {
  try {
    const composio = new Composio({ apiKey });
    // Pre-fetch toolkit catalog once (fast + deterministic) via SDK
    const knownSlugs = new Set<string>();
    const listRes = await withTimeout(
      (composio.toolkits as unknown as { get: (q: Record<string, unknown>) => Promise<unknown> }).get({
        limit: 1000,
      }),
      10000,
      "composio.toolkits.get",
    );
    const items = Array.isArray(listRes)
      ? listRes
      : Array.isArray((listRes as { items?: unknown[] })?.items)
        ? (listRes as { items: unknown[] }).items
        : [];

    for (const item of items) {
      const rec = item as { slug?: string; name?: string };
      if (rec.slug) knownSlugs.add(rec.slug.toLowerCase().replace(/[^a-z0-9]/g, ""));
      if (rec.name) knownSlugs.add(rec.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    }

    if (knownSlugs.size === 0) {
      return async () => "unknown";
    }

    return async (appName: string): Promise<"yes" | "no" | "unknown"> => {
      const normalized = appName
        .toLowerCase()
        .replace(/\(.*?\)/g, "")
        .replace(/[^a-z0-9]+/g, "")
        .trim();
      if (normalized.length < 3) return "unknown";
      if (knownSlugs.has(normalized)) return "yes";
      for (const slug of knownSlugs) {
        if (slug === normalized || (normalized.length >= 5 && slug.includes(normalized))) {
          return "yes";
        }
      }
      return "no";
    };
  } catch (err) {
    console.warn(
      `[composio] Catalog lookup unavailable (${err instanceof Error ? err.message : String(err)}); marking composioExisting=unknown`,
    );
    return async () => "unknown";
  }
}

let geminiExhausted = false;
let groqPrimaryExhausted = false;

export async function extractWithLlmFailover(
  app: SeedAppT,
  page: FetchedPage,
  env: EnvT,
): Promise<Record<string, unknown>> {
  const userPrompt = JSON.stringify({
    app,
    fetchedPage: {
      finalUrl: page.finalUrl,
      httpStatus: page.httpStatus,
      ok: page.ok,
      fetchedAt: page.fetchedAt,
      textExcerpt: page.textExcerpt.slice(0, 2200),
    },
    requiredShape: {
      oneLiner: "string <= 140 chars",
      authMethods: ["oauth2|oauth1|api_key|basic|bearer_token|jwt|hmac|session_cookie|none|other|unknown"],
      accessModel: "self_serve_free|self_serve_trial|self_serve_paid|admin_approval|partner_or_sales|open_source|unknown",
      apiSurface: {
        type: "rest|graphql|grpc|cli|webhook|none_found|unknown",
        breadth: "narrow|medium|wide|unknown",
        docsUrl: "https://...",
      },
      hasMcp: "official_mcp|community_mcp|sdk_only|none_found|unknown",
      buildability: {
        verdict: "toolkit_ready|needs_work|blocked|unknown",
        blocker: "optional string <= 180 chars",
      },
      evidenceUrls: [
        {
          url: page.finalUrl,
          kind: "docs|pricing|blog|github|changelog|other",
          quote: "short verbatim quote <= 500 chars",
          fetchedAt: page.fetchedAt,
          httpStatus: page.httpStatus,
        },
      ],
      confidence: "high|medium|low",
    },
  });

  const errors: string[] = [];

  if (env.GEMINI_API_KEY && !geminiExhausted) {
    try {
      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
      const res = await withTimeout(
        ai.models.generateContent({
          model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
          contents: userPrompt,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: "application/json",
            temperature: 0.1,
          },
        }),
        20000,
        "gemini.generateContent",
      );
      if (res.text) return JSON.parse(stripCodeFences(res.text)) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429")) {
        geminiExhausted = true;
        console.warn("[llm] Gemini daily quota hit — circuit-breaker tripped, routing to Groq waterfall.");
      }
      errors.push(`gemini: ${msg.slice(0, 140)}`);
    }
  }

  if (env.GROQ_API_KEY) {
    const groq = new OpenAI({
      apiKey: env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      timeout: 20000,
    });

    const groqModels = groqPrimaryExhausted
      ? ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]
      : [
          process.env.GROQ_MODEL || "openai/gpt-oss-20b",
          "openai/gpt-oss-120b",
          "qwen/qwen3.8-27b",
        ];

    for (const model of groqModels) {
      try {
        const res = await withTimeout(
          groq.chat.completions.create({
            model,
            temperature: 0.1,
            max_tokens: 1000,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
          }),
          30000,
          `groq:${model}`,
        );
        const content = res.choices[0]?.message?.content;
        if (content) return JSON.parse(stripCodeFences(content)) as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (model === (process.env.GROQ_MODEL || "openai/gpt-oss-20b") && msg.includes("429")) {
          groqPrimaryExhausted = true;
        }
        errors.push(`groq(${model}): ${msg.slice(0, 140)}`);
      }
    }
  }

  throw new Error(`All LLM providers failed: ${errors.join(" | ")}`);
}

export function loadSeedApps(seedPath = SEED_PATH): SeedAppT[] {
  const raw = fs.readFileSync(seedPath, "utf-8");
  const parsed = YAML.parse(raw) as unknown[];
  return parsed.map((item) => SeedApp.parse(item));
}

export function appendCheckpointLine(
  record: AppRecordT,
  checkpointPath = CHECKPOINT_PATH,
): void {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.appendFileSync(checkpointPath, JSON.stringify(record) + "\n", "utf-8");
}

// ============================================================================
// --- 20% SHUBHAM KERNEL: Crash-Safe Resume + Pass 1 Orchestration Loop ---
// ============================================================================

export function loadDoneIds(checkpointPath = CHECKPOINT_PATH): Set<number> {
  const done = new Set<number>();
  if (!fs.existsSync(checkpointPath)) {
    return done;
  }

  const lines = fs.readFileSync(checkpointPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown };
      if (typeof parsed.id === "number" && Number.isInteger(parsed.id)) {
        done.add(parsed.id);
      }
    } catch {
      // Safely ignore corrupted or truncated JSONL lines
    }
  }
  return done;
}

export async function researchApp(
  app: SeedAppT,
  deps: ResearchDeps,
): Promise<AppRecordT | null> {
  if (deps.doneIds.has(app.id)) {
    return null;
  }

  const [page, composioExisting] = await Promise.all([
    deps.fetchPage(app.hint),
    deps.lookupComposio(app.name),
  ]);

  let raw: Record<string, unknown> | null = null;
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      raw = await deps.extractJson(app, page);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!raw) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`Extraction failed for ${app.name}`);
  }

  const rawEvidence = Array.isArray(raw.evidenceUrls) ? raw.evidenceUrls : [];
  const normalizedEvidence =
    rawEvidence.length > 0
      ? rawEvidence.map((item) => {
          const ev = (item ?? {}) as Record<string, unknown>;
          return {
            url: typeof ev.url === "string" && ev.url.startsWith("http") ? ev.url : page.finalUrl,
            kind: typeof ev.kind === "string" ? ev.kind : "docs",
            quote: typeof ev.quote === "string" ? ev.quote.slice(0, 500) : "",
            fetchedAt: typeof ev.fetchedAt === "string" ? ev.fetchedAt : page.fetchedAt,
            httpStatus: typeof ev.httpStatus === "number" ? Math.trunc(ev.httpStatus) : page.httpStatus,
          };
        })
      : [
          {
            url: page.finalUrl,
            kind: "docs" as const,
            quote: page.textExcerpt.slice(0, 240),
            fetchedAt: page.fetchedAt,
            httpStatus: page.httpStatus,
          },
        ];

  const oneLiner =
    typeof raw.oneLiner === "string" && raw.oneLiner.trim().length > 0
      ? raw.oneLiner.trim().slice(0, 140)
      : `${app.name} SaaS platform.`;

  const rawApiSurface = (raw.apiSurface ?? {}) as Record<string, unknown>;
  const normalizedApiSurface = {
    type: typeof rawApiSurface.type === "string" ? rawApiSurface.type : "unknown",
    breadth: typeof rawApiSurface.breadth === "string" ? rawApiSurface.breadth : "unknown",
    docsUrl:
      typeof rawApiSurface.docsUrl === "string" && rawApiSurface.docsUrl.startsWith("http")
        ? rawApiSurface.docsUrl
        : page.finalUrl,
  };

  const rawBuildability = (raw.buildability ?? {}) as Record<string, unknown>;
  const normalizedBuildability: { verdict: string; blocker?: string } = {
    verdict: typeof rawBuildability.verdict === "string" ? rawBuildability.verdict : "unknown",
  };
  if (typeof rawBuildability.blocker === "string" && rawBuildability.blocker.trim().length > 0) {
    normalizedBuildability.blocker = rawBuildability.blocker.trim().slice(0, 180);
  }

  const record = AppRecord.parse({
    ...raw,
    id: app.id,
    name: app.name,
    category: app.category,
    oneLiner,
    hasMcp: typeof raw.hasMcp === "string" ? raw.hasMcp : "unknown",
    confidence: typeof raw.confidence === "string" ? raw.confidence : "low",
    apiSurface: normalizedApiSurface,
    buildability: normalizedBuildability,
    composioExisting,
    evidenceUrls: normalizedEvidence,
  });

  deps.appendCheckpoint(record);
  deps.doneIds.add(record.id);
  return record;
}

// --- 80% BOILERPLATE: CLI Entrypoint ---

async function main(): Promise<void> {
  const env = loadEnv();
  const apps = loadSeedApps();
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const maxApps = limitArg ? Number(limitArg.split("=")[1]) : apps.length;

  const doneIds = loadDoneIds(CHECKPOINT_PATH);
  const lookupComposio = await createComposioLookup(env.COMPOSIO_API_KEY);
  const limit = pLimit(env.RESEARCH_CONCURRENCY);

  const deps: ResearchDeps = {
    doneIds,
    fetchPage: (url) => fetchOfficialPage(url, env.FETCH_TIMEOUT_MS),
    lookupComposio,
    extractJson: (app, page) => extractWithLlmFailover(app, page, env),
    appendCheckpoint: (rec) => appendCheckpointLine(rec, CHECKPOINT_PATH),
  };

  const targets = apps.slice(0, maxApps);
  console.log(
    `[pass1] Seed: ${targets.length} apps | Cached: ${doneIds.size} | Concurrency: ${env.RESEARCH_CONCURRENCY}`,
  );

  let okCount = 0;
  let failCount = 0;

  await Promise.all(
    targets.map((app) =>
      limit(async () => {
        try {
          const rec = await researchApp(app, deps);
          if (rec) {
            okCount++;
            console.log(
              `[pass1] #${rec.id} ${rec.name} -> ${rec.accessModel} | composio=${rec.composioExisting} | ${rec.buildability.verdict}`,
            );
          }
        } catch (err) {
          failCount++;
          console.error(
            `[pass1] FAILED #${app.id} ${app.name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    ),
  );

  console.log(`[pass1] Finished. Newly saved: ${okCount} | Failed: ${failCount}`);
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
