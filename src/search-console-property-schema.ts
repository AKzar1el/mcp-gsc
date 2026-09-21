import { z } from 'zod';

export const SEARCH_CONSOLE_PROPERTY_DESCRIPTION =
  "The Search Console property identifier, exactly as returned by sites.list. Domain properties use 'sc-domain:example.com'; URL-prefix properties use an HTTP or HTTPS URL, typically including the trailing slash, e.g. 'https://www.example.com/'. Passing the wrong property form can return a permission error even when the user owns the site - call sites.list first if unsure.";

function isDomainPropertyIdentifier(value: string): boolean {
  if (!value.startsWith('sc-domain:')) return false;
  const domain = value.slice('sc-domain:'.length);
  return (
    domain.length > 0 &&
    !/\s/.test(domain) &&
    !domain.includes('/') &&
    !domain.includes('?') &&
    !domain.includes('#') &&
    !domain.includes('@') &&
    !domain.includes(':')
  );
}

function isUrlPrefixPropertyIdentifier(value: string): boolean {
  if (value !== value.trim() || /\s/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0 &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

export function isSearchConsolePropertyIdentifier(value: string): boolean {
  return isDomainPropertyIdentifier(value) || isUrlPrefixPropertyIdentifier(value);
}

export const SEARCH_CONSOLE_PROPERTY_SCHEMA = z
  .string()
  .refine(isSearchConsolePropertyIdentifier, {
    message:
      "Expected a Search Console property identifier such as 'sc-domain:example.com' or an HTTP/HTTPS URL-prefix property such as 'https://www.example.com/'.",
  })
  .describe(SEARCH_CONSOLE_PROPERTY_DESCRIPTION);
