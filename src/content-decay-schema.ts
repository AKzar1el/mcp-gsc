import { z } from 'zod';

export const CONTENT_DECAY_COMPARE_DAYS_SCHEMA = z
  .number()
  .int()
  .min(1)
  // Two contiguous periods plus the three-day finalized-data lag must fit inside
  // the shortest rolling 16-calendar-month Search Console performance window.
  .max(240)
  .default(30)
  .describe('Number of days in each comparison period (recent vs previous). Must be 1-240 to keep both periods inside Search Console\'s 16-month performance history with a three-day finalized-data lag. Default is 30.');

export const CONTENT_DECAY_PAGE_CONTAINS_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .optional()
  .describe('Optional case-insensitive page URL substring, such as /de/, applied to both Google Search Analytics requests before pagination. Restricts both comparison periods to matching page URLs without extra requests or treating absent rows as zero.');

export const CONTENT_DECAY_QUERY_CONTAINS_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .optional()
  .describe('Optional case-insensitive query topic substring, such as technical seo, applied to both Google Search Analytics requests before pagination. Can combine with page_contains as AND; results reflect the filtered query topic, not all property traffic.');
