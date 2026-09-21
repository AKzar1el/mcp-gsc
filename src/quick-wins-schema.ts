import { z } from 'zod';
import { SEARCH_CONSOLE_DATE_SCHEMA } from './date-validation';
import { SEARCH_CONSOLE_PROPERTY_SCHEMA } from './search-console-property-schema';
import {
  DEFAULT_ANALYSIS_RESULT_LIMIT,
  MAX_ANALYSIS_RESULT_LIMIT,
} from './result-bounds';

const POSITION_RANGE_ERROR = {
  message: 'min_position must be less than or equal to max_position.',
  path: ['max_position'],
};

const QUICK_WINS_THRESHOLDS_SHAPE = {
  min_impressions: z.number().int().min(0).default(100).describe('Minimum impressions required to consider an observed query/page row. Must be at least 0. Default is 100.'),
  min_position: z.number().positive().default(8).describe('Minimum Search Console average position for the opportunity range (inclusive). This is an aggregate metric, not a literal current rank. Must be greater than 0. Default is 8.'),
  max_position: z.number().positive().default(20).describe('Maximum Search Console average position for the opportunity range (inclusive). This is an aggregate metric, not a literal current rank. Must be greater than 0. Default is 20.'),
};

export function createQuickWinsInputSchema() {
  return z
    .object({
      site_url: SEARCH_CONSOLE_PROPERTY_SCHEMA,
      start_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('Start date (inclusive) in YYYY-MM-DD format.'),
      end_date: SEARCH_CONSOLE_DATE_SCHEMA.describe('End date (inclusive) in YYYY-MM-DD format. Note the 2-3 day GSC data lag.'),
      ...QUICK_WINS_THRESHOLDS_SHAPE,
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_ANALYSIS_RESULT_LIMIT)
        .default(DEFAULT_ANALYSIS_RESULT_LIMIT)
        .describe('Maximum ordered quick-win results to return in this response.'),
      start_row: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Zero-based offset into the ordered quick-win result list.'),
    })
    .refine(
      ({ min_position, max_position }) => min_position <= max_position,
      POSITION_RANGE_ERROR,
    );
}
