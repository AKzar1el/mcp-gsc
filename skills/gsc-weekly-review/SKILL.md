---
name: gsc-weekly-review
description: Review a Search Console property week over week using mcp-gsc while preserving Search Analytics data-completeness and causality boundaries.
---

# GSC weekly review

Use this skill when the user asks for a weekly Search Console review, a week-over-week SEO recap, or a concise performance summary grounded in Google Search Console data.

## Workflow

1. If the property is unknown, call `sites.list` and use the exact `siteUrl` returned by Google. If a property is already named, `sites.get` can confirm it directly.
2. Use `reports.weekly_digest` for the fast seven-day summary. Its default end date targets usually-complete Search Console data; only pass a newer `end_date` when the user explicitly wants fresher preliminary data. Select `search_type` (`web` by default; also `image`, `video`, or Google Search News-tab `news`) when relevant.
3. Decide whether the user wants a whole-property view or a specific segment. For a segmented digest, set any supported combination of `page_contains` (URL section, e.g. `/de/`), `query_contains` (topic substring), `device` (`desktop`, `mobile`, `tablet`), and `country` (searcher geography, ISO 3166-1 alpha-3 such as `DEU`). These Google-side filters combine as AND; `/de/` is not evidence that the searcher is in Germany.
4. Use `analytics.query` when the user needs the underlying totals, queries, pages, countries, devices, dates, or search appearances. Choose `data_state` deliberately: `final` for finalized data, `all` when preliminary data is acceptable. Keep the same scope when reconciling totals; scoped digest metrics are not property-wide totals.
5. Use `analytics.compare` for explicit period comparisons. Apply the same search type, date-window logic and filters to both periods; do not compare differently filtered populations as if they had the same scope.
6. Drill into important movers with `insights.page_queries` or `insights.query_pages` before recommending an SEO action. When carrying a `query_contains`/`page_contains`/`country` segment into `insights.quick_wins`, `insights.cannibalization` or `insights.content_decay`, keep those supported filters consistent; other filters such as device may not be available on every insight tool.

## Evidence rules

- Search Analytics can return only top rows and does not guarantee every data row. A row missing from one period is not evidence of zero traffic.
- Average position is an aggregate Search Console metric, not a literal current rank or results-page number.
- Separate measured changes from causal hypotheses. Search Console movement alone does not prove that a content edit, algorithm update, competitor, backlink, snippet, or technical change caused it.
- For fresh data, preserve any incomplete-data metadata returned by the tool rather than describing the numbers as final.
- Discover and Google News do not support average position; do not infer it from their rows.
- Explain the applied segment (including searcher country versus page language) and flag any follow-up that cannot preserve the same scope before presenting a comparison.

## Output shape

Lead with the measured change, then the strongest query/page evidence, then one or two evidence-backed next actions. State important data limitations inline instead of hiding them in a footnote.
