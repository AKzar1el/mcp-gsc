import { z } from 'zod';

export const URL_INSPECTION_LANGUAGE_CODE_SCHEMA = z
  .string()
  .superRefine((value, ctx) => {
    try {
      if (Intl.getCanonicalLocales(value).length !== 1) {
        throw new RangeError('Invalid language tag');
      }
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          "language_code must be a valid BCP-47 language tag, e.g. 'en-US' or 'de-CH'.",
      });
    }
  })
  .default('en-US')
  .describe(
    "BCP-47 language code for translatable strings in the result, e.g. 'en-US' or 'de-CH'.",
  );
