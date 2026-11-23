# Composio 100-App Research Agent

An agent-built Product Ops research pipeline across **100 SaaS apps (10 categories)** evaluating toolkit buildability: authentication methods, self-serve vs gated access, API surface, MCP readiness, and Composio catalog overlap — verified by a deterministic HTTP + keyword grounding pass and a stratified 20-app human audit.

## Live Deliverable
- **Case study page (Vercel):** *(update after deploy)*
- **Self-contained offline file:** `backend/dist/index.html` (`< 1 MB`, opens directly via `file://` with embedded JSON + CSV/JSON download buttons)

## Quick Start (Reviewer Commands)
```bash
cd backend
npm install
cp .env.example .env   # add COMPOSIO_API_KEY + GEMINI_API_KEY (or GROQ_API_KEY)
npm test               # offline Vitest suite (25 tests, <1s, zero network)
```

## Run Full 3-Pass Pipeline
```bash
cd backend
npm run research       # Pass 1: fetch official docs, Composio SDK catalog check, Zod JSON -> data/checkpoints.jsonl
npm run verify         # Pass 2: 100% HTTP 200 + keyword grounding + bounded fixer loop -> data/verify-log.json, data/diff-log.json
npm run sample         # Pass 3: deterministic 20-app stratified sample (2/category) -> audit/audit-report.md
npm run build          # Compute data/patterns.json + render self-contained dist/index.html
npm run audit          # Final integrity check: 100 unique IDs, schema validity, URLs, HTML size & embedded JSON
```

## Architecture & Human-in-the-Loop
- **Pass 1 (Agent):** Concurrency-limited (`p-limit`) docs fetcher + `@composio/core` catalog cross-check + multi-provider LLM failover (`gemini-3.8-flash` → Groq `openai/gpt-oss-20b`) + append-only JSONL checkpoints (crash-safe resume).
- **Pass 2 (Automated Verifier + Fixer):** Re-fetches every evidence URL across all 100 apps, verifies HTTP 200 and field-specific grounding keywords (auth, GraphQL, MCP, pricing), detects JS-only shells, and runs a bounded repair loop (`max 2 rounds`), logging every change to `data/diff-log.json`.
- **Pass 3 (Human Audit):** Stratified 20-app audit (`audit/audit-report.md`) resolving JS-rendered portals and borderline partner-gating calls; fixes are recycled back into `data/checkpoints.jsonl` and re-verified by Pass 2.

## Repo Hygiene
- `.env` and `node_modules/` are gitignored; zero secrets committed.
- `backend/data/` and `backend/audit/` are committed as verifiable process artifacts.
