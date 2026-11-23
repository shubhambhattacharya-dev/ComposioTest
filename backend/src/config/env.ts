import { z } from "zod";

const nonEmptyOptional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

export const envSchema = z
  .object({
    LOG_LEVEL: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("INFO"),
    HOST: z.string().trim().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    COMPOSIO_API_KEY: z.string().trim().min(1, "Composio API key is required"),
    GEMINI_API_KEY: nonEmptyOptional,
    GROQ_API_KEY: nonEmptyOptional,
    OPENAI_API_KEY: nonEmptyOptional,
    RESEARCH_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(6),
    FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(12000),
  })
  .refine(
    (data) =>
      Boolean(data.GEMINI_API_KEY || data.GROQ_API_KEY || data.OPENAI_API_KEY),
    {
      message:
        "At least one LLM API key (GEMINI_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY) must be provided",
      path: ["GEMINI_API_KEY"],
    },
  );

export type EnvT = z.infer<typeof envSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): EnvT {
  return envSchema.parse(source);
}
