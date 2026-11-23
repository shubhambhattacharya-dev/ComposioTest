import fs from "node:fs";
import { AppRecord } from "./config/schema.js";
import { CHECKPOINT_PATH } from "./research.js";
import { loadCheckpoints } from "./verify.js";
import { DIST_HTML_PATH, loadAuditSummary } from "./build-html.js";

function main(): void {
  const records = loadCheckpoints(CHECKPOINT_PATH);
  const uniqueIds = new Set(records.map((r) => r.id));

  let schemaValidCount = 0;
  let totalEvidenceUrls = 0;
  let http200Urls = 0;

  for (const r of records) {
    if (AppRecord.safeParse(r).success) schemaValidCount++;
    for (const ev of r.evidenceUrls) {
      totalEvidenceUrls++;
      if (ev.httpStatus === 200) http200Urls++;
    }
  }

  const audit = loadAuditSummary();
  let htmlOk = false;
  let htmlKb = 0;
  let embeddedCount = 0;

  if (fs.existsSync(DIST_HTML_PATH)) {
    const html = fs.readFileSync(DIST_HTML_PATH, "utf-8");
    htmlKb = Math.round(Buffer.byteLength(html, "utf-8") / 1024);
    const match = html.match(
      /<script type="application\/json" id="composio-research-dataset">([\s\S]*?)<\/script>/,
    );
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1]) as { apps?: unknown[] };
        embeddedCount = parsed.apps?.length ?? 0;
        htmlOk =
          htmlKb < 1024 &&
          embeddedCount === records.length &&
          !html.includes("[object Object]");
      } catch {
        htmlOk = false;
      }
    }
  }

  const appsOk = records.length === 100 && uniqueIds.size === 100 && schemaValidCount === 100;

  console.log(`APPS ${records.length}/100 (unique=${uniqueIds.size}, valid=${schemaValidCount}) ${appsOk ? "OK" : "INCOMPLETE"}`);
  console.log(`URLS ${http200Urls}/${totalEvidenceUrls} HTTP_200`);
  console.log(`ACCURACY ${audit.pass1Pct} -> ${audit.pass2Pct} -> ${audit.finalPct}`);
  console.log(`INDEX.HTML ${htmlKb} KB (embedded=${embeddedCount}) ${htmlOk ? "OK" : "NEEDS_BUILD"}`);

  if (!appsOk) {
    process.exitCode = 1;
  }
}

main();
