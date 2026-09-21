import { z } from 'zod';

export const SITEMAP_URL_SCHEMA = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Sitemap URL must use http:// or https://.');
