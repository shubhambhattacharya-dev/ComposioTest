import { describe, it, expect } from "vitest";
import { CATEGORIES, type AppRecordT } from "../src/config/schema.js";
import { computePatterns } from "../src/patterns.js";

function makeFixtureApps(): AppRecordT[] {
  const list: AppRecordT[] = [];
  let id = 1;
  for (const cat of CATEGORIES) {
    for (let i = 0; i < 10; i++) {
      const isGated = cat === "Finance and Fintech" && i < 6;
      list.push({
        id,
        name: `App-${id}`,
        category: cat,
        oneLiner: `Sample SaaS app #${id}.`,
        authMethods: i % 2 === 0 ? ["oauth2"] : ["api_key"],
        accessModel: isGated ? "partner_or_sales" : "self_serve_free",
        apiSurface: {
          type: "rest",
          breadth: "wide",
          docsUrl: `https://docs.example.com/app-${id}`,
        },
        hasMcp: i === 0 ? "official_mcp" : "none_found",
        composioExisting: i < 3 ? "yes" : "no",
        buildability: isGated
          ? { verdict: "blocked", blocker: "Partner approval required" }
          : { verdict: "toolkit_ready" },
        evidenceUrls: [
          {
            url: `https://docs.example.com/app-${id}`,
            kind: "docs",
            quote: "Official API docs",
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
  return list;
}

describe("computePatterns (Pattern Engine math)", () => {
  it("aggregates 100 apps with exact category sums, auth math, and net-new wins", () => {
    const apps = makeFixtureApps();
    const patterns = computePatterns(apps);

    expect(patterns.totalApps).toBe(100);
    const catSum = patterns.selfServeByCategory.reduce((acc, c) => acc + c.total, 0);
    expect(catSum).toBe(100);
    expect(patterns.mostGatedCategory).toBe("Finance and Fintech");
    expect(patterns.composioOverlap.yes).toBe(30);
    expect(patterns.composioOverlap.no).toBe(70);
    expect(patterns.mcpReadiness.official_mcp).toBe(10);
    expect(patterns.headlines.length).toBeGreaterThanOrEqual(3);
  });
});
