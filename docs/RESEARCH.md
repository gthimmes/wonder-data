# What's missing in reporting and analytics tools (research, October 2026)

Four parallel research passes (roughly 130 web searches and page fetches) across BI-tool reviews, community threads, analyst reports, vendor docs, academic benchmarks, embedded-analytics vendors, and accounting-practice-management tools. Findings are ranked by evidence strength. Vendor-sourced claims are flagged.

## 1. The headline: self-service never happened, and AI has not changed that yet

- About 26 to 29% of employees use the BI tools their employer pays for (Gartner, reiterated for a decade). [business-analysis.ca](https://www.business-analysis.ca/blog/why-bi-dashboards-go-unused-2026-adoption-gap)
- The share of organizations using self-service BI has been flat at about 55% since 2014 (BARC BI Trend Monitor, n≈2,700). [barc.com](https://barc.com/self-service-bi/)
- Fewer than 10% of employees use anything beyond spreadsheets (Strategy/MicroStrategy 2025 survey, vendor-run). [strategy.com](https://www.strategy.com/software/blog/5-ai-and-bi-adoption-trends-every-leader-must-know-in-2025)
- "Rather than run the risk of ending with incorrect data, business users choose not to try themselves and open another ad hoc request with the data team." [metricstack](https://metricstack.substack.com/p/lets-fix-analytics-so-we-can-stop)
- Looker "turns a five minute question into a five day wait"; it reduced ad-hoc requests but did not remove the bottleneck. [onesixsolutions](https://www.onesixsolutions.com/insights/sigma-vs-looker/), [skopx](https://skopx.com/resources/looker-alternatives)
- Gartner 2025 Magic Quadrant caution on Looker: "business users who expect drag-and-drop self-service will find Looker less intuitive." [cxtoday](https://www.cxtoday.com/customer-analytics-intelligence/gartner-magic-quadrant-for-analytics-and-business-intelligence-abi-platforms-2025-the-rundown/)

**Takeaway.** The user's hypothesis is correct and well supported: a report builder that non-data people can actually use is the oldest unsolved problem in the category. Three generations of "self-service" tooling have not moved the adoption number.

## 2. Why business users don't build reports: the two silent failure modes

Users stop building reports after being burned once. The two ways they get burned are both structural, not UX polish.

**Silent double counting (fan-out).** Any builder that lets users combine two sources without cardinality metadata ships wrong totals.
- HubSpot counts a $100K deal with five associated contacts as $500K. [agentsforhire](https://agentsforhire.ai/blog/hubspot-custom-report-builder-limitations-what-marketing-ops-needs-to-know/)
- Looker Studio blends are "the one feature that produces the most quietly wrong reports." [Kodelytics](https://kodelytics.ca/insights/blended-data-and-when-it-breaks), [Google forum](https://discuss.google.dev/t/why-does-blended-data-show-different-totals-compared-to-manually-summed-values/183622)
- Metabase "questions from questions didn't generate correct SQL" for fact-to-fact grain. [Dynamic Data](https://dynamicdata.com/blog/bi-platforms-evaluation-metabase/)
- Tools that solve it do so with declared join cardinality: Looker symmetric aggregates, Malloy `join_one`/`join_many`, Cube per-fact subqueries with FULL JOIN, MetricFlow entity-typed joins. [Looker](https://docs.cloud.google.com/looker/docs/best-practices/understanding-symmetric-aggregates), [Malloy](https://docs.malloydata.dev/documentation/language/join), [Cube](https://docs.cube.dev/docs/data-modeling/multi-fact-views), [dbt](https://docs.getdbt.com/docs/build/join-logic)

**Silent exclusion (inner-join defaults).** Salesforce's "Accounts with Cases" versus "with or without Cases" is "one of the most common reporting mistakes, as it can silently exclude records." [Salesforce help](https://help.salesforce.com/s/articleView?id=000384956&language=en_US&type=1)

**Metric divergence.** 67% of organizations do not completely trust their data for decisions, up from 55% a year earlier (Precisely/Drexel 2025). [prnewswire](https://www.prnewswire.com/news-releases/3-in-4-business-leaders-blindly-trusting-data-despite-67-worrying-this-risks-missed-opportunities-302328125.html). Sigma's optional data model leads to "metric divergence within six months." [knowi](https://www.knowi.com/blog/the-ultimate-sigma-review-pros-cons-and-who-it-is-for/)

## 3. AI analytics: shipped everywhere, trusted nowhere

Every major vendor now ships natural-language analytics (Power BI Copilot, Tableau Agent, Looker Conversational Analytics, ThoughtSpot Spotter, Databricks Genie, Snowflake Cortex Analyst, Omni AI). The feature gap is closed. The trust gap is not.

- Microsoft's own docs: "Without preparation, Copilot can misinterpret the data and return generic or inaccurate results." [Microsoft](https://learn.microsoft.com/en-us/power-bi/create-reports/copilot-introduction)
- Identical prompts yield different DAX; "I do not believe that it makes sense users should ask data questions to and trust the response of a tool that says on the label 'mistakes are possible'." [data-goblins](https://data-goblins.com/power-bi/copilot-in-power-bi)
- 74% of business users have shipped a decision or report on an AI number that turned out wrong; only 23% re-derive from source; 86% reach for ChatGPT/Claude/Gemini before their BI tool (Databox 2026, n=100+, vendor-run). [databox](https://databox.com/research-reports/using-ai-you-dont-trust)
- Genie admins cannot see other users' questions, SQL, or ratings, so there is no way to correct it. [Databricks community](https://community.databricks.com/t5/generative-ai/genie-cant-upvote-downvote-cant-edit-queries-nor-view-other/m-p/89244/highlight/true)
- "The second I ask for any important number, my next action is to cross check against some source of truth or manually built query." [Benn Stancil](https://benn.substack.com/p/the-context-layer)

### Text-to-SQL accuracy: the numbers

| Study | Setup | Without semantic layer | With semantic layer | Notes |
|---|---|---|---|---|
| BIRD leaderboard | 12,751 Q/SQL pairs, 95 DBs | best 82.95% (humans 92.96%) | n/a | [bird-bench](https://bird-bench.github.io/) |
| Spider 2.0 | 632 real warehouse tasks | 21.3% (paper), GPT-4o 10.1% | n/a | [arXiv 2411.07763](https://arxiv.org/abs/2411.07763) |
| BEAVER | private enterprise logs | GPT-4o 0 to 2% | n/a | [arXiv 2409.02038](https://arxiv.org/pdf/2409.02038) |
| Cube benchmark | 100 Qs, Opus 4.7 / Sonnet 4.6 / GPT-5.4 | 45.5 to 50.5% | 67.7 to 68.7% | 4KB semantic doc as context only. [arXiv 2604.25149](https://arxiv.org/abs/2604.25149) |
| Snowflake Cortex Analyst | 150 internal Qs | 51% | 90%+ | vendor. [Snowflake](https://www.snowflake.com/en/blog/engineering/cortex-analyst-text-to-sql-accuracy-bi/) |
| dbt Labs 2026 | 11 Qs × 20 runs | 84 to 90% | 98.2 to 100% | SL failures are refusals, not wrong numbers. [dbt](https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026) |
| SPC | 38 adjudicated Qs | 55.3% | 97.4% | [arXiv 2608.16663](https://arxiv.org/abs/2608.16663) |
| QueryProof | 80 tasks | 75.4% false-success | 0/24 wrong numbers on answerable tasks | measures abstention. [arXiv 2608.09254](https://arxiv.org/abs/2608.09254) |
| Databricks Genie | undisclosed | 32% | "90%+" | not reproducible. [Databricks](https://www.databricks.com/blog/pushing-frontier-data-agents-genie) |

**Takeaway.** Nobody has an independent, reproducible enterprise-scale result above about 80% for free-form text-to-SQL. The 98 to 100% results are real but only inside a modeled surface, when the LLM picks metrics and dimensions and a deterministic compiler writes the SQL. Crucially, the failure mode changes from "plausible wrong number" to "cannot answer."

### Trust patterns that ship (and one that doesn't)

- Verified/golden queries with a visible badge: Snowflake Verified Query Repository, Power BI Verified Answers (May 2025), Databricks trusted assets, Looker golden queries.
- Abstain plus suggestions instead of SQL when confidence is low (Cortex Analyst `suggestions` response).
- "How was this calculated": Looker field/filter/sort steps; Omni provenance row with metric ID and approval status; ThoughtSpot Spotter resolved tokens; Metabase "open the underlying query."
- Not shipping anywhere found: "reconcile these two reports" (diff two structured queries and explain the delta). Only possible when both sides are structured intent, not SQL.

## 4. UX principles with evidence

1. **Start inside a container the user knows** (pivot/table), not a blank canvas. Power BI Explore is literally Rows/Columns/Values wells; novices "preferred visualizations they were already familiar with." [Microsoft](https://learn.microsoft.com/en-us/power-bi/explore-reports/explore-data-service), [Grammel et al.](https://pubmed.ncbi.nlm.nih.gov/20975131/)
2. **The field picker is the product.** Google's Looker guidance: "expose the most important fields first." Salesforce Report Types work for millions because an admin pre-scopes fields. [Google Cloud](https://cloud.google.com/looker/docs/best-practices/how-to-create-a-positive-experience-for-looker-users)
3. **Declare relationships once, cardinality-aware, so fan-out is impossible by construction** (section 2).
4. **Always show the filter state** as pills; always let the user open the generated query. [Microsoft](https://learn.microsoft.com/en-us/power-bi/explore-reports/explore-data-service), [Metabase](https://www.metabase.com/docs/latest/ai/metabot)
5. **Governed defaults plus a local escape hatch that can be promoted** (Omni's workbook-as-branch model). The opposite (Lightdash, MetricFlow) means waiting for a data-team PR to add a filter. [Tasman](https://www.tasman.ai/news/maximize-bi-efficiency-with-omnis-3-layer-model), [Querio](https://querio.ai/articles/lightdash-review-dbt-native-bi-contender)
6. **Ship pre-built reports as the entry point.** "Edit a template" beats "build from scratch." Canopy shipped a general-purpose BI builder (Liveboards) and accountants called it "too complicated"; they wanted more canned reports. [Capterra via search](https://www.capterra.com/p/150647/Canopy-Tax/reviews/), [Karbon](https://karbonhq.com/feature/analytics/)
7. **Auto-pick the chart, one click to override.**
8. **Export to Excel is the real interface.** Power BI's 150K-row export cap is a decade-old top-voted idea; 7 of 8 interviewees at firms with large BI spend still export. [gainable](https://www.gainable.dev/blog/your-company-spent-six-figures-on-bi-tools-you-still-export-to-excel)
9. **Scheduled, per-person reports.** "Some people may only use your application by consuming the data that it generates." The common security failure is row-level security that holds on the dashboard but not on exports or scheduled emails. [EnterpriseReady](https://www.enterpriseready.io/features/advanced-reporting/), [Omni](https://omni.co/articles/how-to-implement-embedded-analytics-for-saas-products)

## 5. Embedded analytics for SaaS: why companies build their own

- "Can I create my own report?" becomes an inevitable support request at every embedded deployment. [Omni](https://omni.co/articles/how-to-implement-embedded-analytics-for-saas-products)
- Vendor pricing breaks for customer-facing use: Looker Embedded about $66K/yr base plus about $400/viewer/yr; Sisense median about $57K/yr with renewal quadrupling reported; Explo was acquired by Omni (Oct 2025) and is being sunset. [embeddable](https://embeddable.com/blog/power-bi-embedded-vs-looker-embedded), [luzmo](https://www.luzmo.com/blog/sisense-pricing), [omni](https://omni.co/explo)
- Build estimates: $80 to 150K and 6 to 12 months for v1, then 1 to 2 engineers ongoing. Buying saves perhaps half, not 90%. [datatako](https://datatako.com/blog/build-vs-buy-embedded-analytics)
- No credible cross-SaaS statistic ties churn to reporting; the signal is directional only.

## 6. Accounting-firm practice management specifically

The metrics partners are measured on are fixed: realization (industry average about 85%), utilization (charge hours trending down across all size bands), billing rates by role, income per partner, AR and WIP aging. [Rosenberg 2025](https://rosenbergassoc.com/2025-rosenberg-survey-what-the-numbers-are-telling-us/), [IPA 2026 via Going Concern](https://www.goingconcern.com/for-firms-growth-is-down-but-profitability-is-up/)

| Tool | Custom reporting today | Evidence |
|---|---|---|
| Karbon | ~13 pre-built dashboards; custom reports are a ~$6,000 add-on or a Snowflake/Power BI project | [Karbon](https://karbonhq.com/feature/analytics/), [Financial Cents](https://financial-cents.com/resources/articles/karbon-pricing/) |
| Canopy | Shipped a BI builder (Insights/Liveboards); users: "too complicated," "need more canned reports" | [Capterra](https://www.capterra.com/p/150647/Canopy-Tax/reviews/) |
| TaxDome | "Rigid and requiring manual exports for custom views" | [Pilot](https://meridian.pilot.com/buying-guide/canopy-alternatives) |
| Financial Cents | Realization and utilization reports still beta (June 2025); only work if you invoice inside FC; export is CSV | [FC help](https://help.financial-cents.com/en/articles/10714985-utilization-report) |
| CCH Axcess Practice | Deepest report library, "clunky," "building reports was more difficult to understand"; custom reporting pushed to SQL extract | [SelectHub](https://www.selecthub.com/p/accounting-practice-management-software/cch-axcess-practice/) |
| Practice CS | 150+ reports; custom reports sold via paid Technical Services; "becoming a dinosaur" | [Thomson Reuters](https://www.thomsonreuters.com/en-us/help/practice-cs/custom-formats/request-custom-reports-from-technical-services) |

A cottage industry (Silver Sea, PracticePro365) sells Power BI dashboards on top of CCH and Practice CS data, which is the clearest evidence native reporting is not meeting partner needs. [silversea](https://silversea-analytics.com/dashboard4cpa/)

**Ranked gaps in this vertical**
1. Self-serve custom views an accountant can build in minutes (gated, too complex, or "export to Excel" everywhere).
2. Clean Excel export of any report.
3. Realization by client / staff / service line, period over period.
4. Utilization and capacity versus plan.
5. WIP and AR aging with drill to time entry and invoice (covered but not delighting).
6. Client profitability combining time at cost, fees, and write-downs.
7. Scheduled, per-partner emailed reports showing only their book (nobody in the category advertises this).
8. Multi-partner / multi-office cuts of the same report.

**Jobs to be done**
- Managing partner: "When I prepare for the monthly partner meeting, I want realization and utilization by partner, staff and service line versus the same period last year, without asking an admin to run and reformat exports."
- Practice manager: "When a partner asks which clients are over budget right now, I want to filter, save and share that view myself, so I don't wait on a $6,000 custom report."
- Billing partner in season: "I want WIP and AR aging by client with drill-down to the unbilled time and the invoice, exported to Excel in the layout I hand to staff."
- Operations lead: "I want each partner to get their own book's key reports by email every Monday, showing only their clients."
- Firm owner: "I want client profitability that combines time at cost, billed fees and write-downs even though we invoice in QBO."

## 7. Technical building blocks

- **Compute in the browser.** DuckDB-WASM: 4GB WASM memory ceiling, single-threaded by default, OPFS persistence official since Sept 2026, Parquet range reads work (with an httpfs workaround). Rule of thumb: execute server-side when row-level security applies or facts exceed a few hundred MB; otherwise ship a reduced Arrow extract to the browser for sub-100ms interaction (MotherDuck's dual execution). [DuckDB](https://duckdb.org/2026/09/18/opfs-wasm), [CIDR 2024](https://www.cidrdb.org/cidr2024/papers/p46-atwal.pdf)
- **Charts.** Vega-Lite v6 is the only widely adopted JSON-schema'd chart grammar: "a model can write, a validator can reject, and a person can read." [Vega-Lite](https://vega.github.io/vega-lite/docs/spec.html)
- **Pivot grid.** FINOS Perspective (Apache 2.0, Arrow-native, WASM) for pivots; AG Grid Community for plain tables. Avoid Glide Data Grid (unmaintained).
- **Portability.** Apache Ossie (formerly Open Semantic Interchange) entered the Apache Incubator July 2026 with 30+ backers; adopt as import/export for model definitions. MetricFlow YAML has the richest open time model. [ossie](https://ossie.apache.org/)
- **Compiler algorithms.** Per-fact aggregating subqueries joined with FULL OUTER JOIN on shared dimensions (Cube, MetricFlow) is simpler and safer than symmetric aggregates (Looker, Malloy) for v1; add symmetric aggregates later for measures on the "many" side.

## 8. What's solved versus genuinely open

**Addressed by vendors in 2025 to 2026:** NL interfaces exist everywhere; semantic-layer interoperability has momentum (Ossie, MetricFlow open source, Snowflake Semantic Views, Databricks Metric Views); developer-grade versioning (PBIP/TMDL, LookML in git); verified-answer badges for known questions.

**Genuinely unsolved:**
1. Verifiability of answers for non-technical users, in terms they can check without an analyst.
2. The labor of building and maintaining the semantic model that every AI feature depends on.
3. A feedback loop between users and whoever curates definitions.
4. Insight to action: dashboards are read-only, so Excel export is the last mile.
5. Pricing that scales per viewer, per query, or per token.
6. Adoption itself: the roughly 30% figure has not moved in a decade.

## 9. Implications for what to build

The evidence points at one design, which the spec in `SPEC.md` follows:

1. The semantic model is the contract and the deterministic compiler is the only thing that writes SQL. Fan-out is impossible by construction, and "cannot answer" is a first-class, explained outcome.
2. Every report is a small JSON intent (fields, filters, sort), never SQL. That makes reports saveable, diffable, template-able, and generatable by an assistant that is validated before execution.
3. Every number has a "how was this calculated" panel in plain language: definition, join path, concrete filter dates, and the SQL for anyone who wants it.
4. Templates first. A vertical library of the reports the audience is actually judged on, each one editable.
5. Excel/CSV export and scheduled, per-person delivery with the same row-level filters as the screen.
6. AI assist proposes intent against the model, must validate, asks when ambiguous, and shows exactly which fields it picked.
