/**
 * MCP hints for each mutation exposed by this server.
 *
 * Search Console's sites and sitemaps APIs use PUT for additions and DELETE
 * for removals, so repeating the same request has the same intended effect.
 * Indexing publishes a URL_UPDATED notification with POST; each call can
 * consume quota and update Google's notification state, so it is not marked
 * idempotent.
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
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const;
