---
name: gsc-weekly-review
description: Review a Search Console property week over week using mcp-gsc while preserving Search Analytics data-completeness and causality boundaries.
---

# GSC weekly review

Use this skill when the user asks for a weekly Search Console review, a week-over-week SEO recap, or a concise performance summary grounded in Google Search Console data.

## Workflow

1. If the property is unknown, call `sites.list` and use the exact `siteUrl` returned by Google. If a property is already named, `sites.get` can confirm it directly.
2. Use `reports.weekly_digest` for the fast seven-day summary. Its default end date targets usually-complete Search Console data; only pass a newer `end_date` when the user explicitly wants fresher preliminary data.
3. Use `analytics.query` when the user needs the underlying totals, queries, pages, countries, devices, dates, or search appearances. Choose `data_state` deliberately: `final` for finalized data, `all` when preliminary data is acceptable.
4. Use `analytics.compare` for explicit period comparisons. Apply the same search type and filters to both periods.
5. Drill into important movers with `insights.page_queries` or `insights.query_pages` before recommending an SEO action.

## Evidence rules

- Search Analytics can return only top rows and does not guarantee every data row. A row missing from one period is not evidence of zero traffic.
- Average position is an aggregate Search Console metric, not a literal current rank or results-page number.
- Separate measured changes from causal hypotheses. Search Console movement alone does not prove that a content edit, algorithm update, competitor, backlink, snippet, or technical change caused it.
- For fresh data, preserve any incomplete-data metadata returned by the tool rather than describing the numbers as final.
- Discover and Google News do not support average position; do not infer it from their rows.

## Output shape

Lead with the measured change, then the strongest query/page evidence, then one or two evidence-backed next actions. State important data limitations inline instead of hiding them in a footnote.
