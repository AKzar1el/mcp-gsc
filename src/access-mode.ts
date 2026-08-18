export const GSC_ACCESS_MODES = ['readonly', 'readwrite'] as const;

export type GscAccessMode = (typeof GSC_ACCESS_MODES)[number];

export const DEFAULT_GSC_ACCESS_MODE: GscAccessMode = 'readwrite';

const BASE_OAUTH_SCOPES = ['openid', 'email'] as const;

const READONLY_GOOGLE_OAUTH_SCOPES = [
  ...BASE_OAUTH_SCOPES,
  'https://www.googleapis.com/auth/webmasters.readonly',
] as const;

const READWRITE_GOOGLE_OAUTH_SCOPES = [
  ...BASE_OAUTH_SCOPES,
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
] as const;

export const WRITE_TOOL_NAMES = [
  'sites.add',
  'sites.delete',
  'sitemaps.submit',
  'sitemaps.delete',
  'indexing.request',
] as const;

export function resolveGscAccessMode(value: string | undefined): GscAccessMode {
  if (value === undefined || value === '') {
    return DEFAULT_GSC_ACCESS_MODE;
  }

  if ((GSC_ACCESS_MODES as readonly string[]).includes(value)) {
    return value as GscAccessMode;
  }

  throw new Error(
    'Invalid GSC_ACCESS_MODE configuration. Expected "readonly" or "readwrite".',
  );
}

export function getGoogleOAuthScopes(mode: GscAccessMode): readonly string[] {
  return mode === 'readonly'
    ? READONLY_GOOGLE_OAUTH_SCOPES
    : READWRITE_GOOGLE_OAUTH_SCOPES;
}

export function getToolCatalogForAccessMode<T extends { name: string }>(
  tools: readonly T[],
  mode: GscAccessMode,
): T[] {
  if (mode === 'readwrite') {
    return [...tools];
  }

  return tools.filter(
    (tool) => !(WRITE_TOOL_NAMES as readonly string[]).includes(tool.name),
  );
}
