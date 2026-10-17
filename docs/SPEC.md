# Wonder: a report builder non-data people can trust

Status: v0 spec, October 13 2026. See `RESEARCH.md` for the evidence behind every design decision.

## 1. The problem in one paragraph

Three generations of "self-service BI" have left employee usage of reporting tools at about 30%. Business users don't build reports because the tools either (a) let them silently produce wrong numbers (double counting from joins, inner-join exclusion, divergent metric definitions) or (b) require a data person to pre-build everything, so every question becomes a ticket. AI chat on top of the same tools has not fixed this: vendors' own docs say "mistakes are possible," and three in four business users have shipped a wrong AI number. The result is the same everywhere: people export to Excel and ask an analyst.

## 2. Thesis

A report builder is trustworthy for non-experts when four things hold at once:

1. **It cannot produce a wrong number.** Every field comes from a governed semantic model with declared join cardinality. The compiler refuses, in plain language, any combination that would double count.
2. **Every number explains itself.** "How was this calculated" is one click away and written for a business reader: the definition, the join path, the concrete date range, and the SQL for anyone who wants it.
3. **The starting point is a finished report, not a blank canvas.** A vertical template library of the reports the audience is actually judged on. Users edit, they don't start from nothing.
4. **The report is data, not code.** A report is a small JSON intent (fields, filters, sort, chart). That makes it saveable, shareable, diffable, schedulable, exportable, and generatable by an assistant whose output is validated before anything runs.

AI is layered on top as an assistant that proposes intent against the model. It never writes SQL.

## 3. Who it's for

- **Primary:** people who own a number but not a database. Partners, practice managers, ops leads, finance managers, account managers. They know Excel pivot tables. They do not know SQL and should never see a join.
- **Secondary:** the admin or vendor who maintains the semantic model (a few hours per quarter, not a team).
- **First vertical:** professional-services and accounting-firm practice management, where the research found the sharpest, best-documented gap (custom reports are a $6,000 add-on, a beta feature, a SQL extract, or "too complicated"). The engine is vertical-agnostic; only the model and templates are vertical.

## 4. Product surface (v1)

### 4.1 Report builder

A single screen, in the shape of a pivot table users already know.

- **Field picker (left).** Fields grouped by subject (Clients, Invoices, Time...), searchable, each with a plain-language description on hover. Measures and dimensions are visually distinct. Fields that cannot be safely combined with the current report are shown greyed with the reason ("would double count Total Billed").
- **Shelves (top).** Group by (dimensions, with time grain selectors for dates), Show (measures and metrics), Filters (as pills, always visible, with relative-date presets like "last quarter" resolved to concrete dates on hover), Sort, Row limit.
- **Result (center).** A table by default; the chart type auto-picks from the field shapes (one date dimension and one measure gives a line; one category and one measure gives a bar) with one-click override to table, bar, line, or pie. Numbers formatted per the model (currency, percent, hours).
- **Explain panel (right, toggle).** Three sections: the one-sentence summary ("Total Billed and Realization % by Client, for invoices issued in the last 12 months (2025-11-01 to 2026-10-14)"), one line per measure (definition and join path), and the compiled SQL in a collapsible block.
- **Cannot-answer state.** When a combination would fan out, the builder shows an inline message naming both fields and the reason, plus which fields are safe to combine. It never shows a number it cannot stand behind.

### 4.2 Templates

A gallery of pre-built reports for the vertical, each one a saved intent the user can open and edit. v1 ships the reports partners are judged on: Realization by Partner, Realization by Service Line (trend), Utilization by Staff, AR Aging by Client, Unbilled WIP by Client, Billing by Month, Budget vs Actual by Engagement, Collections by Month, Client Profitability.

### 4.3 Saved reports

Save, rename, duplicate, delete. Stored as JSON intent plus chart choice. Shareable by URL (intent encoded in the hash) so nothing but the definition travels.

### 4.4 Export

CSV/Excel-compatible export of exactly what is on screen, formatted values and raw values both available. The same row-level filters apply to the export as to the screen.

### 4.5 Assistant

A text box: "Show me realization by partner for last quarter, lowest first." The assistant receives the semantic model (labels, descriptions, synonyms) and returns a QuerySpec via a structured tool call. The builder validates and compiles it like any other spec. The user sees exactly which fields were chosen, as shelves, not as prose. If the request names something the model does not have, or two fields are plausible, the assistant asks rather than guesses. Suggested follow-ups are generated from the current report's shape.

## 5. Architecture

```
┌──────────────┐    QuerySpec (JSON)    ┌───────────────┐    SQL    ┌──────────────┐
│  Builder UI  │ ─────────────────────▶ │   Compiler    │ ────────▶ │  Execution   │
│  / Assistant │ ◀───────────────────── │ (deterministic)│ ◀──────── │ DuckDB-WASM  │
└──────────────┘  columns + explanation └───────────────┘   Arrow    │ or server    │
                                               ▲                     └──────────────┘
                                               │
                                       ┌───────────────┐
                                       │ Semantic model│  tables, dimensions, measures,
                                       │  (TypeScript/ │  relationships w/ cardinality,
                                       │   YAML)       │  derived metrics, descriptions
                                       └───────────────┘
```

