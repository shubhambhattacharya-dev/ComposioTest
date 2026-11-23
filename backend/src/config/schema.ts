import { z } from "zod";

export const CATEGORIES = [
  "CRM and Sales",
  "Support and Helpdesk",
  "Comms and Messaging",
  "Marketing and Ads",
  "Ecommerce",
  "Data SEO and Scraping",
  "Dev Infra and Data",
  "Productivity and PM",
  "Finance and Fintech",
  "AI Research and Media",
] as const;

export const CATEGORY = z.enum(CATEGORIES);
export type CategoryT = z.infer<typeof CATEGORY>;

export const AuthMethod = z.enum([
  "oauth2",
  "oauth1",
  "api_key",
  "basic",
  "bearer_token",
  "jwt",
  "hmac",
  "session_cookie",
  "none",
  "other",
  "unknown",
]);
export type AuthMethodT = z.infer<typeof AuthMethod>;

export const AccessModel = z.enum([
  "self_serve_free",
  "self_serve_trial",
  "self_serve_paid",
  "admin_approval",
  "partner_or_sales",
  "open_source",
  "unknown",
]);
export type AccessModelT = z.infer<typeof AccessModel>;

export const McpStatus = z.enum([
  "official_mcp",
  "community_mcp",
  "sdk_only",
  "none_found",
  "unknown",
]);
export type McpStatusT = z.infer<typeof McpStatus>;

export const SeedApp = z.object({
  id: z.number().int().min(1).max(100),
  name: z.string().min(1),
  category: CATEGORY,
  hint: z.string().url(),
  note: z.string().optional(),
});
export type SeedAppT = z.infer<typeof SeedApp>;

export const Evidence = z.object({
  url: z.string().url(),
  kind: z.enum(["docs", "pricing", "blog", "github", "changelog", "other"]),
  quote: z.string().max(500),
  fetchedAt: z.string().datetime(),
  httpStatus: z.number().int(),
});
export type EvidenceT = z.infer<typeof Evidence>;

export const AppRecord = z.object({
  id: z.number().int().min(1).max(100),
  name: z.string().min(1),
  category: CATEGORY,
  oneLiner: z.string().min(1).max(140),
  authMethods: z.array(AuthMethod).min(1),
  accessModel: AccessModel,
  apiSurface: z.object({
    type: z.enum([
      "rest",
      "graphql",
      "grpc",
      "cli",
      "webhook",
      "none_found",
      "unknown",
    ]),
    breadth: z.enum(["narrow", "medium", "wide", "unknown"]),
    docsUrl: z.string().url(),
  }),
  hasMcp: McpStatus,
  composioExisting: z.enum(["yes", "no", "unknown"]),
  buildability: z.object({
    verdict: z.enum(["toolkit_ready", "needs_work", "blocked", "unknown"]),
    blocker: z.string().max(180).optional(),
  }),
  evidenceUrls: z.array(Evidence).min(1),
  confidence: z.enum(["high", "medium", "low"]),
  pass2Verified: z.boolean().default(false),
  auditedByHuman: z.boolean().default(false),
});
export type AppRecordT = z.infer<typeof AppRecord>;
