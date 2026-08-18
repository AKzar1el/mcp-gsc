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
