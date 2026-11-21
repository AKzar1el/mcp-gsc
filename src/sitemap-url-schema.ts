import { z } from 'zod';

export const SITEMAP_URL_SCHEMA = z
  .string()
  .url()
  .refine((value) => {
    // The URL parser normalizes these bytes, but the API receives the original string.
    if (value !== value.trim() || /[\x00-\x20\x7f\\]/.test(value)) return false;
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
  }, 'Sitemap URL must use http:// or https:// without embedded credentials, fragments, raw whitespace, control characters, or backslashes.');
