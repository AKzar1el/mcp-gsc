import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processPerformanceComparison } from '../src/google';

test('processPerformanceComparison represents zero-baseline percentage changes accurately', () => {
  const comparisons = processPerformanceComparison(
    [
      { keys: ['growth'], clicks: 150, impressions: 1500, ctr: 0, position: 0 },
      { keys: ['decline'], clicks: 50, impressions: 500, ctr: 0, position: 0 },
      { keys: ['new'], clicks: 10, impressions: 20, ctr: 0, position: 0 },
      { keys: ['zero'], clicks: 0, impressions: 0, ctr: 0, position: 0 },
    ],
    [
      { keys: ['growth'], clicks: 100, impressions: 1000, ctr: 0, position: 0 },
      { keys: ['decline'], clicks: 100, impressions: 1000, ctr: 0, position: 0 },
      { keys: ['new'], clicks: 0, impressions: 0, ctr: 0, position: 0 },
      { keys: ['zero'], clicks: 0, impressions: 0, ctr: 0, position: 0 },
      { keys: ['gone'], clicks: 100, impressions: 1000, ctr: 0, position: 0 },
    ],
  );
  const percentages = Object.fromEntries(
    comparisons.map(({ key, diff }) => [
      key,
      {
        clicks: diff.clicks_percentage,
        impressions: diff.impressions_percentage,
      },
    ]),
  );

  assert.deepEqual(percentages, {
    growth: { clicks: 50, impressions: 50 },
    decline: { clicks: -50, impressions: -50 },
    new: { clicks: null, impressions: null },
    zero: { clicks: 0, impressions: 0 },
    gone: { clicks: -100, impressions: -100 },
  });
});
