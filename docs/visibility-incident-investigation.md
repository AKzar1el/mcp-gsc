# Investigate a Search Console visibility incident

This is a **read-only decision path** for a sudden drop in Search Console clicks or impressions. It connects existing mcp-gsc prompts into one investigation without treating an apparent drop as proof of deindexing, an algorithm penalty, or a site defect. It is also useful when a multilingual website loses traffic in only one URL section or searcher market.

The prompts are discoverable through MCP `prompts/list` and `prompts/get` in compatible clients. Retrieving a prompt makes **no Google API call**; executing its recommended tools uses ordinary Search Analytics or URL Inspection quotas. A client without prompt support can follow the same steps using the read-only tools in the [README](../README.md#tools).

## 1. Freeze the evidence boundary

Before any Search Analytics request, record:

| Field | Required decision |
| --- | --- |
| Property | One exact `site_url` returned by `sites.list` and accessible via `sites.get`. A `sc-domain:` property includes subdomains and protocols; a URL-prefix property has a narrower scope. |
| Search surface | Keep Web (`web`), Image (`image`), Video (`video`), or Search News tab (`news`) separate. Google Lens/Circle to Search (`webMultimodal`) is a separate surface; do not silently combine it with Web or Image. |
| Dates | Record the Pacific-calendar date ranges and whether each is finalized. For finalized review, use an end date at least three Pacific days before today; recent values may be preliminary or missing. |
| Filters | Fix the same URL section (`page_contains`), searcher `country`/`countries` and `device`/`devices` in every comparison. Searcher country is **not** inferred from page language. |
| Baseline | Compare equal-length, nonoverlapping periods for the same property, surface and Google-side filters. A three-day signal is not automatically a seven-day trend. |

Check `server.capabilities` for access mode, then `sites.get` for the exact property. These checks do not verify that Search Analytics data exists or that historical credentials remain valid; the provider request must still succeed. Never switch to a broader property because the requested one has sparse data.

## 2. Find when the change appeared

Use **`gsc-daily-onset-review`** with the fixed `site_url`, a finalized `end_date`, selected `search_type` and optional filters. Its optional `lookback_days` chooses 14, 21 (default), or 35 finalized Pacific days for one date-grouped `analytics.query` (one normal read quota unit), with same-weekday comparisons only where both dates were returned.

Record the first *observed* lower day, the last comparable earlier day, the number of returned dates and any gaps. Search Console may omit days and return incomplete data. Missing days are **unknown, not zero**; do not sum incomplete returned days as verified full-week totals or claim an exact onset when the relevant dates are absent.

If the window contains too few comparable returned dates, stop with **insufficient timeline evidence**. Do not spend further quotas chasing a causal explanation before verifying the baseline.

## 3. Localize the affected traffic, one question at a time

Choose the first relevant branch below rather than invoking every prompt:

| Question | Read-only workflow | What it can establish |
| --- | --- | --- |
| Is this a general Web/Image/Video/News-tab decline or one scoped segment? | `gsc-traffic-drop-triage` | Matched-period observations and a prioritized follow-up. Country/device lists use identical Google-side `filterLists`; direct page/query drilldowns can preserve lists when exact date, search surface and filters match. |
| Which observed search queries changed? | `gsc-query-cohort-review` | Changes only for query rows returned in both finalized seven-day samples. Do **not** use a query workflow for Discover, Google News app or `webMultimodal`. |
| Which observed landing pages changed? | `gsc-page-cohort-review` | Changes only for returned common page URLs; supports `webMultimodal` page analysis without a text-query drilldown. |
| Is the change concentrated in searcher geography? | `gsc-country-movement-review` | An observed country breakdown, **not** URL-language attribution or a complete country census. |

Keep the property, finalized date boundary, search surface, URL section and applicable country/device scope identical between follow-ups. A combined `countries` or `devices` filter is **one combined segment**, not separately measured countries/devices. Do not silently replace list filters with single-value filters, widen the property, or compare overlapping Search surfaces. Every extra read or retry uses the server's normal quotas.

Top-row sampling can change between periods. A query or page returned in only one period is a **follow-up lead**, not confirmed gained/lost traffic, zero impressions, deindexing or an algorithm penalty. A lower aggregate can coexist with different sampled top rows; do not attribute the entire aggregate change to those rows.

## 4. Inspect an exact URL only when indexing evidence changes the decision

If an actual returned page merits indexing investigation, use **`gsc-index-status-triage`** for that exact authorized property and `inspection_url`. This can guide one `urls.inspect` call about Google's indexed version. It is **not** a live fetch or an indexability test of the current page. For 2-10 distinct URLs in the same property, `gsc-index-batch-review` has separate daily and per-URL quota safeguards; avoid bulk inspection without a concrete need.

Use **`gsc-sitemap-health-review`** only for a hypothesis involving submitted sitemap processing. Sitemap submission/download dates, Search Analytics omissions and URL Inspection results are different signals; none alone proves why impressions changed. A separate authorized live HTTP/canonical/robots check may be needed to substantiate a technical hypothesis.

Do not call `indexing.request`, `indexing.remove`, `sitemaps.submit`, `sitemaps.delete`, or any other write tool while following this playbook. No step guarantees that Google will index, rank or restore traffic.

## 5. Finish with a short, auditable incident record

Use the following structure, including when the evidence is inconclusive:

| Field | Record |
| --- | --- |
| Exact scope | Property, surface, date windows, URL section, country/device filters, `data_state` |
| Observed signal | Actual clicks and impressions, comparable dates/rows, and the magnitude of any matched change |
| Coverage | Missing dates, incomplete top-row samples, unavailable position or other unverified data |
| Attribution | Affected *observed* queries, pages or searcher countries; clearly separate hypotheses from confirmed measurements |
| Follow-up | One highest-value additional **read-only** check, its quota cost, or an explicit stop reason |

**Stop conditions:** revoked access or wrong property; no sufficiently comparable finalized dates; exhausted API/inspection budget; scope cannot be preserved in a proposed helper; unsupported Search surface or missing query dimension; data only supports a hypothesis, not a conclusion. Do not turn a lack of evidence into an SEO fix recommendation.

### Example request for an MCP-capable assistant

> Investigate an observed Search Console impressions decline using only my connected mcp-gsc read tools. First confirm the exact property with `sites.list`/`sites.get`; ask for a property only if it cannot be resolved. Use finalized Pacific-calendar windows and keep the same Search surface and filters throughout. Start with `gsc-daily-onset-review`, then choose **at most one** of traffic-drop triage, query cohort, page cohort or country movement based on actual returned evidence and quota. Do not interpret missing rows as zero, infer a penalty or deindexing, or make any write, deployment or publication. End with measured changes, unknowns and one safe next check.

This is a guided investigation, **not** an automated monitor, a diagnosis of any named site, or evidence of a customer outcome. Prompt support depends on the MCP client, and live Google results are only available when the connected user authorizes and runs the read calls.
