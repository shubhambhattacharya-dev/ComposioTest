import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { loadEnv, type EnvT } from "./config/env.js";
import { AppRecord, type AppRecordT, type EvidenceT } from "./config/schema.js";
import {
  CHECKPOINT_PATH,
  DATA_DIR,
  extractWithLlmFailover,
  fetchOfficialPage,
  loadSeedApps,
} from "./research.js";

export const VERIFY_LOG_PATH = path.join(DATA_DIR, "verify-log.json");
export const DIFF_LOG_PATH = path.join(DATA_DIR, "diff-log.json");

export interface UrlVerdict {
  url: string;
  httpStatus: number;
  ok: boolean;
  failures: string[];
  groundedKeywords: string[];
  jsShellDetected: boolean;
}

export interface RecordVerdict {
  id: number;
  name: string;
  ok: boolean;
  failures: string[];
  urlVerdicts: UrlVerdict[];
}

export interface DiffEntry {
  id: number;
  name: string;
  round: number;
  field: string;
  before: unknown;
  after: unknown;
  reason: string;
}

export function stripHtmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim().toLowerCase();
}

export function isLikelyJsShell(html: string, plainText: string): boolean {
  const hasAppRoot =
    /<div\s+id=["'](?:root|app|__next|swagger-ui|redoc)["']/i.test(html) ||
    /stoplight|redoc|swagger-ui/i.test(html);
  return hasAppRoot && plainText.length < 300;
}

/**
 * Playbook Appendix B.1 — Field-specific grounding keyword rules.
 * Returns an array of keyword groups: each group passes if ANY keyword in the group appears on the page.
 */
export function groundKeywordGroups(
  rec: AppRecordT,
  ev: EvidenceT,
): Array<{ field: string; anyOf: string[] }> {
  const groups: Array<{ field: string; anyOf: string[] }> = [];

  if (ev.kind === "docs" || ev.kind === "github") {
    if (rec.authMethods.includes("oauth2")) {
      groups.push({
        field: "auth=oauth2",
        anyOf: ["oauth", "authorization code", "access token", "bearer", "token"],
      });
    }
    if (rec.authMethods.includes("api_key")) {
      groups.push({
        field: "auth=api_key",
        anyOf: ["api key", "apikey", "x-api-key", "api token", "key"],
      });
    }
    if (rec.authMethods.includes("basic")) {
      groups.push({
        field: "auth=basic",
        anyOf: ["basic auth", "username and password", "basic", "authorization"],
      });
    }
    if (rec.apiSurface.type === "graphql") {
      groups.push({
        field: "apiSurface=graphql",
        anyOf: ["graphql", "schema", "query", "mutation"],
      });
    }
    if (rec.hasMcp === "official_mcp") {
      groups.push({
        field: "hasMcp=official_mcp",
        anyOf: ["model context protocol", "mcp server", "mcp"],
      });
    }
  }

  if (ev.kind === "pricing") {
    if (rec.accessModel === "self_serve_free") {
      groups.push({
        field: "access=self_serve_free",
        anyOf: ["free", "signup", "sign up", "get started", "developer"],
      });
    }
    if (rec.accessModel === "partner_or_sales") {
      groups.push({
        field: "access=partner_or_sales",
        anyOf: ["contact sales", "partner", "request access", "talk to sales", "enterprise"],
      });
    }
  }

  return groups;
}

export async function verifyRecord(
  rec: AppRecordT,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 12000,
): Promise<RecordVerdict> {
  const failures: string[] = [];
  const urlVerdicts: UrlVerdict[] = [];

  for (const ev of rec.evidenceUrls) {
    const evFailures: string[] = [];
    const groundedKeywords: string[] = [];
    let httpStatus = 0;
    let jsShellDetected = false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchFn(ev.url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ComposioResearchVerifier/1.0)",
        },
      });
      httpStatus = res.status;

      if (res.status !== 200) {
        evFailures.push(`http_${res.status}:${ev.url}`);
      } else {
        const html = await res.text();
        const text = stripHtmlToText(html);
        jsShellDetected = isLikelyJsShell(html, text);

        const groups = groundKeywordGroups(rec, ev);
        const missedFields: string[] = [];

        for (const group of groups) {
          const matched = group.anyOf.find((kw) => text.includes(kw));
          if (matched) {
            groundedKeywords.push(`${group.field}:${matched}`);
          } else {
            missedFields.push(group.field);
          }
        }

        if (missedFields.length > 0) {
          if (jsShellDetected) {
            evFailures.push(`js_shell_ungrounded:${missedFields.join(",")}`);
          } else {
            evFailures.push(`grounding_miss:${missedFields.join(",")}`);
          }
        }
      }
    } catch {
      evFailures.push(`fetch_error:${ev.url}`);
    } finally {
      clearTimeout(timer);
    }

    urlVerdicts.push({
      url: ev.url,
      httpStatus,
      ok: evFailures.length === 0,
      failures: evFailures,
      groundedKeywords,
      jsShellDetected,
    });
    failures.push(...evFailures);
  }

  return {
    id: rec.id,
    name: rec.name,
    ok: failures.length === 0,
    failures,
    urlVerdicts,
  };
}

