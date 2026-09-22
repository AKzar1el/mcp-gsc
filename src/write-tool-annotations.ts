/**
 * MCP hints for each mutation exposed by this server.
 *
 * MCP defines destructiveHint=false for non-read-only tools that perform only
 * additive updates. Search Console's site addition and sitemap submission are
 * additive PUT operations; the corresponding DELETE operations remain
 * destructive. Indexing publishes a URL_UPDATED notification with POST; each
 * call can consume quota and change Google's indexing state, so it remains
 * conservative (destructive + non-idempotent). Tool annotations are client
 * hints, not an enforcement or confirmation mechanism.
 */
export const WRITE_TOOL_ANNOTATIONS = {
  'sites.add': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  'sites.delete': {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  'sitemaps.submit': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  'sitemaps.delete': {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  'indexing.request': {
    // The implementation only publishes URL_UPDATED, never URL_DELETED.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const;
