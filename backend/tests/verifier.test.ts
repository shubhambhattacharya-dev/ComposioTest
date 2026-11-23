import { describe, it, expect, vi } from "vitest";
import { verifyRecord } from "../src/verify.js";
import type { AppRecordT } from "../src/config/schema.js";

const baseRecord: AppRecordT = {
  id: 21,
  name: "Slack",
  category: "Comms and Messaging",
  oneLiner: "Team messaging platform with Web API.",
  authMethods: ["oauth2"],
  accessModel: "self_serve_free",
  apiSurface: {
    type: "rest",
    breadth: "wide",
    docsUrl: "https://api.slack.com/docs",
  },
  hasMcp: "official_mcp",
  composioExisting: "yes",
  buildability: { verdict: "toolkit_ready" },
  evidenceUrls: [
    {
      url: "https://api.slack.com/docs",
      kind: "docs",
      quote: "Use OAuth 2.0 and MCP server.",
      fetchedAt: "2026-11-23T10:00:00.000Z",
      httpStatus: 200,
    },
  ],
  confidence: "high",
  pass2Verified: false,
  auditedByHuman: false,
};

describe("verifyRecord (offline mocked fetch)", () => {
  it("passes when HTTP 200 and required auth + MCP keywords appear in body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => "<html><body>Slack API uses OAuth 2.0 and provides an official MCP server.</body></html>",
    }) as unknown as typeof fetch;

    const verdict = await verifyRecord(baseRecord, mockFetch);
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("reports http_404 when evidence URL is broken", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
      text: async () => "Not Found",
    }) as unknown as typeof fetch;

    const verdict = await verifyRecord(baseRecord, mockFetch);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain("http_404:");
  });

  it("reports grounding_miss when page lacks claimed auth/MCP keywords", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => "<html><body>Welcome to our marketing landing page for teams.</body></html>",
    }) as unknown as typeof fetch;

    const verdict = await verifyRecord(baseRecord, mockFetch);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain("grounding_miss:");
    expect(verdict.failures[0]).toContain("auth=oauth2");
    expect(verdict.failures[0]).toContain("hasMcp=official_mcp");
  });

  it("flags JS shell when page has SPA root and minimal text", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '<html><body><div id="root"></div><script>/* stoplight */</script></body></html>',
    }) as unknown as typeof fetch;

    const verdict = await verifyRecord(baseRecord, mockFetch);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain("js_shell_ungrounded:");
  });
});