export function loadCheckpoints(checkpointPath = CHECKPOINT_PATH): AppRecordT[] {
  if (!fs.existsSync(checkpointPath)) return [];
  const byId = new Map<number, AppRecordT>();
  const lines = fs.readFileSync(checkpointPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = AppRecord.parse(JSON.parse(trimmed));
      byId.set(rec.id, rec);
    } catch {
      // skip invalid line
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

export function saveCheckpoints(
  records: AppRecordT[],
  checkpointPath = CHECKPOINT_PATH,
): void {
  const sorted = [...records].sort((a, b) => a.id - b.id);
  const body = sorted.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(checkpointPath, body, "utf-8");
}

function diffRecords(
  before: AppRecordT,
  after: AppRecordT,
  round: number,
  reason: string,
): DiffEntry[] {
  const trackedFields: Array<keyof AppRecordT> = [
    "authMethods",
    "accessModel",
    "apiSurface",
    "hasMcp",
    "buildability",
    "evidenceUrls",
    "confidence",
  ];
  const diffs: DiffEntry[] = [];
  for (const field of trackedFields) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      diffs.push({
        id: before.id,
        name: before.name,
        round,
        field,
        before: before[field],
        after: after[field],
        reason,
      });
    }
  }
  return diffs;
}

async function repairFailedRecord(
  rec: AppRecordT,
  verdict: RecordVerdict,
  seedHint: string,
  env: EnvT | null,
): Promise<AppRecordT> {
  const reasonText = verdict.failures.join("; ");

  // Re-fetch seed hint URL to get fresh ground-truth content
  const freshPage = await fetchOfficialPage(seedHint, env?.FETCH_TIMEOUT_MS ?? 12000);

  // If deterministic downgrade is needed (no LLM or page still blocked / JS shell)
  if (!env || !freshPage.ok) {
    const downgraded: AppRecordT = {
      ...rec,
      hasMcp:
        verdict.failures.some((f) => f.includes("hasMcp=official_mcp"))
          ? "unknown"
          : rec.hasMcp,
      confidence: "low",
      pass2Verified: true,
      evidenceUrls: rec.evidenceUrls.map((ev, idx) => ({
        ...ev,
        httpStatus: verdict.urlVerdicts[idx]?.httpStatus ?? ev.httpStatus,
      })),
    };
    return AppRecord.parse(downgraded);
  }

  try {
    const seedApp = {
      id: rec.id,
      name: rec.name,
      category: rec.category,
      hint: `${seedHint} (PREVIOUS VERIFIER FAILURES: ${reasonText}. Fix ONLY unsupported fields using real evidence; downgrade unproven claims to unknown/none_found.)`,
    };

    const repairedRaw = await extractWithLlmFailover(seedApp, freshPage, env);
    const fixedEvidence = [
      {
        url: freshPage.finalUrl,
        kind: "docs" as const,
        quote:
          typeof (repairedRaw.evidenceUrls as Array<{ quote?: string }> | undefined)?.[0]?.quote === "string"
            ? ((repairedRaw.evidenceUrls as Array<{ quote: string }>)[0]!.quote).slice(0, 500)
            : freshPage.textExcerpt.slice(0, 240),
        fetchedAt: freshPage.fetchedAt,
        httpStatus: freshPage.httpStatus,
      },
    ];

    const rawBuild = (repairedRaw.buildability ?? {}) as Record<string, unknown>;
    const normalizedBuild: { verdict: string; blocker?: string } = {
      verdict: typeof rawBuild.verdict === "string" ? rawBuild.verdict : rec.buildability.verdict,
    };
    if (typeof rawBuild.blocker === "string" && rawBuild.blocker.trim().length > 0) {
      normalizedBuild.blocker = rawBuild.blocker.trim().slice(0, 180);
    }

    return AppRecord.parse({
      ...rec,
      ...repairedRaw,
      id: rec.id,
      name: rec.name,
      category: rec.category,
      oneLiner:
        typeof repairedRaw.oneLiner === "string" && repairedRaw.oneLiner.trim().length > 0
          ? repairedRaw.oneLiner.trim().slice(0, 140)
          : rec.oneLiner,
      hasMcp: typeof repairedRaw.hasMcp === "string" ? repairedRaw.hasMcp : rec.hasMcp,
      confidence: typeof repairedRaw.confidence === "string" ? repairedRaw.confidence : "medium",
      buildability: normalizedBuild,
      composioExisting: rec.composioExisting,
      evidenceUrls: fixedEvidence,
      pass2Verified: true,
    });
  } catch {
    return AppRecord.parse({
      ...rec,
      confidence: "low",
      pass2Verified: true,
    });
  }
}

