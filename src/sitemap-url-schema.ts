import { z } from 'zod';

export const SITEMAP_URL_SCHEMA = z
  .string()
  // Check raw bytes before Zod URL parsing normalizes whitespace and backslashes.
  .refine(
    (value) => value === value.trim() && !/[\x00-\x20\x7f\\]/.test(value),
    'Sitemap URL must not contain raw whitespace, control characters, or backslashes.',
  )
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username === '' &&
        parsed.password === '' &&
        !value.includes('#')
      );
    } catch {
      return false;
    }
  }, 'Sitemap URL must use http:// or https:// without embedded credentials or fragments.');
