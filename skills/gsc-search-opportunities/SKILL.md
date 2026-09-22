---
name: gsc-search-opportunities
description: Find evidence-backed Search Console optimization opportunities from query and page data without treating partial Search Analytics rows as exhaustive or causal proof.
---

# GSC search opportunities

Use this skill when the user asks what to optimize next, which queries or pages have upside, whether pages compete for the same query, or which content appears to be declining.

## Workflow

1. Resolve the property, then start with `analytics.query` for the requested date range and search type.
2. Use `insights.quick_wins` for high-impression query/page rows in an opportunity average-position range. Treat CTR as context rather than an eligibility rule.
3. Use `insights.page_queries` and `insights.query_pages` to validate the query-to-page relationship before recommending a page change.
4. Use `insights.cannibalization` to find observed query/page overlap. Treat candidate totals and impression shares as scoped to returned rows, not as true query-level property totals.
5. Use `insights.content_decay` for evidence-ranked page declines, and `analytics.compare` when the user wants custom period comparisons.
6. Inspect country, device, date, or search-appearance dimensions when they can explain where a movement is concentrated.

## Evidence rules

- Search Analytics is not guaranteed exhaustive. Do not turn a missing row into zero traffic, and continue pagination when the tool reports more local rows.
- Average position is an aggregate metric, not a literal current Google rank.
- A quick-win, cannibalization, or decay classification is a heuristic signal to investigate, not proof of cause.
- Caller-supplied query regexes can approximate brand/non-brand segmentation, but they are not Search Console's native AI-assisted branded-query classifier.
- Discover and Google News do not expose query data or average position. Respect each tool's search-type schema instead of forcing query-centric analysis onto those reports.
- Do not infer dedicated Generative AI report metrics from ordinary Search Analytics; use the Search Console UI until Google documents API access for that report.

## Output shape

Rank opportunities by the strength of the observed evidence and expected usefulness. For each recommendation, name the query/page signal that supports it and the next verification step before a material SEO change.