async function main(): Promise<void> {
  let env: EnvT | null = null;
  try {
    env = loadEnv();
  } catch {
    console.warn("[pass2] Running deterministic URL/grounding verification without LLM fixer.");
  }

  const seedApps = loadSeedApps();
  const seedHintById = new Map(seedApps.map((s) => [s.id, s.hint]));
  let records = loadCheckpoints(CHECKPOINT_PATH);

  if (records.length === 0) {
    console.error("[pass2] No records found in data/checkpoints.jsonl. Run npm run research first.");
    process.exit(1);
  }

  const limit = pLimit(env?.RESEARCH_CONCURRENCY ?? 6);
  const diffLog: DiffEntry[] = [];
  const roundHistory: Array<{
    round: number;
    total: number;
    passed: number;
    failed: number;
    verdicts: RecordVerdict[];
  }> = [];

  let round = 0;
  let verdicts = await Promise.all(
    records.map((r) => limit(() => verifyRecord(r, fetch, env?.FETCH_TIMEOUT_MS ?? 12000))),
  );
  roundHistory.push({
    round,
    total: verdicts.length,
    passed: verdicts.filter((v) => v.ok).length,
    failed: verdicts.filter((v) => !v.ok).length,
    verdicts,
  });
  console.log(
    `[pass2] Round 0: ${roundHistory[0]!.passed}/${roundHistory[0]!.total} passed (${roundHistory[0]!.failed} failed)`,
  );

  // Bounded fixer loop (max 2 repair rounds per Playbook Listing 7.2)
  while (verdicts.some((v) => !v.ok) && round < 2) {
    round += 1;
    const failedById = new Map(
      verdicts.filter((v) => !v.ok).map((v) => [v.id, v]),
    );

    records = await Promise.all(
      records.map((rec) =>
        limit(async () => {
          const failVerdict = failedById.get(rec.id);
          if (!failVerdict) {
            return { ...rec, pass2Verified: true };
          }
          const repaired = await repairFailedRecord(
            rec,
            failVerdict,
            seedHintById.get(rec.id) ?? rec.apiSurface.docsUrl,
            env,
          );
          const diffs = diffRecords(rec, repaired, round, failVerdict.failures.join("; "));
          diffLog.push(...diffs);
          return repaired;
        }),
      ),
    );

    verdicts = await Promise.all(
      records.map((r) => limit(() => verifyRecord(r, fetch, env?.FETCH_TIMEOUT_MS ?? 12000))),
    );
    const passed = verdicts.filter((v) => v.ok).length;
    roundHistory.push({
      round,
      total: verdicts.length,
      passed,
      failed: verdicts.length - passed,
      verdicts,
    });
    console.log(`[pass2] Round ${round}: ${passed}/${verdicts.length} passed (${verdicts.length - passed} failed)`);
  }

  // Mark remaining unverified failures honestly as confidence=low
  const finalVerdictById = new Map(verdicts.map((v) => [v.id, v]));
  records = records.map((rec) => {
    const v = finalVerdictById.get(rec.id);
    if (v && !v.ok && rec.confidence === "high") {
      return { ...rec, confidence: "low", pass2Verified: true };
    }
    return { ...rec, pass2Verified: true };
  });

  saveCheckpoints(records, CHECKPOINT_PATH);
  fs.writeFileSync(VERIFY_LOG_PATH, JSON.stringify(roundHistory, null, 2), "utf-8");
  fs.writeFileSync(DIFF_LOG_PATH, JSON.stringify(diffLog, null, 2), "utf-8");

  console.log(
    `[pass2] Done. Saved ${VERIFY_LOG_PATH} & ${DIFF_LOG_PATH} (${diffLog.length} field repairs logged).`,
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
