import { z } from 'zod';

export const CONTENT_DECAY_COMPARE_DAYS_SCHEMA = z
  .number()
  .int()
  .min(1)
  .default(30)
  .describe('Number of days to compare (recent period vs previous period). Must be at least 1. Default is 30.');

export const CONTENT_DECAY_PAGE_CONTAINS_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .optional()
  .describe('Optional case-insensitive page URL substring, such as /de/, for focusing results after complete two-period page comparison. Does not change Search Analytics requests or treat absent rows as zero.');
