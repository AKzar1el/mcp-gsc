export const STRUCTURED_RESULT_BYTE_BUDGET = 48_000;
export const DEFAULT_ANALYSIS_RESULT_LIMIT = 50;
export const MAX_ANALYSIS_RESULT_LIMIT = 100;
export const MAX_DIRECT_SOURCE_ROWS = 500;

export interface BoundedItems<T> {
  items: T[];
  byteLimitReached: boolean;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Keep one structured-content list inside a conservative byte budget.
 *
 * Count limits alone are not sufficient because Search Console keys are
 * caller-controlled strings (queries and URLs). This helper therefore applies
 * both the requested item ceiling and an encoded-JSON byte ceiling.
 */
export function takeBoundedItems<T>(
  items: readonly T[],
  maxItems: number,
  byteBudget = STRUCTURED_RESULT_BYTE_BUDGET,
): BoundedItems<T> {
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error('maxItems must be a positive integer.');
  }
  if (!Number.isInteger(byteBudget) || byteBudget < 1) {
    throw new Error('byteBudget must be a positive integer.');
  }

  const bounded: T[] = [];
  // Account for the surrounding JSON array. Per-item commas are added below.
  let usedBytes = 2;
  let byteLimitReached = false;

  for (const item of items.slice(0, maxItems)) {
    const itemBytes = jsonByteLength(item) + (bounded.length > 0 ? 1 : 0);
    if (usedBytes + itemBytes > byteBudget) {
      byteLimitReached = true;
      break;
    }
    bounded.push(item);
    usedBytes += itemBytes;
  }

  return { items: bounded, byteLimitReached };
}

export interface ResultPageMetadata {
  start_row: number;
  limit: number;
  returned_count: number;
  total_count?: number;
  has_more: boolean;
  truncated: boolean;
  byte_limit_reached: boolean;
  next_start_row?: number;
}

export function resultPageMetadata(input: {
  startRow: number;
  limit: number;
  returnedCount: number;
  totalCount?: number;
  hasMore: boolean;
  byteLimitReached: boolean;
}): ResultPageMetadata {
  const {
    startRow,
    limit,
    returnedCount,
    totalCount,
    hasMore,
    byteLimitReached,
  } = input;
  return {
    start_row: startRow,
    limit,
    returned_count: returnedCount,
    ...(totalCount !== undefined ? { total_count: totalCount } : {}),
    has_more: hasMore,
    truncated: hasMore || byteLimitReached,
    byte_limit_reached: byteLimitReached,
    ...(hasMore && returnedCount > 0
      ? { next_start_row: startRow + returnedCount }
      : {}),
  };
}
