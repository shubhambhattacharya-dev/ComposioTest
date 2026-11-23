import fs from "node:fs";
import path from "node:path";
import { CATEGORIES, type AppRecordT, type CategoryT } from "./config/schema.js";
import { CHECKPOINT_PATH, DATA_DIR } from "./research.js";
import { loadCheckpoints } from "./verify.js";

export const PATTERNS_PATH = path.join(DATA_DIR, "patterns.json");

export interface CategorySelfServeStat {
  category: CategoryT;
  total: number;
  selfServe: number;
  gated: number;
  unknown: number;
  selfServePct: number;
}

export interface BlockerStat {
  theme: string;
  count: number;
}

export interface PatternsSummary {
  generatedAt: string;
  totalApps: number;
  authDistribution: Array<{ method: string; count: number; pct: number }>;
  accessDistribution: Array<{ model: string; count: number; pct: number }>;
  selfServeByCategory: CategorySelfServeStat[];
  mostGatedCategory: string;
  mostOpenCategory: string;
  mcpReadiness: {
    official_mcp: number;
    community_mcp: number;
    sdk_only: number;
    none_found: number;
    unknown: number;
    officialApps: string[];
  };
  composioOverlap: {
    yes: number;
    no: number;
    unknown: number;
  };
  buildabilityDistribution: {
    toolkit_ready: number;
    needs_work: number;
    blocked: number;
    unknown: number;
  };
  topBlockers: BlockerStat[];
  easyNetNewWins: Array<{
    id: number;
    name: string;
    category: CategoryT;
    auth: string;
    docsUrl: string;
  }>;
  outreachRequired: Array<{
    id: number;
    name: string;
    category: CategoryT;
    accessModel: string;
    blocker: string;
  }>;
  headlines: string[];
}

function classifyBlocker(blocker: string | undefined, accessModel: string): string {
  const b = (blocker ?? "").toLowerCase();
  if (accessModel === "partner_or_sales" || /partner|sales|enterprise|contract|whitelist/.test(b)) {
    return "Partner / Contact-Sales Gating";
  }
  if (accessModel === "admin_approval" || /review|approval|verification|audit/.test(b)) {
    return "App Review / Admin Approval";
  }
  if (accessModel === "self_serve_paid" || /paid|subscription|credit|billing/.test(b)) {
    return "Paid Plan Required for API";
  }
  if (/no public api|undocumented|cli|local|private/.test(b)) {
    return "No Public API / CLI-Only";
  }
  if (/js|javascript|cloudflare|blocked|docs/.test(b)) {
    return "JS-Rendered / Restricted Docs";
  }
  return "Other Technical Friction";
}

