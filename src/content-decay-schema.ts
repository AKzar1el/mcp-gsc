import { z } from 'zod';

export const CONTENT_DECAY_COMPARE_DAYS_SCHEMA = z
  .number()
  .int()
  .min(1)
  .default(30)
  .describe('Number of days to compare (recent period vs previous period). Must be at least 1. Default is 30.');
