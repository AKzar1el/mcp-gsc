import { z } from 'zod';

// Preserve the exact caller input; silent URL normalization would change the
// page that Google receives in a case-sensitive exact-page filter.
export const EXACT_PAGE_URL_SCHEMA = z
  .string()
  .regex(
    /^[^\p{White_Space}\p{Cc}\\]*$/u,
    'Exact page URL must not contain raw whitespace, control characters, or backslashes.',
  )
  .url()
  .max(2048);
