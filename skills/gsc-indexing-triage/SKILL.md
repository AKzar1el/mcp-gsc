---
name: gsc-indexing-triage
description: Diagnose Search Console indexing and sitemap questions with URL Inspection evidence while avoiding unsupported indexing claims or general-purpose Indexing API use.
---

# GSC indexing triage

Use this skill when the user asks whether a URL is indexed, why indexing looks wrong, whether a sitemap is healthy, or whether an eligible URL can use Google's Indexing API.

## Workflow

1. Resolve the exact property with `sites.list` or `sites.get`.
2. For URL-level indexed-state evidence, use `urls.inspect` or `urls.inspect_many`. Treat the result as Google's indexed version of the URL, not a live URL test.
3. For sitemap state, use `sitemaps.list` or `sitemaps.get`. Treat `lastSubmitted` as the Search Console submission time and `lastDownloaded` as Google's sitemap download time; neither proves a page crawl or index event.
4. If the user previously used the Indexing API, `indexing.status` can read Google's latest successful notification receipt. It is available only in read-write mode and is not an index-coverage or completion report.
5. Use `indexing.request` only for Google's supported content classes: a page with `JobPosting`, or a livestream page with `BroadcastEvent` inside `VideoObject`. The property must satisfy the tool's owner-level authorization checks.
6. Use `indexing.remove` only for a previously eligible Indexing API page after the URL already returns HTTP 404/410 or exposes a robots `noindex` meta directive. Treat the `URL_DELETED` result as a notification receipt, not proof that removal completed.

## Safety and provider-truth rules

- Never present `indexing.request` as a general webpage-submission or faster-indexing tool.
- Never present `indexing.remove` as a general Search Console removal tool; Google's same narrow Indexing API content scope still applies.
- A successful Indexing API notification means Google received the request; it does not guarantee crawling, indexing, or removal.
- `sites.add` adds a property to the connected account's Search Console site set; it does not verify ownership.
- `sites.delete` removes the property from that account's site set; it does not delete the website.
- A page absent from Search Analytics can still be indexed. Use URL Inspection for URL-level index evidence.
- Do not invent identifiers for Search Console platform properties that the current API does not document.

## Output shape

Distinguish the observed provider state from the diagnosis. Give the exact evidence first, then the likely next check or fix, and explicitly label anything that remains a hypothesis.