export function computePatterns(records: AppRecordT[]): PatternsSummary {
  const total = records.length;
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);

  // 1. Auth distribution (count apps supporting each auth method)
  const authCounts = new Map<string, number>();
  for (const r of records) {
    for (const method of new Set(r.authMethods)) {
      authCounts.set(method, (authCounts.get(method) ?? 0) + 1);
    }
  }
  const authDistribution = Array.from(authCounts.entries())
    .map(([method, count]) => ({ method, count, pct: pct(count) }))
    .sort((a, b) => b.count - a.count);

  // 2. Access model distribution
  const accessCounts = new Map<string, number>();
  for (const r of records) {
    accessCounts.set(r.accessModel, (accessCounts.get(r.accessModel) ?? 0) + 1);
  }
  const accessDistribution = Array.from(accessCounts.entries())
    .map(([model, count]) => ({ model, count, pct: pct(count) }))
    .sort((a, b) => b.count - a.count);

  // 3. Self-serve vs gated by category
  const selfServeModels = new Set(["self_serve_free", "self_serve_trial", "open_source"]);
  const gatedModels = new Set(["self_serve_paid", "admin_approval", "partner_or_sales"]);

  const selfServeByCategory: CategorySelfServeStat[] = CATEGORIES.map((category) => {
    const inCat = records.filter((r) => r.category === category);
    const selfServe = inCat.filter((r) => selfServeModels.has(r.accessModel)).length;
    const gated = inCat.filter((r) => gatedModels.has(r.accessModel)).length;
    const unknown = inCat.length - selfServe - gated;
    return {
      category,
      total: inCat.length,
      selfServe,
      gated,
      unknown,
      selfServePct: inCat.length === 0 ? 0 : Math.round((selfServe / inCat.length) * 100),
    };
  });

  const sortedByGated = [...selfServeByCategory].sort((a, b) => b.gated - a.gated);
  const sortedByOpen = [...selfServeByCategory].sort((a, b) => b.selfServe - a.selfServe);
  const mostGatedCategory = sortedByGated[0]?.category ?? "N/A";
  const mostOpenCategory = sortedByOpen[0]?.category ?? "N/A";

  // 4. MCP readiness
  const mcpReadiness = {
    official_mcp: records.filter((r) => r.hasMcp === "official_mcp").length,
    community_mcp: records.filter((r) => r.hasMcp === "community_mcp").length,
    sdk_only: records.filter((r) => r.hasMcp === "sdk_only").length,
    none_found: records.filter((r) => r.hasMcp === "none_found").length,
    unknown: records.filter((r) => r.hasMcp === "unknown").length,
    officialApps: records
      .filter((r) => r.hasMcp === "official_mcp")
      .map((r) => r.name),
  };

  // 5. Composio overlap
  const composioOverlap = {
    yes: records.filter((r) => r.composioExisting === "yes").length,
    no: records.filter((r) => r.composioExisting === "no").length,
    unknown: records.filter((r) => r.composioExisting === "unknown").length,
  };

  // 6. Buildability distribution
  const buildabilityDistribution = {
    toolkit_ready: records.filter((r) => r.buildability.verdict === "toolkit_ready").length,
    needs_work: records.filter((r) => r.buildability.verdict === "needs_work").length,
    blocked: records.filter((r) => r.buildability.verdict === "blocked").length,
    unknown: records.filter((r) => r.buildability.verdict === "unknown").length,
  };

  // 7. Blockers tally
  const blockerCounts = new Map<string, number>();
  for (const r of records) {
    if (r.buildability.verdict !== "toolkit_ready" || r.buildability.blocker) {
      const theme = classifyBlocker(r.buildability.blocker, r.accessModel);
      blockerCounts.set(theme, (blockerCounts.get(theme) ?? 0) + 1);
    }
  }
  const topBlockers = Array.from(blockerCounts.entries())
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => b.count - a.count);

  // 8. Easy net-new wins vs outreach required
  const easyNetNewWins = records
    .filter(
      (r) =>
        r.composioExisting !== "yes" &&
        selfServeModels.has(r.accessModel) &&
        (r.apiSurface.type === "rest" || r.apiSurface.type === "graphql") &&
        r.buildability.verdict === "toolkit_ready",
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      auth: r.authMethods.join(", "),
      docsUrl: r.apiSurface.docsUrl,
    }));

  const outreachRequired = records
    .filter(
      (r) =>
        r.accessModel === "partner_or_sales" ||
        r.accessModel === "admin_approval" ||
        r.buildability.verdict === "blocked",
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      accessModel: r.accessModel,
      blocker: r.buildability.blocker ?? r.accessModel,
    }));

  const topAuth = authDistribution[0];
  const topBlocker = topBlockers[0];

  const headlines = [
    topAuth
      ? `${topAuth.method.toUpperCase()} is the dominant auth pattern (${topAuth.count}/${total} apps, ${topAuth.pct}%), while ${mostOpenCategory} is the most self-serve category.`
      : `Analyzed ${total} SaaS apps across 10 categories.`,
    `${easyNetNewWins.length} of ${total} apps are immediate net-new toolkit wins (self-serve credentials, public API docs, not yet in Composio's catalog; ${composioOverlap.yes} already covered).`,
    topBlocker
      ? `The #1 buildability blocker is ${topBlocker.theme} (${topBlocker.count} apps), clustering heaviest in ${mostGatedCategory}.`
      : `Access gating clusters heaviest in ${mostGatedCategory}.`,
    `${mcpReadiness.official_mcp} apps already ship an official MCP server (${mcpReadiness.officialApps.slice(0, 6).join(", ")}${mcpReadiness.officialApps.length > 6 ? ", ..." : ""}).`,
  ];

  return {
    generatedAt: new Date().toISOString(),
    totalApps: total,
    authDistribution,
    accessDistribution,
    selfServeByCategory,
    mostGatedCategory,
    mostOpenCategory,
    mcpReadiness,
    composioOverlap,
    buildabilityDistribution,
    topBlockers,
    easyNetNewWins,
    outreachRequired,
    headlines,
  };
}

function main(): void {
  const records = loadCheckpoints(CHECKPOINT_PATH);
  if (records.length === 0) {
    console.error("[patterns] No records in data/checkpoints.jsonl.");
    process.exit(1);
  }
  const summary = computePatterns(records);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PATTERNS_PATH, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`[patterns] Wrote ${PATTERNS_PATH} (${summary.totalApps} apps, ${summary.easyNetNewWins.length} net-new wins)`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectRun) {
  main();
}
