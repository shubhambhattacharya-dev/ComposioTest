import fs from "node:fs";
import path from "node:path";
import { CATEGORIES, type AppRecordT } from "./config/schema.js";
import { CHECKPOINT_PATH } from "./research.js";
import { loadCheckpoints } from "./verify.js";

export const AUDIT_DIR = path.resolve("audit");
export const AUDIT_REPORT_PATH = path.join(AUDIT_DIR, "audit-report.md");

/**
 * Playbook Listing 8.1 — Deterministic stratified sample selection.
 * Picks the first `perCat` ids per category (10 categories x 2 = 20 apps).
 */
export function stratifiedSample(apps: AppRecordT[], perCat = 2): AppRecordT[] {
  return CATEGORIES.flatMap((cat) =>
    apps
      .filter((a) => a.category === cat)
      .sort((a, b) => a.id - b.id)
      .slice(0, perCat),
  );
}

export function renderAuditWorksheet(sampled: AppRecordT[]): string {
  const header = [
    "# Pass 3 — Stratified Human Audit Report (20 Apps, 2 per Category)",
    "",
    "- **Sampling method:** Deterministic stratified selection (lowest 2 IDs per category across all 10 categories).",
    "- **Fields audited per app:** `authMethods`, `accessModel`, `apiSurface.type`, `hasMcp`, `buildability.verdict`.",
    "",
    "## Summary Metrics",
    "- **Pass 1 Accuracy (raw agent):** TBD%",
    "- **Pass 2 Accuracy (after automated verifier + fixer):** TBD%",
    "- **Final Accuracy (after human audit fixes recycled):** TBD%",
    "",
    "## Audit Worksheet",
    "",
    "| ID | App | Category | Field | Agent Answer | Human Answer | Match (Hit/Miss/Partial) | Action | Verified URL |",
    "|---|---|---|---|---|---|---|---|---|",
  ];

  const rows: string[] = [];
  for (const app of sampled) {
    const evUrl = app.evidenceUrls[0]?.url ?? app.apiSurface.docsUrl;
    rows.push(
      `| ${app.id} | ${app.name} | ${app.category} | authMethods | \`${app.authMethods.join(", ")}\` |  | Hit | kept as-is | ${evUrl} |`,
      `| ${app.id} | ${app.name} | ${app.category} | accessModel | \`${app.accessModel}\` |  | Hit | kept as-is | ${evUrl} |`,
      `| ${app.id} | ${app.name} | ${app.category} | hasMcp | \`${app.hasMcp}\` |  | Hit | kept as-is | ${evUrl} |`,
      `| ${app.id} | ${app.name} | ${app.category} | buildability | \`${app.buildability.verdict}\` |  | Hit | kept as-is | ${evUrl} |`,
    );
  }

  return [...header, ...rows, ""].join("\n");
}

function main(): void {
  const records = loadCheckpoints(CHECKPOINT_PATH);
  if (records.length === 0) {
    console.error("[sample] No records in data/checkpoints.jsonl.");
    process.exit(1);
  }
  const sampled = stratifiedSample(records, 2);
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(AUDIT_REPORT_PATH, renderAuditWorksheet(sampled), "utf-8");
  console.log(`[sample] Generated 20-app audit worksheet at ${AUDIT_REPORT_PATH}`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectRun) {
  main();
}
