import { z } from 'zod';
import { SEARCH_CONSOLE_DATE_SCHEMA } from './date-validation';

const POSITION_RANGE_ERROR = {
  message: 'min_position must be less than or equal to max_position.',
  path: ['max_position'],
};

const QUICK_WINS_THRESHOLDS_SHAPE = {
  min_impressions: z.number().int().min(0).default(100).describe('Minimum impressions required to consider a query. Must be at least 0. Default is 100.'),
  min_position: z.number().positive().default(8).describe('Minimum average position to target (inclusive). Must be greater than 0. Default is 8.'),
  max_position: z.number().positive().default(20).describe('Maximum average position to target (inclusive). Must be greater than 0. Default is 20.'),
};

export function createQuickWinsInputSchema(siteUrlDescription: string) {
  return z
    .object({
      site_url: z.string().describe(siteUrlDescription),
      start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('Start date (inclusive) in YYYY-MM-DD format.'),
      end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('End date (inclusive) in YYYY-MM-DD format. Note the 2-3 day GSC data lag.'),
      ...QUICK_WINS_THRESHOLDS_SHAPE,
    })
    .refine(
      ({ min_position, max_position }) => min_position <= max_position,
      POSITION_RANGE_ERROR,
    );
}
