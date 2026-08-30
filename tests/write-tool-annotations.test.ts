import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WRITE_TOOL_ANNOTATIONS } from '../src/write-tool-annotations';

test('write tools expose operation-specific MCP annotations', () => {
  assert.deepEqual(WRITE_TOOL_ANNOTATIONS, {
    'sites.add': {
      readOnlyHint: false,
      destructiveHint: true,
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
      destructiveHint: true,
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
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  });
});