### 5.1 Semantic model (`src/core/model.ts`)

- `Table`: physical source, primary key, label, description, dimensions, measures.
- `Dimension`: typed (string, number, date, boolean), optional SQL expression, label, description. Date dimensions get time grains (day, week, month, quarter, year) automatically.
- `Measure`: aggregation (sum, count, count_distinct, avg, min, max), SQL expression, format, optional pre-aggregation filters ("billable hours" is `hours` where `billable = true`).
- `DerivedMetric`: arithmetic over measures from any tables, evaluated after aggregation so ratios are ratio-of-sums.
- `Relationship`: from, to, cardinality (many_to_one, one_to_one, one_to_many), join condition.
- Planned: synonyms per field for the assistant, row-level access filters, certification status, Ossie import/export.

### 5.2 QuerySpec (`src/core/query.ts`)

`{ dimensions, measures, filters, sorts, limit }`. Dimensions may carry a grain suffix (`invoices.issued_on__month`). Measures may be `table.measure` or a derived metric name. Filters support eq/neq/in/not_in, comparisons, between, contains/starts_with, null checks, and relative dates. Everything is JSON.

### 5.3 Compiler (`src/core/compiler.ts`)

1. Resolve every reference against the model; unknown fields are errors with names, not SQL errors.
2. Group measures by source table. Each group becomes one aggregating subquery that joins outward only along to-one paths (breadth-first over relationships, following `many_to_one` forward or `one_to_many` backward). If a dimension's table is unreachable without fan-out, throw `FanOutError` naming the measure, the dimension, and the tables that are safe.
3. Combine groups with `FULL OUTER JOIN ... ON d IS NOT DISTINCT FROM d` and `COALESCE` the dimension columns, so a client with invoices but no time still appears.
4. Derived metrics are computed in the outer select with `CAST(... AS DOUBLE)` and `NULLIF(denominator, 0)`.
5. Measure and metric filters wrap the result one more level (HAVING semantics).
6. Relative dates are resolved in JavaScript to half-open concrete ranges, so the SQL is deterministic and the explanation can print the dates.
7. Output: SQL, column metadata (key, label, kind, type, format, source table), and an `Explanation` (summary sentence, per-measure definition and join path, filters in words).

Tested against real DuckDB on the sample dataset (`src/core/compiler.test.ts`): totals reconcile to raw SQL, multi-fact joins don't double count, ratio metrics equal ratio-of-sums, fan-out is refused with a readable message.

### 5.4 Execution

v1 runs entirely in the browser: DuckDB-WASM loads the CSV/Parquet files from `public/data` once, then every builder change is a local query in tens of milliseconds. Later: a server tier that compiles and executes the same SQL against the customer's warehouse with row-level security injected before SQL emission, returning Arrow; the browser caches the reduced result for interaction.

### 5.5 Assistant

Claude with a single tool, `set_report`, whose input schema is the QuerySpec restricted to the model's field names. The system prompt is generated from the model (labels, descriptions, formats, relationships in words, relative-date presets). Rules: never invent fields; ask when ambiguous; prefer metrics over raw measures when the user says a business word that matches a metric description. Output is validated by the compiler before it reaches the screen. The API key is user-supplied and stored locally; the feature is optional and the product is complete without it.

## 6. Not in v1

Dashboards with multiple tiles, scheduled email delivery, pivot (column) dimensions, period-over-period comparison columns, drill to row-level detail, symmetric aggregates for measures on the many side, row-level security, warehouse connectors, Ossie import, model editing UI. Each is designed for (see 5.1, 5.4) and ordered below.

## 7. Roadmap

1. **v0 (this repo):** semantic model, compiler with tests, in-browser execution on a realistic sample dataset, builder UI with explain panel, templates, saved reports, CSV export, assistant.
2. **v0.5 (done except pivots):** period-over-period compare (previous period and same period last year as extra columns, anchored on the report's date filter, rows aligned by period), drill to detail rows (with an exact count and sum that reconcile to the cell), Excel export with formatting and a "How calculated" sheet. Column pivots remain.
3. **v1:** multi-tile dashboards, scheduled delivery with per-recipient filters, server execution tier with row-level security, warehouse connectors (Snowflake, BigQuery, Postgres), model synonyms and certification badges, assistant feedback loop (admins see what users asked and promote verified intents).
4. **v2:** model editing UI, Ossie/MetricFlow import, symmetric aggregates, embed SDK.

## 8. Success criteria

- A practice manager with no training opens a template, changes the grouping and date range, and exports it, in under three minutes.
- Zero wrong totals: every report's totals reconcile to raw SQL in the test suite, and any unsafe combination is refused with a message a tester rates as understandable.
- Every number on screen can be explained in one click without an analyst.
- Assistant: on a golden set of 50 vertical questions, 100% of accepted answers compile and reconcile; unanswerable questions produce a clarifying question rather than a number.
