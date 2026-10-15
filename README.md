# Wonder

A report builder that people who are not data scientists can use, and trust.

- `docs/RESEARCH.md`: what is missing in reporting and analytics tools (October 2026), with sources.
- `docs/SPEC.md`: the product and architecture spec that follows from the research.
- `app/`: the implementation (Vite, React, TypeScript, DuckDB-WASM, Vega-Lite).

## Run it

```bash
cd app
pnpm install
pnpm gen:data   # regenerate the synthetic firm dataset in public/data (already committed)
pnpm dev        # http://localhost:5173
pnpm test       # compiler and template tests against native DuckDB
pnpm check:browser  # with pnpm dev running: drives headless Chrome, runs every template in DuckDB-WASM, screenshots to docs/screens
pnpm check:browser -- --assistant  # also exercises the assistant end to end (calls a model; opt-in)
pnpm build
```

## The assistant without an API key

If the Claude Code CLI is installed and logged in on the machine running `pnpm dev` (or `pnpm preview`), the assistant uses it automatically: the dev server exposes `/api/assistant`, which runs each request through `claude -p --json-schema …` on that login (`app/server/assistant.ts`). The browser never holds a key. Without the CLI, the panel falls back to asking for an Anthropic API key stored only in the browser.

Note: the WASM build of DuckDB is not identical to the native one (for example it lacks `DATE - DATE`), so the browser check is the one that proves a model expression works for users.

The sample data is a synthetic accounting / professional-services firm: clients, staff, engagements, time entries, invoices, payments. Everything runs in the browser; the first load fetches the DuckDB-WASM bundle from a CDN.

## How it works

1. A **semantic model** (`app/src/data/practiceModel.ts`) declares tables, dimensions, measures, derived metrics, and relationships with cardinality.
2. The builder produces a small JSON **QuerySpec** (`app/src/core/query.ts`): fields, filters, sort, limit. Never SQL.
3. A deterministic **compiler** (`app/src/core/compiler.ts`) turns the spec into DuckDB SQL. Each measure is aggregated inside its own table before tables are combined, so joins can never double count. Combinations that would double count are refused with a plain-language message.
4. Every compiled query carries an **explanation** (summary sentence, per-measure definition and join path, concrete filter dates) shown in the "How is this calculated?" panel, with the SQL collapsed underneath.
5. The optional **assistant** (`app/src/ui/Assistant.tsx`) asks Claude for a QuerySpec via structured output, validates it with the compiler, and shows the chosen fields as shelves. It asks a question instead of guessing when a request is ambiguous.
