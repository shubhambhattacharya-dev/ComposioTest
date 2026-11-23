import { describe, it, expect } from "vitest";
import { envSchema, loadEnv } from "../src/config/env.js";

const validBase = {
  COMPOSIO_API_KEY: "comp_test_123",
  GEMINI_API_KEY: "gem_test_456",
};

describe("envSchema & loadEnv (offline config validation)", () => {
  it("parses valid minimal env and applies production defaults", () => {
    const env = loadEnv(validBase);
    expect(env.LOG_LEVEL).toBe("INFO");
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.PORT).toBe(3000);
    expect(env.RESEARCH_CONCURRENCY).toBe(6);
    expect(env.FETCH_TIMEOUT_MS).toBe(12000);
    expect(env.COMPOSIO_API_KEY).toBe("comp_test_123");
    expect(env.GEMINI_API_KEY).toBe("gem_test_456");
  });

  it("accepts GROQ_API_KEY or OPENAI_API_KEY as alternative LLM providers", () => {
    const groqOnly = loadEnv({
      COMPOSIO_API_KEY: "comp_test_123",
      GROQ_API_KEY: "gsk_test_789",
    });
    expect(groqOnly.GROQ_API_KEY).toBe("gsk_test_789");
    expect(groqOnly.GEMINI_API_KEY).toBeUndefined();
  });

  it("rejects missing or blank COMPOSIO_API_KEY", () => {
    expect(envSchema.safeParse({ GEMINI_API_KEY: "gem_123" }).success).toBe(false);
    expect(
      envSchema.safeParse({ COMPOSIO_API_KEY: "   ", GEMINI_API_KEY: "gem_123" })
        .success,
    ).toBe(false);
  });

  it("rejects when all LLM API keys are missing or blank", () => {
    const res = envSchema.safeParse({
      COMPOSIO_API_KEY: "comp_test_123",
      GEMINI_API_KEY: "",
      GROQ_API_KEY: "   ",
    });
    expect(res.success).toBe(false);
  });

  it("rejects invalid LOG_LEVEL enum value", () => {
    const res = envSchema.safeParse({ ...validBase, LOG_LEVEL: "VERBOSE" });
    expect(res.success).toBe(false);
  });

  it("rejects non-numeric PORT or out-of-range concurrency (prevents NaN bug)", () => {
    expect(envSchema.safeParse({ ...validBase, PORT: "abc" }).success).toBe(false);
    expect(
      envSchema.safeParse({ ...validBase, RESEARCH_CONCURRENCY: "0" }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...validBase, FETCH_TIMEOUT_MS: "50" }).success,
    ).toBe(false);
  });
});
