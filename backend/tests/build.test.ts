import { describe, it, expect } from "vitest";
import { CATEGORIES, type AppRecordT } from "../src/config/schema.js";
import { computePatterns } from "../src/patterns.js";
import { renderCaseStudyHtml } from "../src/build-html.js";

function makeFixture100(): AppRecordT[] {
  const out: AppRecordT[] = [];
  let id = 1;
  for (const cat of CATEGORIES) {
    for (let i = 0; i < 10; i++) {
      out.push({
        id,
        name: `SaaS-${id}`,
        category: cat,
        oneLiner: `Cloud platform #${id} with public REST API.`,
        authMethods: ["oauth2"],
        accessModel: "self_serve_free",
        apiSurface: { type: "rest", breadth: "wide", docsUrl: `https://docs.example.com/${id}` },
        hasMcp: "none_found",
        composioExisting: "no",
        buildability: { verdict: "toolkit_ready" },
        evidenceUrls: [
          {
            url: `https://docs.example.com/${id}`,
            kind: "docs",
            quote: "OAuth 2.0 docs",
            fetchedAt: "2026-11-23T10:00:00.000Z",
            httpStatus: 200,
          },
        ],
        confidence: "high",
        pass2Verified: true,
        auditedByHuman: false,
      });
      id++;
    }
  }
  return out;
}

describe("renderCaseStudyHtml (single-file HTML builder)", () => {
  it("renders valid single-file HTML < 1 MB with 100 embedded JSON apps and no undefined leaks", () => {
    const records = makeFixture100();
    const patterns = computePatterns(records);
    const html = renderCaseStudyHtml({
      records,
      patterns,
      audit: {
        pass1Pct: "80%",
        pass2Pct: "94%",
        finalPct: "98%",
        sampleSize: 20,
        brokenUrlsCaught: 6,
        repairsApplied: 11,
        namedMisses: [],
      },
    });

    const sizeBytes = Buffer.byteLength(html, "utf-8");
    expect(sizeBytes).toBeLessThan(1024 * 1024);
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain(">undefined<");

    const match = html.match(
      /<script type="application\/json" id="composio-research-dataset">([\s\S]*?)<\/script>/,
    );
    expect(match?.[1]).toBeTruthy();
    const parsed = JSON.parse(match![1]!) as { apps: AppRecordT[] };
    expect(parsed.apps.length).toBe(100);
  });
});
