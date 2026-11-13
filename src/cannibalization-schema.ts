import { z } from 'zod';

export const CANNIBALIZATION_MIN_IMPRESSIONS_SCHEMA = z
  .number()
  .int()
  .min(0)
  .default(50)
  .describe('Minimum impressions for a page-query pair to be considered. Must be at least 0. Default is 50.');

export const CANNIBALIZATION_MIN_PAGE_PERCENTAGE_SCHEMA = z
  .number()
  .min(0)
  .max(100)
  .default(10)
  .describe('Minimum percentage of total query impressions a page must have to count as a cannibalizing page (0-100). Default is 10%.');

export const CANNIBALIZATION_QUERY_CONTAINS_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .optional()
  .describe('Optional case-insensitive query substring filtered by Google before source pagination. Query/page aggregation still includes all returned competing pages for matching queries.');

export const CANNIBALIZATION_PAGE_CONTAINS_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .optional()
  .describe('Optional case-insensitive page URL substring (for example /de/) filtered by Google before query/page grouping. Candidate shares then describe only matching pages, not property-wide results.');

export const CANNIBALIZATION_COUNTRY_SCHEMA = z
  .string()
  .trim()
  .regex(/^[a-zA-Z]{3}$/, 'Use a three-letter ISO 3166-1 alpha-3 country code such as SVN or DEU.')
  .optional()
  .describe('Optional ISO 3166-1 alpha-3 searcher country, e.g. DEU for Germany, not the page language. Google filters this geography alongside page_contains and query_contains before source pagination.');

export const CANNIBALIZATION_DEVICE_SCHEMA = z
  .enum(['desktop', 'mobile', 'tablet'])
  .optional()
  .describe('Optional searcher device: desktop, mobile, or tablet. Google applies it with page_contains, query_contains, and country before pagination; omitting it preserves all-device behavior.');

export const CANNIBALIZATION_SEARCH_TYPE_SCHEMA = z
  .enum(['web', 'image', 'video', 'news'])
  .default('web')
  .describe('Search surface for overlapping query/page URLs: Web (default), Image, Video, or the Search News tab. Discover and the separate Google News service are excluded because they do not expose query dimensions. Results from different surfaces must not be combined.');

export const CANNIBALIZATION_DATA_STATE_SCHEMA = z
  .enum(['all', 'final'])
  .optional()
  .describe('Optional Search Analytics freshness: all includes preliminary query/page rows that may change; final or omission returns finalized-only data. This does not change the request count.');
