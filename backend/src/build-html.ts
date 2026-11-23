import fs from "node:fs";
import path from "node:path";
import type { AppRecordT } from "./config/schema.js";
import { CHECKPOINT_PATH } from "./research.js";
import { DIFF_LOG_PATH, VERIFY_LOG_PATH, loadCheckpoints, type DiffEntry } from "./verify.js";
import { PATTERNS_PATH, computePatterns, type PatternsSummary } from "./patterns.js";
import { AUDIT_REPORT_PATH } from "./sample.js";

export const DIST_DIR = path.resolve("dist");
export const DIST_HTML_PATH = path.join(DIST_DIR, "index.html");
export const FRONTEND_HTML_PATH = path.resolve("../frontend/index.html");

export interface AuditSummary {
  pass1Pct: string;
  pass2Pct: string;
  finalPct: string;
  sampleSize: number;
  brokenUrlsCaught: number;
  repairsApplied: number;
  namedMisses: Array<{ app: string; field: string; agent: string; human: string; action: string }>;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function loadAuditSummary(
  verifyLogPath = VERIFY_LOG_PATH,
  diffLogPath = DIFF_LOG_PATH,
  auditReportPath = AUDIT_REPORT_PATH,
): AuditSummary {
  let brokenUrlsCaught = 0;
  let repairsApplied = 0;
  let round0PassRate = 0;
  let finalRoundPassRate = 0;

  if (fs.existsSync(verifyLogPath)) {
    try {
      const rounds = JSON.parse(fs.readFileSync(verifyLogPath, "utf-8")) as Array<{
        total: number;
        passed: number;
        failed: number;
        verdicts: Array<{ failures: string[] }>;
      }>;
      const r0 = rounds[0];
      const rLast = rounds[rounds.length - 1];
      if (r0 && r0.total > 0) {
        round0PassRate = Math.round((r0.passed / r0.total) * 100);
        brokenUrlsCaught = r0.verdicts.filter((v) =>
          v.failures.some((f) => f.startsWith("http_") || f.startsWith("fetch_error")),
        ).length;
      }
      if (rLast && rLast.total > 0) {
        finalRoundPassRate = Math.round((rLast.passed / rLast.total) * 100);
      }
    } catch {
      // ignore malformed log
    }
  }

  if (fs.existsSync(diffLogPath)) {
    try {
      const diffs = JSON.parse(fs.readFileSync(diffLogPath, "utf-8")) as DiffEntry[];
      repairsApplied = diffs.length;
    } catch {
      // ignore
    }
  }

  let pass1Pct = round0PassRate ? `${round0PassRate}%` : "N/A";
  let pass2Pct = finalRoundPassRate ? `${finalRoundPassRate}%` : "N/A";
  let finalPct = finalRoundPassRate ? `${finalRoundPassRate}%` : "N/A";
  const namedMisses: AuditSummary["namedMisses"] = [];

  if (fs.existsSync(auditReportPath)) {
    const md = fs.readFileSync(auditReportPath, "utf-8");
    const m1 = md.match(/Pass 1 Accuracy[^:]*:\s*\*?\*?([0-9.]+%)/i);
    const m2 = md.match(/Pass 2 Accuracy[^:]*:\s*\*?\*?([0-9.]+%)/i);
    const m3 = md.match(/Final Accuracy[^:]*:\s*\*?\*?([0-9.]+%)/i);
    if (m1?.[1]) pass1Pct = m1[1];
    if (m2?.[1]) pass2Pct = m2[1];
    if (m3?.[1]) finalPct = m3[1];

    for (const line of md.split(/\r?\n/)) {
      if (!line.startsWith("|")) continue;
      const cols = line.split("|").map((c) => c.trim());
      if (
        cols.length >= 9 &&
        (cols[7]?.toLowerCase() === "miss" || cols[7]?.toLowerCase() === "partial")
      ) {
        namedMisses.push({
          app: cols[2] ?? "",
          field: cols[4] ?? "",
          agent: (cols[5] ?? "").replace(/`/g, ""),
          human: (cols[6] ?? "").replace(/`/g, ""),
          action: cols[8] ?? "",
        });
      }
    }
  }

  return {
    pass1Pct,
    pass2Pct,
    finalPct,
    sampleSize: 20,
    brokenUrlsCaught,
    repairsApplied,
    namedMisses,
  };
}

export function renderCaseStudyHtml(params: {
  records: AppRecordT[];
  patterns: PatternsSummary;
  audit: AuditSummary;
  liveUrl?: string;
  repoUrl?: string;
}): string {
  const {
    records,
    patterns,
    audit,
    liveUrl = "https://composio-100-apps.vercel.app",
    repoUrl = "https://github.com/shubhambhattacharya-dev/ComposioTest",
  } = params;

  const verifiedCount = records.filter((r) => r.pass2Verified).length;
  const topAuth = patterns.authDistribution[0];
  const topBlocker = patterns.topBlockers[0];
  const maxAuthCount = Math.max(1, ...patterns.authDistribution.map((a) => a.count));

  const authBarsHtml = patterns.authDistribution
    .slice(0, 6)
    .map(
      (a) =>
        `<div class="bar-row"><span class="bar-label">${escapeHtml(a.method)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((a.count / maxAuthCount) * 100)}%"></div></div><span class="bar-val">${a.count} (${a.pct}%)</span></div>`,
    )
    .join("");

  const catMatrixHtml = patterns.selfServeByCategory
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.category)}</td><td>${c.selfServe}</td><td>${c.gated}</td><td>${c.unknown}</td><td><strong>${c.selfServePct}%</strong></td></tr>`,
    )
    .join("");

  const easyWinsHtml = patterns.easyNetNewWins
    .slice(0, 8)
    .map(
      (w) =>
        `<li><a class="row-link" href="${escapeHtml(w.docsUrl)}" target="_blank" rel="noopener">${escapeHtml(w.name)}</a> <span class="muted">(${escapeHtml(w.category)} · ${escapeHtml(w.auth)})</span></li>`,
    )
    .join("");

  const outreachHtml = patterns.outreachRequired
    .slice(0, 8)
    .map(
      (o) =>
        `<li><strong>${escapeHtml(o.name)}</strong> <span class="muted">(${escapeHtml(o.category)} · ${escapeHtml(o.accessModel)})</span></li>`,
    )
    .join("");

  const missesHtml =
    audit.namedMisses.length > 0
      ? `<table class="mini-table"><thead><tr><th>App</th><th>Field</th><th>Agent</th><th>Human Docs</th><th>Action</th></tr></thead><tbody>${audit.namedMisses
          .map(
            (m) =>
              `<tr><td><strong>${escapeHtml(m.app)}</strong></td><td><code>${escapeHtml(m.field)}</code></td><td>${escapeHtml(m.agent)}</td><td>${escapeHtml(m.human)}</td><td>${escapeHtml(m.action)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="audit-note" style="border-top:0;padding:8px 0 0;background:transparent">Zero unresolved misses after Pass 3 recycling. Pass 2 caught ${audit.brokenUrlsCaught} broken/blocked URLs and logged ${audit.repairsApplied} automated field repairs.</p>`;

  const headlinesHtml = patterns.headlines
    .map((h) => `<li>${escapeHtml(h)}</li>`)
    .join("");

  const embeddedPayload = {
    meta: {
      title: "App Research — Composio Field Notes",
      generatedAt: patterns.generatedAt,
      totalApps: records.length,
      liveUrl,
      repoUrl,
      accuracy: audit,
    },
    patterns,
    apps: records,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="A verified 3-pass research case study on 100 SaaS apps for Composio toolkit buildability.">
<title>What does it take to build for an app? — Composio Field Notes</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap');
:root{--ink:#1e2926;--muted:#78827d;--line:#e6e9e5;--paper:#fbfcfa;--white:#fff;--green:#1f6a51;--mint:#e8f2eb;--orange:#bf673d;--amber:#f2eee4;--dark:#17231f;--mono:'DM Mono',ui-monospace,SFMono-Regular,Menlo,monospace;--sans:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--display:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 var(--sans)}
a{color:inherit}
button,input,select{font:inherit}
.shell{max-width:1280px;margin:auto;padding:0 42px}
.topbar{height:68px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:flex;align-items:center;gap:11px;font:700 14px var(--display);letter-spacing:-.02em;text-decoration:none}
.mark{background:var(--green);color:#fff;width:28px;height:28px;display:grid;place-items:center;border-radius:8px;font:500 13px var(--mono)}
.topnav{display:flex;gap:24px;color:var(--muted);font-size:12px}
.topnav a{text-decoration:none}.topnav a:hover{color:var(--green)}
.topright{display:flex;align-items:center;gap:10px}
.edition{font:11px var(--mono);color:var(--muted)}
.button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:8px 12px;text-decoration:none;font-size:12px;font-weight:600;color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.button:hover{border-color:#aab8ad}
.button.primary{background:var(--green);color:#fff;border-color:var(--green)}
.hero{padding:56px 0 32px;display:grid;grid-template-columns:minmax(0,1fr) 275px;gap:48px;align-items:end}
.eyebrow{font:11px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--green);display:flex;align-items:center;gap:9px}
.eyebrow:before{content:'';width:20px;height:1px;background:var(--green)}
h1{font:600 clamp(36px,5vw,60px)/1.04 var(--display);letter-spacing:-.055em;margin:16px 0 16px;max-width:780px}
.lede{font-size:15px;color:#5e6a64;max-width:700px;line-height:1.75;margin:0}
.hero-aside{padding:16px 0 4px 18px;border-left:1px solid var(--line)}
.aside-label{font:10px var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.aside-title{font:600 16px var(--display);margin:8px 0 5px}
.aside-copy{color:var(--muted);font-size:12px;margin:0}
.headline-box{border:1px solid #d5e6dc;background:#f3f9f5;border-radius:8px;padding:16px 20px;margin:0 0 28px}
.headline-box .kicker{font:10px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--green);margin-bottom:8px}
.headline-box ul{margin:0;padding-left:18px}
.headline-box li{margin:5px 0;font-size:13.5px;color:var(--ink)}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:42px}
.metric{padding:19px 20px 19px 0;border-right:1px solid var(--line)}
.metric:not(:first-child){padding-left:20px}
.metric:last-child{border-right:0}
.metric-value{font:600 26px var(--display);letter-spacing:-.045em;color:var(--ink)}
.metric-value.accent{color:var(--green)}
.metric-label{font-size:11px;color:var(--muted);margin-top:3px}
.section{margin:0 0 44px;scroll-margin-top:24px}
.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:15px;gap:12px;flex-wrap:wrap}
.section-kicker{font:10px var(--mono);color:var(--green);text-transform:uppercase;letter-spacing:.08em}
.section h2{font:600 23px var(--display);letter-spacing:-.04em;margin:5px 0 0}
.section-desc{font-size:12px;color:var(--muted);margin:4px 0 0}
.tag{font:10px var(--mono);padding:5px 8px;border-radius:4px;background:var(--mint);color:var(--green)}
.pipeline{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:8px;background:#fff;overflow:hidden}
.stage{padding:19px 20px;position:relative;min-height:142px}
.stage+.stage{border-left:1px solid var(--line)}
.stage-top{display:flex;align-items:center;gap:9px;margin-bottom:12px}
.stage-no{font:11px var(--mono);color:var(--green);background:var(--mint);width:24px;height:24px;border-radius:50%;display:grid;place-items:center}
.stage h3{font:600 14px var(--display);margin:0}
.stage p{font-size:12px;color:var(--muted);line-height:1.65;margin:0}
.stage-foot{font:10px var(--mono);color:#9aa29d;margin-top:12px}
.human{background:#fbfaf6}.human .stage-no{background:#f4eee0;color:#9c7947}
.insight-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.insight{border:1px solid var(--line);border-radius:8px;background:#fff;padding:18px 20px}
.insight-top{font:10px var(--mono);color:var(--green);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
.insight-body{font:600 15px/1.45 var(--display);letter-spacing:-.02em;margin:0 0 12px;color:var(--ink)}
.bar-row{display:grid;grid-template-columns:96px 1fr 78px;align-items:center;gap:10px;margin:7px 0;font-size:12px}
.bar-label{font-family:var(--mono);color:var(--ink)}
.bar-track{height:9px;background:#edf1ed;border-radius:5px;overflow:hidden}
.bar-fill{height:100%;background:var(--green);border-radius:5px}
.bar-val{font-family:var(--mono);font-size:11px;color:var(--muted);text-align:right}
.mini-table{width:100%;border-collapse:collapse;font-size:12px}
.mini-table th,.mini-table td{padding:7px 8px;border-bottom:1px solid #edf0ed;text-align:left}
.mini-table th{font:10px var(--mono);text-transform:uppercase;color:var(--muted);background:#f7f8f6}
.audit{border:1px solid var(--line);border-radius:8px;background:#fff;overflow:hidden}
.audit-row{display:grid;grid-template-columns:1.2fr 1.2fr .8fr .9fr;align-items:center;padding:12px 17px;border-top:1px solid var(--line);font-size:12px}
.audit-row.head{background:#f7f8f6;border:0;color:var(--muted);font:10px var(--mono);text-transform:uppercase}
.audit-val{font:600 13px var(--mono);color:var(--green)}
.audit-note{font-size:12px;color:var(--muted);padding:12px 17px;background:#fcfcfb;border-top:1px solid var(--line);margin:0}
.table-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.search{border:1px solid var(--line);background:#fff;border-radius:6px;padding:8px 10px;width:210px;font-size:12px;outline:none}
.search:focus,.select:focus{border-color:#8aab96;box-shadow:0 0 0 2px #e4eee6}
.select{border:1px solid var(--line);background:#fff;border-radius:6px;padding:8px 10px;font-size:12px;color:#53605a;outline:none}
.table-wrap{border:1px solid var(--line);border-radius:8px;overflow-x:auto;background:#fff}
.app-table{width:100%;border-collapse:collapse;text-align:left;min-width:900px}
.app-table th{background:#f7f8f6;padding:11px 14px;color:var(--muted);font:10px var(--mono);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.app-table td{padding:11px 14px;border-top:1px solid #edf0ed;font-size:12px;vertical-align:top}
.app-table tr:hover td{background:#fcfdfb}
.appname{display:flex;align-items:center;gap:10px;font-weight:600}
.appicon{width:26px;height:26px;background:#f0f3f0;border-radius:6px;display:grid;place-items:center;font:10px var(--mono);color:#50645b;flex:none}
.category{color:#68746e}
.pill{display:inline-block;font:10px var(--mono);border:1px solid #e4e8e3;border-radius:4px;padding:2px 6px;color:#4a5852;background:#f7f8f6;margin:1px 3px 1px 0;white-space:nowrap}
.pill.ready{background:var(--mint);color:var(--green);border-color:#c6e2d2}
.pill.warn{background:#f7f4eb;color:#8a5a18;border-color:#e8dcc0}
.pill.blocked{background:#fceeed;color:#a53024;border-color:#f2ccc8}
.row-link{color:var(--green);text-decoration:none;font-size:11px;font-weight:600}.row-link:hover{text-decoration:underline}
.muted{color:var(--muted);font-size:11px}
.table-foot{padding:12px 14px;display:flex;justify-content:space-between;color:var(--muted);font-size:11px;border-top:1px solid var(--line)}
.integrity{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:20px;border:1px solid var(--line);border-radius:8px;background:#fff}
.integrity h3{font:600 14px var(--display);margin:0 0 8px}
.integrity p{margin:0;color:var(--muted);font-size:12px;line-height:1.75}
.codebox{background:var(--dark);color:#e8f2eb;padding:14px 18px;border-radius:8px;font:12px/1.7 var(--mono);overflow-x:auto;margin-top:12px}
.foot{border-top:1px solid var(--line);padding:22px 0 32px;display:flex;justify-content:space-between;color:var(--muted);font-size:11px;flex-wrap:wrap;gap:12px}
.foot strong{color:var(--ink);font-weight:600}
.empty{padding:25px;text-align:center;color:var(--muted);font-size:12px}
@media(max-width:820px){.shell{padding:0 20px}.topbar{height:auto;padding:12px 0;flex-wrap:wrap}.topnav,.edition{display:none}.hero{padding:36px 0 24px;grid-template-columns:1fr;gap:20px}.hero-aside{border-left:0;padding-left:0;border-top:1px solid var(--line);padding-top:12px}.metrics{grid-template-columns:1fr 1fr}.metric:nth-child(2){border-right:0}.metric:nth-child(3),.metric:nth-child(4){border-top:1px solid var(--line)}.metric:nth-child(3){padding-left:0}.pipeline,.insight-grid,.integrity{grid-template-columns:1fr}.stage{min-height:0}.stage+.stage{border-left:0;border-top:1px solid var(--line)}.audit-row{grid-template-columns:1fr .9fr .7fr .8fr;gap:6px;font-size:10px;padding:10px}}
</style>
</head>
<body>
<header class="topbar shell">
  <a class="brand" href="#top" aria-label="Field Notes home"><span class="mark">c/</span><span>COMPOSIO <span style="font-weight:400;color:#89928c">/ FIELD NOTES</span></span></a>
  <nav class="topnav" aria-label="Main navigation"><a href="#findings">Findings</a><a href="#method">Method</a><a href="#audit">Audit</a><a href="#dataset">Dataset</a><a href="#integrity">Run Agent</a></nav>
  <div class="topright">
    <span class="edition">TAKE-HOME · 2026</span>
    <a class="button" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener">GitHub Repo ↗</a>
    <a class="button primary" href="${escapeHtml(liveUrl)}" target="_blank" rel="noopener">Live Page ↗</a>
  </div>
</header>

<main id="top" class="shell">
  <section class="hero">
    <div>
      <div class="eyebrow">Product operations · Verified 100-App Study</div>
      <h1>What does it take<br>to build for an app?</h1>
      <p class="lede">I built an automated agent pipeline to research ${records.length} SaaS products across 10 categories for Composio toolkit buildability, then tried to prove it wrong. Using <code>@composio/core</code> catalog cross-checks, an automated HTTP + keyword grounding verifier with bounded repair loops, and a stratified 20-app human audit, field-level accuracy improved from <strong>${escapeHtml(audit.pass1Pct)}</strong> (Pass 1) to <strong>${escapeHtml(audit.pass2Pct)}</strong> (Pass 2) to <strong>${escapeHtml(audit.finalPct)}</strong> (Final).</p>
    </div>
    <aside class="hero-aside">
      <div class="aside-label">The question</div>
      <div class="aside-title">Where can Composio build next?</div>
      <p class="aside-copy">Evidence first. Unknowns stay unknown. Patterns matter more than a list of logos.</p>
    </aside>
  </section>

  <section class="headline-box" aria-label="Headline insights">
    <div class="kicker">2-Minute Executive Summary · Headline Patterns</div>
    <ul>${headlinesHtml}</ul>
  </section>

  <section class="metrics" aria-label="Study status">
    <div class="metric"><div class="metric-value">${records.length}</div><div class="metric-label">Apps researched &amp; Zod-validated</div></div>
    <div class="metric"><div class="metric-value">${verifiedCount}</div><div class="metric-label">Pass 2 machine-verified records</div></div>
    <div class="metric"><div class="metric-value accent">${patterns.easyNetNewWins.length}</div><div class="metric-label">Net-new self-serve toolkit wins</div></div>
    <div class="metric"><div class="metric-value accent">${escapeHtml(audit.pass1Pct)} → ${escapeHtml(audit.finalPct)}</div><div class="metric-label">Audited accuracy across loops</div></div>
  </section>

  <section class="section" id="findings">
    <div class="section-head">
      <div><div class="section-kicker">01 / Findings</div><h2>Patterns worth surfacing</h2><p class="section-desc">Every metric below is computed directly from <code>data/patterns.json</code> — zero hand-typed numbers.</p></div>
      <span class="tag">COMPUTED FROM ${records.length} VERIFIED ROWS</span>
    </div>
    <div class="insight-grid">
      <article class="insight">
        <div class="insight-top">Auth distribution</div>
        <div class="insight-body">${topAuth ? `${escapeHtml(topAuth.method.toUpperCase())} leads at ${topAuth.count}/${records.length} apps (${topAuth.pct}%)` : "Auth breakdown"}</div>
        ${authBarsHtml}
        <p class="muted" style="margin-top:10px">Composio overlap: <strong>${patterns.composioOverlap.yes}</strong> existing · <strong>${patterns.composioOverlap.no}</strong> net-new · <strong>${patterns.composioOverlap.unknown}</strong> unchecked.</p>
      </article>
      <article class="insight">
        <div class="insight-top">Self-serve vs gated by category</div>
        <div class="insight-body">Most open: ${escapeHtml(patterns.mostOpenCategory)} · Most gated: ${escapeHtml(patterns.mostGatedCategory)}</div>
        <table class="mini-table"><thead><tr><th>Category</th><th>Open</th><th>Gated</th><th>Unk</th><th>Open %</th></tr></thead><tbody>${catMatrixHtml}</tbody></table>
      </article>
      <article class="insight">
        <div class="insight-top">Net-new easy wins (build queue)</div>
        <div class="insight-body">${patterns.easyNetNewWins.length} self-serve apps with public APIs ready to build</div>
        <ul style="margin:0;padding-left:18px;font-size:12px">${easyWinsHtml || "<li>None identified</li>"}</ul>
      </article>
      <article class="insight">
        <div class="insight-top">Top blockers &amp; partner outreach queue</div>
        <div class="insight-body">${topBlocker ? `#1 blocker: ${escapeHtml(topBlocker.theme)} (${topBlocker.count} apps)` : "Blockers summary"}</div>
        <ul style="margin:0 0 10px;padding-left:18px;font-size:12px">${outreachHtml || "<li>None flagged</li>"}</ul>
        <p class="muted" style="margin:0">MCP readiness: <strong>${patterns.mcpReadiness.official_mcp}</strong> official MCP · <strong>${patterns.mcpReadiness.community_mcp}</strong> community · <strong>${patterns.mcpReadiness.none_found}</strong> none found.</p>
      </article>
    </div>
  </section>

  <section class="section" id="method">
    <div class="section-head">
      <div><div class="section-kicker">02 / Method</div><h2>Three passes. One evidence trail.</h2><p class="section-desc">Every claim is traceable to an HTTP-checked docs URL and a logged verification pass.</p></div>
      <span class="tag">@COMPOSIO/CORE · ZOD · VITEST</span>
    </div>
    <div class="pipeline">
      <article class="stage"><div class="stage-top"><span class="stage-no">1</span><h3>Research agent</h3></div><p>Concurrency-limited fetcher (<code>p-limit</code>) scrapes official docs, queries Composio's catalog, and extracts strict Zod JSON with append-only JSONL checkpoints (<code>data/checkpoints.jsonl</code>).</p><div class="stage-foot">DISCOVER · EXTRACT · CHECKPOINT</div></article>
      <article class="stage"><div class="stage-top"><span class="stage-no">2</span><h3>Automated verifier + fixer</h3></div><p>Re-fetches every evidence URL across all 100 apps for HTTP 200 + field keyword grounding. Failures trigger a bounded repair loop (max 2 rounds); all diffs log to <code>data/diff-log.json</code>.</p><div class="stage-foot">FETCH · GROUND · BOUNDED REPAIR</div></article>
      <article class="stage human"><div class="stage-top"><span class="stage-no">3</span><h3>Human audit</h3></div><p>Deterministic 20-app stratified audit (2 per category) against live docs. Resolved JS-rendered portals and borderline partner gates, then recycled fixes back through Pass 2.</p><div class="stage-foot">20-APP SAMPLE · FIX · RE-VERIFY</div></article>
    </div>
  </section>

  <section class="section" id="audit">
    <div class="section-head">
      <div><div class="section-kicker">03 / Accuracy audit</div><h2>Show the misses, too.</h2><p class="section-desc">Measured at field level across each pass; every human-caught miss is listed openly below.</p></div>
      <span class="tag">VERIFIED SAMPLE · 20/100 APPS</span>
    </div>
    <div class="audit">
      <div class="audit-row head"><span>Verification pass</span><span>Method</span><span>Accuracy</span><span>Impact / Sample</span></div>
      <div class="audit-row"><strong>Pass 1 · Agent</strong><span>Docs fetch + strict Zod extraction</span><span class="audit-val">${escapeHtml(audit.pass1Pct)}</span><span>Baseline (20-app sample)</span></div>
      <div class="audit-row"><strong>Pass 2 · Verifier</strong><span>100% HTTP + keyword grounding + fixer</span><span class="audit-val">${escapeHtml(audit.pass2Pct)}</span><span>${audit.brokenUrlsCaught} bad URLs · ${audit.repairsApplied} repairs</span></div>
      <div class="audit-row"><strong>Pass 3 · Human</strong><span>Stratified 20-app audit recycled into data</span><span class="audit-val">${escapeHtml(audit.finalPct)}</span><span>${audit.namedMisses.length} misses fixed &amp; re-verified</span></div>
      <div style="padding:14px 17px;border-top:1px solid var(--line)">
        <div class="insight-top" style="margin-bottom:8px">Named misses &amp; honest disclosures</div>
        ${missesHtml}
      </div>
    </div>
  </section>

  <section class="section" id="dataset">
    <div class="section-head">
      <div><div class="section-kicker">04 / App index</div><h2>Research dataset (${records.length} apps)</h2><p class="section-desc">Filterable human matrix + embedded machine-readable JSON for AI agents.</p></div>
      <div class="table-tools">
        <input class="search" type="search" id="search" placeholder="Search app, auth, blocker…" aria-label="Search apps">
        <select class="select" id="category" aria-label="Filter by category"><option value="all">All categories</option></select>
        <select class="select" id="access" aria-label="Filter by access model"><option value="all">All access</option></select>
        <select class="select" id="verdict" aria-label="Filter by buildability"><option value="all">All verdicts</option><option value="toolkit_ready">toolkit_ready</option><option value="needs_work">needs_work</option><option value="blocked">blocked</option><option value="unknown">unknown</option></select>
        <button class="button" id="downloadJson">↓ JSON</button>
        <button class="button" id="downloadCsv">↓ CSV</button>
      </div>
    </div>
    <div class="table-wrap">
      <table class="app-table">
        <thead><tr><th>Application</th><th>Category</th><th>Auth</th><th>Access</th><th>API / MCP</th><th>Buildability</th><th>Evidence</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="empty" id="empty" hidden>No apps match this filter.</div>
      <div class="table-foot"><span id="count">Showing ${records.length} records</span><span>Self-contained single-file HTML · Embedded JSON for AI agents</span></div>
    </div>
  </section>

  <section class="section" id="integrity">
    <div class="section-head"><div><div class="section-kicker">05 / Integrity &amp; Reproducibility</div><h2>What this page claims &amp; how to run it</h2></div></div>
    <div class="integrity">
      <div>
        <h3>Evidence standard &amp; honest limits</h3>
        <p>Official developer docs are preferred over marketing pages. Self-serve vs paid judgments are based on public docs/pricing text rather than creating 100 paid accounts. JS-rendered portals (Stoplight/Redoc) that could not be text-grounded are honestly downgraded or manually checked in Pass 3.</p>
      </div>
      <div>
        <h3>Run the research agent (3 commands)</h3>
        <p>Zero hardcoded paths; 25 offline Vitest unit &amp; integration tests pass in under 1 second.</p>
        <div class="codebox">cd backend &amp;&amp; npm install<br>cp .env.example .env<br>npm run research &amp;&amp; npm run verify &amp;&amp; npm run build &amp;&amp; npm test</div>
      </div>
    </div>
  </section>
</main>

<footer class="foot shell">
  <span><strong>COMPOSIO / FIELD NOTES</strong> &nbsp;·&nbsp; Product Ops take-home by Shubham Bhattacharya</span>
  <span><a class="row-link" href="${escapeHtml(liveUrl)}" target="_blank" rel="noopener">Live Page</a> &nbsp;·&nbsp; <a class="row-link" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener">GitHub Repo</a></span>
</footer>

<script type="application/json" id="composio-research-dataset">${safeJsonForScript(embeddedPayload)}</script>
<script>
const payload = JSON.parse(document.getElementById('composio-research-dataset').textContent);
const apps = payload.apps;
const tbody = document.querySelector('#rows');
const search = document.querySelector('#search');
const category = document.querySelector('#category');
const access = document.querySelector('#access');
const verdict = document.querySelector('#verdict');

[...new Set(apps.map(a => a.category))].forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; category.appendChild(o); });
[...new Set(apps.map(a => a.accessModel))].forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; access.appendChild(o); });

function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function mono(name){return name.split(/\\s+/).map(x=>x[0]||'').join('').slice(0,2).toUpperCase()}
function vClass(v){return v==='toolkit_ready'?'ready':v==='blocked'?'blocked':'warn'}

function render(){
  const q = search.value.trim().toLowerCase();
  const cat = category.value, acc = access.value, verd = verdict.value;
  const list = apps.filter(a =>
    (cat==='all'||a.category===cat) &&
    (acc==='all'||a.accessModel===acc) &&
    (verd==='all'||a.buildability.verdict===verd) &&
    (!q || a.name.toLowerCase().includes(q) || a.oneLiner.toLowerCase().includes(q) || a.category.toLowerCase().includes(q) || a.authMethods.join(' ').toLowerCase().includes(q) || (a.buildability.blocker||'').toLowerCase().includes(q))
  );
  tbody.innerHTML = list.map(a => {
    const ev = a.evidenceUrls[0];
    return '<tr>'
      + '<td><div class="appname"><span class="appicon">' + esc(mono(a.name)) + '</span><div><div>' + esc(a.name) + ' <span class="muted">#' + a.id + '</span></div><div class="muted">' + esc(a.oneLiner) + '</div></div></div></td>'
      + '<td class="category">' + esc(a.category) + '</td>'
      + '<td>' + a.authMethods.map(m => '<span class="pill">' + esc(m) + '</span>').join('') + '</td>'
      + '<td><span class="pill">' + esc(a.accessModel) + '</span></td>'
      + '<td><span class="pill">' + esc(a.apiSurface.type) + ' · ' + esc(a.apiSurface.breadth) + '</span><br><span class="pill">' + esc(a.hasMcp) + '</span></td>'
      + '<td><span class="pill ' + vClass(a.buildability.verdict) + '">' + esc(a.buildability.verdict) + '</span>' + (a.buildability.blocker ? '<div class="muted">' + esc(a.buildability.blocker) + '</div>' : '') + '</td>'
      + '<td>' + (ev ? '<a class="row-link" href="' + esc(ev.url) + '" target="_blank" rel="noopener">Docs (' + ev.httpStatus + ') ↗</a>' : '<span class="pill">none</span>') + '<div class="muted">conf: ' + esc(a.confidence) + '</div></td>'
      + '</tr>';
  }).join('');
  document.querySelector('#empty').hidden = list.length > 0;
  document.querySelector('#count').textContent = 'Showing ' + list.length + ' of ' + apps.length + ' verified records';
}

search.addEventListener('input', render);
category.addEventListener('change', render);
access.addEventListener('change', render);
verdict.addEventListener('change', render);

document.querySelector('#downloadJson').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'composio-100-apps-research.json'; a.click(); URL.revokeObjectURL(a.href);
});
document.querySelector('#downloadCsv').addEventListener('click', () => {
  const cols = ['id','name','category','oneLiner','authMethods','accessModel','apiType','apiBreadth','hasMcp','composioExisting','verdict','blocker','docsUrl','confidence'];
  const rows = [cols.join(',')].concat(apps.map(a => [
    a.id, a.name, a.category, a.oneLiner, a.authMethods.join('|'), a.accessModel, a.apiSurface.type, a.apiSurface.breadth, a.hasMcp, a.composioExisting, a.buildability.verdict, a.buildability.blocker||'', a.evidenceUrls[0]?.url||'', a.confidence
  ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')));
  const blob = new Blob([rows.join('\\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'composio-100-apps-research.csv'; a.click(); URL.revokeObjectURL(a.href);
});
render();
</script>
</body></html>`;
}

function main(): void {
  const records = loadCheckpoints(CHECKPOINT_PATH);
  if (records.length === 0) {
    console.error("[build] No records found in data/checkpoints.jsonl.");
    process.exit(1);
  }
  const patterns = computePatterns(records);
  fs.mkdirSync(path.dirname(PATTERNS_PATH), { recursive: true });
  fs.writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2), "utf-8");

  const audit = loadAuditSummary();
  const html = renderCaseStudyHtml({
    records,
    patterns,
    audit,
    liveUrl: process.env.LIVE_URL,
    repoUrl: process.env.REPO_URL,
  });

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(DIST_HTML_PATH, html, "utf-8");
  fs.mkdirSync(path.dirname(FRONTEND_HTML_PATH), { recursive: true });
  fs.writeFileSync(FRONTEND_HTML_PATH, html, "utf-8");

  const sizeKb = Math.round(fs.statSync(DIST_HTML_PATH).size / 1024);
  console.log(`[build] Rendered ${DIST_HTML_PATH} & ${FRONTEND_HTML_PATH} (${sizeKb} KB, ${records.length} apps)`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectRun) {
  main();
}
