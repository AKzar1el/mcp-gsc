import { z } from 'zod';

export const SEARCH_CONSOLE_PROPERTY_DESCRIPTION =
  "The Search Console property identifier, exactly as returned by sites.list. The current Search Console API documents Domain properties as 'sc-domain:example.com' and URL-prefix properties as an HTTP or HTTPS URL, typically including the trailing slash, e.g. 'https://www.example.com/'. Search Console platform properties for social/video accounts are available in the Search Console UI, but Google has not documented an API siteUrl identifier contract for them; mcp-gsc therefore does not guess one. Call sites.list first if unsure.";

export type SearchConsolePropertyIdentifierKind =
  | 'domain'
  | 'url_prefix'
  | 'undocumented';

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

export function classifySearchConsolePropertyIdentifier(
  value: string,
): SearchConsolePropertyIdentifierKind {
  if (isDomainPropertyIdentifier(value)) return 'domain';
  if (isUrlPrefixPropertyIdentifier(value)) return 'url_prefix';
  return 'undocumented';
}

export const SEARCH_CONSOLE_PROPERTY_SCHEMA = z
  .string()
  .refine(isSearchConsolePropertyIdentifier, {
    message:
      "Expected a Search Console API property identifier such as 'sc-domain:example.com' or an HTTP/HTTPS URL-prefix property such as 'https://www.example.com/'. Platform-property identifiers are not accepted until Google documents their API siteUrl contract.",
  })
  .describe(SEARCH_CONSOLE_PROPERTY_DESCRIPTION);
