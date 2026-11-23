import { z } from 'zod';

// Preserve the exact caller input; silent URL normalization would change the
// page that Google receives in a case-sensitive exact-page filter.
export const PRESERVED_URL_SCHEMA = z
  .string()
  // Keep Unicode-sensitive checks server-side: JSON Schema has no regex flags,
  // so serializing \p{} into pattern can reject valid URLs in ordinary clients.
  .refine(
    (value) => !/[\p{White_Space}\p{Cc}\\]/u.test(value),
    'Exact page URL must not contain raw whitespace, control characters, or backslashes.',
  )
  .url();

export const EXACT_PAGE_URL_SCHEMA = PRESERVED_URL_SCHEMA.max(2048);
