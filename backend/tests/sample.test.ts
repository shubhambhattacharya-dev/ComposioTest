import { describe, it, expect } from "vitest";
import { CATEGORIES, type AppRecordT } from "../src/config/schema.js";
import { stratifiedSample } from "../src/sample.js";

function makeDummy100(): AppRecordT[] {
  const out: AppRecordT[] = [];
  let id = 1;
  for (const cat of CATEGORIES) {
    for (let i = 0; i < 10; i++) {
      out.push({
        id,
        name: `App-${id}`,
        category: cat,
        oneLiner: "Dummy app",
        authMethods: ["oauth2"],
        accessModel: "self_serve_free",
        apiSurface: { type: "rest", breadth: "medium", docsUrl: "https://example.com" },
        hasMcp: "none_found",
        composioExisting: "no",
        buildability: { verdict: "toolkit_ready" },
        evidenceUrls: [
          {
            url: "https://example.com",
            kind: "docs",
            quote: "OAuth 2.0",
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

describe("stratifiedSample (Pass 3 deterministic picker)", () => {
  it("picks exactly 2 apps per category = 20 apps deterministically", () => {
    const apps = makeDummy100();
    const sample = stratifiedSample(apps, 2);
    expect(sample.length).toBe(20);

    for (const cat of CATEGORIES) {
      const inCat = sample.filter((a) => a.category === cat);
      expect(inCat.length).toBe(2);
    }
    expect(sample[0]?.id).toBe(1);
    expect(sample[1]?.id).toBe(2);
  });
});
