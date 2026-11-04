import { z } from 'zod';

export const SITEMAP_URL_SCHEMA = z
  .string()
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
