import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SITEMAP_URL_SCHEMA } from '../src/sitemap-url-schema';

test('sitemap URL validation rejects raw whitespace, controls, and backslashes', () => {
  for (const url of [
    ' https://example.com/sitemap.xml',
    'https://example.com/sitemap.xml ',
    'https://example.com/sitemap.xml\n',
    'https://example.com/sitemap.xml\t',
    'https://example.com/news sitemap.xml',
    'https://example.com\\sitemap.xml',
    'https://example.com/sitemap\u007f.xml',
  ]) {
    assert.equal(SITEMAP_URL_SCHEMA.safeParse(url).success, false, JSON.stringify(url));
  }
});

test('percent-encoded URL path characters remain valid', () => {
  for (const url of [
    'https://example.com/news%20sitemap.xml',
    'https://example.com/path%5Csegment.xml',
    'https://example.com/sitemap.xml?part=1',
  ]) {
    assert.equal(SITEMAP_URL_SCHEMA.safeParse(url).success, true, url);
  }
});
