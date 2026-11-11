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
  .describe('Optional case-insensitive query substring used to focus the returned candidates. Filtering happens after full query/page aggregation, so other competing pages remain visible.');

export const CANNIBALIZATION_PAGE_CONTAINS_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .optional()
  .describe('Optional case-insensitive page URL substring (for example /de/) filtered by Google before query/page grouping. Candidate shares then describe only matching pages, not property-wide results.');
