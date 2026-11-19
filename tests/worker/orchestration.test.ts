import { afterEach, describe, expect, it, vi } from 'vitest';
import { reset, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { generateWeeklyDigest } from '../../src/digest';
import { getSearchConsoleCalendarDate } from '../../src/date-validation';
import { GoogleAccessTokenLifecycle } from '../../src/access-token-lifecycle';
import {
  createGscMcpServer,
  defaultHandler,
  mcpApiHandler,
  PendingAuthState,
  type Env,
} from '../../src/index';
import {
  GSC_ACCESS_REVOKED_MESSAGE,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
} from '../../src/google';
import { getDecryptedRefreshToken, getUser, saveUser } from '../../src/storage';

const workerEnv = env as unknown as Env;

afterEach(async () => {
  await reset();
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

async function readMcpJsonRpc(response: Response) {
  const text = await response.text();
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  return JSON.parse(dataLines.length ? dataLines.join('') : text) as Record<string, unknown>;
}

function createPendingStateBinding() {
  const pending = new Map<string, { claudeAuthRequest: unknown }>();
  return {
    idFromName: (nonce: string) => nonce,
    get: (nonce: string) => ({
      store: async (claudeAuthRequest: unknown) => {
        pending.set(nonce, { claudeAuthRequest });
      },
      consume: async () => {
        const value = pending.get(nonce) ?? null;
        pending.delete(nonce);
        return value;
      },
    }),
  };
}

describe('Worker orchestration', () => {
  it('guides a finalized daily traffic-onset review without provider calls on retrieval', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (value: unknown) => Promise<{ success: boolean }> };
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-daily-onset-review'];
    expect(prompt).toBeDefined();
    const args = {
      site_url: 'sc-domain:example.com',
      end_date: '2026-11-10',
      search_type: 'web',
      page_contains: '/tools/',
      country: 'deu',
      device: 'mobile',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await prompt.argsSchema.safeParseAsync(args)).success).toBe(true);
      expect((await prompt.argsSchema.safeParseAsync({ ...args, site_url: 'javascript:alert(1)' })).success).toBe(false);
      expect((await prompt.argsSchema.safeParseAsync({ ...args, search_type: 'webMultimodal' })).success).toBe(true);
      const guidance = (await prompt.handler(args)).messages[0].content.text;
      expect(guidance).toContain('2026-10-21');
      expect(guidance).toContain('2026-11-10');
      expect(guidance).toContain('dimensions=["date"]');
      expect(guidance).toContain('analytics.query');
      expect(guidance).toContain('data_state="final"');
      expect(guidance).toContain('seven days earlier');
      expect(guidance).toContain('not measured zero');
      expect(guidance).toContain('"country":"DEU"');
      expect(guidance).toContain('"device":"MOBILE"');
      const multimodal = (await prompt.handler({ ...args, search_type: 'webMultimodal' })).messages[0].content.text;
      expect(multimodal).toContain('"search_type":"webMultimodal"');
      expect(multimodal).toContain('Never request the unavailable text-query dimension');
      expect(guidance).toContain('Never call indexing.request');
      expect(fetchSpy).not.toHaveBeenCalled();
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await expect(prompt.handler({ ...args, end_date: futureDate })).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('preserves multi-country and multi-device daily-onset scopes without extra provider calls', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (value: unknown) => Promise<{ success: boolean; data?: Record<string, unknown> }> };
        handler: (args: Record<string, unknown>) => Promise<{ messages: Array<{ content: { text: string } }> }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-daily-onset-review'];
    const parsed = await prompt.argsSchema.safeParseAsync({
      site_url: 'sc-domain:example.com',
      end_date: '2026-11-10',
      search_type: 'webMultimodal',
      page_contains: '/de/',
      countries: 'deu,aut',
      devices: 'mobile,desktop',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.countries).toEqual(['deu', 'aut']);
    expect(parsed.data?.devices).toEqual(['mobile', 'desktop']);
    expect((await prompt.argsSchema.safeParseAsync({
      site_url: 'sc-domain:example.com', countries: 'DEU,invalid-country',
    })).success).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const guidance = (await prompt.handler(parsed.data!)).messages[0].content.text;
      expect(guidance).toContain('"countries":["DEU","AUT"]');
      expect(guidance).toContain('"devices":["MOBILE","DESKTOP"]');
      expect(guidance).toContain('dimensions=["date"]');
      expect(guidance).toContain('filterLists');
      expect(guidance).toContain('OR within');
      expect(guidance).toContain('gsc-traffic-drop-triage does not accept webMultimodal');
      expect(guidance).toContain('same exact property');
      expect(guidance).not.toContain('Its current arguments cannot preserve multi-value scopes');
      const webFollowUp = (await prompt.handler({ ...parsed.data, search_type: 'web' })).messages[0].content.text;
      expect(webFollowUp).toContain('gsc-traffic-drop-triage');
      expect(webFollowUp).toContain('Its multi-value path preserves lists through identical Google-side filterLists');
      expect(webFollowUp).toContain('country/device or countries/devices filters without scope narrowing');
      expect(webFollowUp).not.toContain('Its current arguments cannot preserve multi-value scopes');
      expect(guidance).toContain('not measured zero');
      await expect(prompt.handler({ ...parsed.data, country: 'DEU' })).rejects.toThrow();
      await expect(prompt.handler({ ...parsed.data, device: 'mobile' })).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('guides bounded top-query cohort movement without Google calls on prompt retrieval', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (value: unknown) => Promise<{ success: boolean }> };
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-query-cohort-review'];
    expect(prompt).toBeDefined();
    const args = {
      site_url: 'sc-domain:example.com',
      end_date: '2026-11-10',
      search_type: 'image',
      page_contains: '/de/',
      query_contains: 'sitemap',
      country: 'deu',
      device: 'mobile',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await prompt.argsSchema.safeParseAsync(args)).success).toBe(true);
      expect((await prompt.argsSchema.safeParseAsync({ ...args, site_url: 'javascript:bad' })).success).toBe(false);
      expect((await prompt.argsSchema.safeParseAsync({ ...args, search_type: 'webMultimodal' })).success).toBe(false);
      const guidance = (await prompt.handler(args)).messages[0].content.text;
      expect(guidance).toContain('2026-11-04');
      expect(guidance).toContain('2026-11-10');
      expect(guidance).toContain('2026-10-28');
      expect(guidance).toContain('2026-11-03');
      expect(guidance).toContain('dimensions=["query"]');
      expect(guidance).toContain('row_limit=100');
      expect(guidance).toContain('data_state="final"');
      expect(guidance).toContain('not measured zero');
      expect(guidance).toContain('"country":"DEU"');
      expect(guidance).toContain('"device":"MOBILE"');
      expect(guidance).toContain('Never call indexing.request');
      expect(fetchSpy).not.toHaveBeenCalled();
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await expect(prompt.handler({ ...args, end_date: futureDate })).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('preserves multi-country and multi-device query-cohort scopes in both periods', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (value: unknown) => Promise<{ success: boolean; data?: Record<string, unknown> }> };
        handler: (args: Record<string, unknown>) => Promise<{ messages: Array<{ content: { text: string } }> }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-query-cohort-review'];
    const parsed = await prompt.argsSchema.safeParseAsync({
      site_url: 'sc-domain:example.com',
      end_date: '2026-11-10',
      countries: 'deu,svn',
      devices: 'mobile,desktop',
      query_contains: 'sitemap',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.countries).toEqual(['deu', 'svn']);
    expect(parsed.data?.devices).toEqual(['mobile', 'desktop']);
    expect((await prompt.argsSchema.safeParseAsync({
      site_url: 'sc-domain:example.com',
      countries: 'DEU,not-a-country',
    })).success).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const guidance = (await prompt.handler(parsed.data!)).messages[0].content.text;
      expect(guidance).toContain('"countries":["DEU","SVN"]');
      expect(guidance).toContain('"devices":["MOBILE","DESKTOP"]');
      expect(guidance).toContain('filterLists');
      expect(guidance).toContain('OR within');
      expect(guidance).toContain('identically to BOTH');
      expect(guidance).toContain('cannot preserve the multi-value scope');
      await expect(prompt.handler({ ...parsed.data, country: 'DEU' })).rejects.toThrow();
      await expect(prompt.handler({ ...parsed.data, device: 'mobile' })).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('guides a finalized page-cohort review with identical multi-segment scopes and no provider calls', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (value: unknown) => Promise<{ success: boolean; data?: Record<string, unknown> }> };
        handler: (args: Record<string, unknown>) => Promise<{ messages: Array<{ content: { text: string } }> }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-page-cohort-review'];
    expect(prompt).toBeDefined();
    const parsed = await prompt.argsSchema.safeParseAsync({
      site_url: 'sc-domain:example.com',
      end_date: '2026-06-20',
      search_type: 'image',
      page_contains: '/tools/',
      countries: 'deu,svn',
      devices: 'mobile,desktop',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.countries).toEqual(['deu', 'svn']);
    expect((await prompt.argsSchema.safeParseAsync({ site_url: 'sc-domain:example.com', countries: 'invalid-value' })).success).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const guidance = (await prompt.handler(parsed.data!)).messages[0].content.text;
      expect(guidance).toContain('2026-06-14');
      expect(guidance).toContain('2026-06-07');
      expect(guidance).toContain('dimensions=["page"]');
      expect(guidance).toContain('row_limit=100');
      expect(guidance).toContain('data_state="final"');
      expect(guidance).toContain('"countries":["DEU","SVN"]');
      expect(guidance).toContain('"devices":["MOBILE","DESKTOP"]');
      expect(guidance).toContain('filterLists');
      expect(guidance).toContain('identically to BOTH');
      expect(guidance).toContain('not measured zero');
      expect(guidance).toContain('Never call indexing.request');
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(prompt.handler({ ...parsed.data, country: 'DEU' })).rejects.toThrow();
      await expect(prompt.handler({ ...parsed.data, device: 'mobile' })).rejects.toThrow();
      expect((await prompt.argsSchema.safeParseAsync({ ...parsed.data, search_type: 'webMultimodal' })).success).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offers a scoped read-only traffic-drop workflow as an MCP prompt', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { type: string; text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    expect(prompts['gsc-traffic-drop-triage']).toBeDefined();

    const result = await prompts['gsc-traffic-drop-triage'].handler({
      site_url: 'sc-domain:example.com',
      end_date: '2026-11-10',
      page_contains: '/de/',
    });
    const guidance = result.messages[0].content.text;
    expect(guidance).toContain('sc-domain:example.com');
    expect(guidance).toContain('2026-11-10');
    expect(guidance).toContain('/de/');
    expect(guidance).toContain('reports.weekly_digest');
    expect(guidance).toContain('insights.content_decay');
    expect(guidance).toContain('analytics.compare');
    expect(guidance).toContain('urls.inspect');
    expect(guidance).toContain('not zero traffic');
    expect(guidance).toContain('do not submit');
    const segmented = await prompts['gsc-traffic-drop-triage'].handler({
      site_url: 'sc-domain:example.com',
      end_date: '2026-11-10',
      page_contains: '/de/',
      search_type: 'image',
      country: 'deu',
      device: 'mobile',
    });
    const segmentedGuidance = segmented.messages[0].content.text;
    expect(segmentedGuidance).toContain('"search_type":"image"');
    expect(segmentedGuidance).toContain('"country":"DEU"');
    expect(segmentedGuidance).toContain('"device":"MOBILE"');
    expect(segmentedGuidance).toContain('reports.weekly_digest');
    expect(segmentedGuidance).toContain('insights.content_decay');
    expect(segmentedGuidance).toContain('analytics.compare');
    expect(segmentedGuidance).toContain('identical Google-side filters');
    expect(segmentedGuidance).toContain('segment-only');
    expect(segmentedGuidance).toContain('not zero traffic');
    await expect(prompts['gsc-traffic-drop-triage'].handler({
      site_url: 'sc-domain:example.com',
      end_date: '2999-01-01',
      country: 'deu',
    })).rejects.toThrow('end_date');
    await expect(prompts['gsc-traffic-drop-triage'].handler({
      site_url: 'https://example.com/?unexpected=1',
    })).rejects.toThrow();
  });

  it('keeps multi-region/device traffic-drop triage within matching finalized Google scopes', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (value: unknown) => Promise<{ success: boolean; data?: Record<string, unknown> }> };
        handler: (args: Record<string, unknown>) => Promise<{ messages: Array<{ content: { text: string } }> }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-traffic-drop-triage'];
    const parsed = await prompt.argsSchema.safeParseAsync({
      site_url: 'sc-domain:example.com',
      end_date: '2026-06-20',
      search_type: 'web',
      page_contains: '/tools/',
      countries: 'deu,svn',
      devices: 'mobile,desktop',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.countries).toEqual(['deu', 'svn']);
    expect(parsed.data?.devices).toEqual(['mobile', 'desktop']);
    expect((await prompt.argsSchema.safeParseAsync({
      site_url: 'sc-domain:example.com', countries: 'DEU,invalid-country',
    })).success).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const guidance = (await prompt.handler(parsed.data!)).messages[0].content.text;
      expect(guidance).toContain('"countries":["DEU","SVN"]');
      expect(guidance).toContain('"devices":["MOBILE","DESKTOP"]');
      expect(guidance).toContain('"start_date_a":"2026-06-14"');
      expect(guidance).toContain('"start_date_b":"2026-06-07"');
      expect(guidance).toContain('dimensions=["date"]');
      expect(guidance).toContain('filterLists');
      expect(guidance).toContain('OR within');
      expect(guidance).toContain('cannot preserve multi-value scopes');
      expect(guidance).toContain('reports.weekly_digest and insights.content_decay can preserve the same countries/devices arrays');
      expect(guidance).toContain('missing days are unknown');
      expect(guidance).toContain('Never call indexing.request');
      await expect(prompt.handler({ ...parsed.data, country: 'DEU' })).rejects.toThrow();
      await expect(prompt.handler({ ...parsed.data, device: 'mobile' })).rejects.toThrow();
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await expect(prompt.handler({ ...parsed.data, end_date: futureDate })).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('guides a finalized country-movement review without calling Google on prompt retrieval', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (value: unknown) => Promise<{ success: boolean }> };
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-country-movement-review'];
    expect(prompt).toBeDefined();
    const args = {
      site_url: 'sc-domain:example.com',
      end_date: '2026-11-10',
      search_type: 'image',
      page_contains: '/de/',
      device: 'mobile',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await prompt.argsSchema.safeParseAsync(args)).success).toBe(true);
      expect((await prompt.argsSchema.safeParseAsync({ ...args, site_url: 'javascript:alert(1)' })).success).toBe(false);
      expect((await prompt.argsSchema.safeParseAsync({ ...args, search_type: 'webMultimodal' })).success).toBe(true);
      const guidance = (await prompt.handler(args)).messages[0].content.text;
      expect(guidance).toContain('sc-domain:example.com');
      expect(guidance).toContain('2026-11-04');
      expect(guidance).toContain('2026-10-28');
      expect(guidance).toContain('dimension=country');
      expect(guidance).toContain('analytics.compare');
      expect(guidance).toContain('"search_type":"image"');
      expect(guidance).toContain('"page_contains":"/de/"');
      expect(guidance).toContain('"device":"MOBILE"');
      expect(guidance).toContain('Searcher country is not page language');
      const multimodal = (await prompt.handler({ ...args, search_type: 'webMultimodal' })).messages[0].content.text;
      expect(multimodal).toContain('"search_type":"webMultimodal"');
      expect(multimodal).toContain('Text-query dimensions and filters are unavailable');
      expect(guidance).toContain('missing rows are not zero');
      expect(guidance).toContain('not exhaustive');
      expect(guidance).toContain('Never call indexing.request');
      expect(fetchSpy).not.toHaveBeenCalled();
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await expect(prompt.handler({ ...args, end_date: futureDate })).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offers a property-scoped index-status triage prompt without Google requests', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { type: string; text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    expect(prompts['gsc-index-status-triage']).toBeDefined();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await prompts['gsc-index-status-triage'].handler({
        site_url: 'sc-domain:example.com',
        inspection_url: 'https://blog.example.com/article/',
      });
      const guidance = result.messages[0].content.text;
      expect(guidance).toContain('sc-domain:example.com');
      expect(guidance).toContain('https://blog.example.com/article/');
      expect(guidance).toContain('urls.inspect');
      expect(guidance).toContain('sitemaps.list');
      expect(guidance).toContain('canonical');
      expect(guidance).toContain('noindex');
      expect(guidance).toContain('not a live URL test');
      expect(guidance).toContain('Never call indexing.request');
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(prompts['gsc-index-status-triage'].handler({
        site_url: 'sc-domain:example.com',
        inspection_url: 'https://unrelated.test/',
      })).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offers a property-bounded batch index review without requesting Google or hiding errors', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<{
          messages: Array<{ content: { type: string; text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    expect(prompts['gsc-index-batch-review']).toBeDefined();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const site_url = 'sc-domain:example.com';
    const inspection_urls = [
      'https://example.com/en/',
      'https://blog.example.com/de/',
    ];
    try {
      const result = await prompts['gsc-index-batch-review'].handler({ site_url, inspection_urls });
      const guidance = result.messages[0].content.text;
      expect(guidance).toContain(JSON.stringify({ site_url, inspection_urls }));
      expect(guidance).toContain('urls.inspect_many');
      expect(guidance).toContain('20');
      expect(guidance).toContain('per-URL');
      expect(guidance).toContain('index_status_counts');
      expect(guidance).toContain('unknown');
      expect(guidance).toContain('not_indexed');
      expect(guidance).toContain('not a live URL test');
      expect(guidance).toContain('Never call indexing.request');
      expect(fetchSpy).not.toHaveBeenCalled();

      await expect(prompts['gsc-index-batch-review'].handler({
        site_url,
        inspection_urls: ['https://example.com/en/', 'https://unrelated.test/'],
      })).rejects.toThrow();
      await expect(prompts['gsc-index-batch-review'].handler({
        site_url,
        inspection_urls: [inspection_urls[0], inspection_urls[0]],
      })).rejects.toThrow();
      await expect(prompts['gsc-index-batch-review'].handler({
        site_url,
        inspection_urls: [inspection_urls[0]],
      })).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('guides first-use property readiness without provider calls or silently selecting a site', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (args: unknown) => Promise<{ success: boolean }> };
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-property-readiness-review'];
    expect(prompt).toBeDefined();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await prompt.argsSchema.safeParseAsync({})).success).toBe(true);
      expect((await prompt.argsSchema.safeParseAsync({ site_url: 'sc-domain:example.com' })).success).toBe(true);
      expect((await prompt.argsSchema.safeParseAsync({ site_url: 'javascript:alert(1)' })).success).toBe(false);
      for (const args of [{}, { site_url: 'sc-domain:example.com' }]) {
        const guidance = (await prompt.handler(args)).messages[0].content.text;
        expect(guidance).toContain('server.capabilities');
        expect(guidance).toContain('provider_auth_live_verified');
        expect(guidance).toContain('sites.list');
        expect(guidance).toContain('sites.get');
        expect(guidance).toContain('permissionLevel');
        expect(guidance).toContain('Do not silently select');
        expect(guidance).toContain('Never call sites.add');
        expect(guidance).toContain(JSON.stringify({ site_url: args.site_url ?? null }));
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offers a quota-bounded sitemap health review without Google requests or indexing claims', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (args: unknown) => Promise<{ success: boolean }> };
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-sitemap-health-review'];
    expect(prompt).toBeDefined();

    const args = {
      site_url: 'sc-domain:example.com',
      sitemap_index: 'https://sitemaps.example.net/site-index.xml',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await prompt.argsSchema.safeParseAsync(args)).success).toBe(true);
      expect((await prompt.argsSchema.safeParseAsync({
        ...args,
        sitemap_index: 'javascript:alert(1)',
      })).success).toBe(false);
      const guidance = (await prompt.handler(args)).messages[0].content.text;
      expect(guidance).toContain(JSON.stringify(args));
      expect(guidance).toContain('sitemaps.list');
      expect(guidance).toContain('sitemaps.get');
      expect(guidance).toContain('result_page.next_start_row');
      expect(guidance).toContain('lastDownloaded');
      expect(guidance).toContain('isPending');
      expect(guidance).toContain('not page indexing');
      expect(guidance).toContain('cross-site');
      expect(guidance).toContain('Never call sitemaps.submit');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('guides a bounded read-only Search Appearance comparison using discovered types', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (args: unknown) => Promise<{ success: boolean }> };
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    const prompt = prompts['gsc-search-appearance-review'];
    expect(prompt).toBeDefined();
    const args = {
      site_url: 'sc-domain:example.com',
      end_date: '2026-11-10',
      search_type: 'web',
      country: 'deu',
      device: 'mobile',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect((await prompt.argsSchema.safeParseAsync(args)).success).toBe(true);
      expect((await prompt.argsSchema.safeParseAsync({
        ...args,
        site_url: 'javascript:alert(1)',
      })).success).toBe(false);
      const guidance = (await prompt.handler(args)).messages[0].content.text;
      expect(guidance).toContain('sc-domain:example.com');
      expect(guidance).toContain('searchAppearance');
      expect(guidance).toContain('only grouping dimension');
      expect(guidance).toContain('two adjacent');
      expect(guidance).toContain('exact returned');
      expect(guidance).toContain('final');
      expect(guidance).toContain('DEU');
      expect(guidance).toContain('MOBILE');
      expect(guidance).toContain('not a complete');
      expect(guidance).toContain('Never call indexing.request');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('preserves multi-market scopes in Search Appearance discovery and observed-type drilldown', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompt = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (args: unknown) => Promise<{ success: boolean; data?: Record<string, unknown> }> };
        handler: (args: Record<string, unknown>) => Promise<{ messages: Array<{ content: { text: string } }> }>;
      }>;
    })._registeredPrompts['gsc-search-appearance-review'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const parsed = await prompt.argsSchema.safeParseAsync({
        site_url: 'sc-domain:example.com',
        search_type: 'web',
        countries: 'deu,usa',
        devices: '["desktop","mobile"]',
      });
      expect(parsed.success).toBe(true);
      const guidance = (await prompt.handler(parsed.data!)).messages[0].content.text;
      expect(guidance).toContain('"countries":["DEU","USA"]');
      expect(guidance).toContain('"devices":["DESKTOP","MOBILE"]');
      expect(guidance).toContain('filterLists');
      expect(guidance).toContain('same');
      expect(guidance).toContain('observed');
      expect(guidance).toContain('not separate');
      await expect(prompt.handler({
        ...parsed.data!, country: 'deu',
      })).rejects.toThrow('Supply either country or countries');
      await expect(prompt.handler({
        ...parsed.data!, device: 'mobile',
      })).rejects.toThrow('Supply either device or devices');
      await expect(prompt.handler({
        ...parsed.data!, countries: ['DEU', 'DEU'],
      })).rejects.toThrow('Country list cannot contain duplicates');
      expect((await prompt.argsSchema.safeParseAsync({ site_url: 'sc-domain:example.com', countries: 'DEU,USA,FRA,GBR,ESP,ITA,NLD,CAN,AUS,JPN,SWE' })).success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects future reporting dates in guided client, brand, and visual prompts without Google calls', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (args: unknown) => Promise<{ success: boolean; data?: Record<string, unknown> }> };
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredPrompts;
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const name of ['gsc-brand-traffic-review', 'gsc-visual-search-review', 'gsc-weekly-client-report']) {
        const prompt = prompts[name];
        expect(prompt, name).toBeDefined();
        const parsed = await prompt.argsSchema.safeParseAsync({
          site_url: 'sc-domain:example.com', end_date: futureDate,
        });
        expect(parsed.success, name).toBe(true);
        await expect(prompt.handler(parsed.data!)).rejects.toThrow('end_date must be today or earlier');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('accepts protocol string arguments for list-valued MCP prompts', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: {
          safeParseAsync: (value: unknown) => Promise<{
            success: boolean;
            data?: Record<string, unknown>;
          }>;
        };
        handler: (args: Record<string, unknown>) => Promise<{
          messages: Array<{ content: { text: string } }>;
        }>;
      }>;
    })._registeredPrompts;

    const cases = [
      {
        name: 'gsc-index-batch-review',
        args: {
          site_url: 'sc-domain:example.com',
          inspection_urls: 'https://example.com/en/\nhttps://blog.example.com/de/',
        },
        includes: 'urls.inspect_many',
      },
      {
        name: 'gsc-brand-traffic-review',
        args: {
          site_url: 'sc-domain:example.com',
          countries: 'deu, usa',
          devices: 'mobile,desktop',
        },
        includes: '"countries":["DEU","USA"]',
      },
      {
        name: 'gsc-visual-search-review',
        args: {
          site_url: 'sc-domain:example.com',
          countries: 'deu, usa',
          devices: 'mobile,desktop',
        },
        includes: '"devices":["MOBILE","DESKTOP"]',
      },
    ];

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const { name, args, includes } of cases) {
        // MCP prompts/get transmits every argument as a string. Test the SDK
        // schema boundary, not only the already-parsed callback directly.
        const parsed = await prompts[name].argsSchema.safeParseAsync(args);
        expect(parsed.success, `${name} should accept wire-format strings`).toBe(true);
        if (!parsed.success || !parsed.data) continue;
        const result = await prompts[name].handler(parsed.data);
        expect(result.messages[0].content.text).toContain(includes);
      }
      const batchSchema = prompts['gsc-index-batch-review'].argsSchema;
      const site_url = 'sc-domain:example.com';
      expect((await batchSchema.safeParseAsync({
        site_url,
        inspection_urls: '["https://example.com/a/","https://example.com/b/"]',
      })).success).toBe(true);
      expect((await batchSchema.safeParseAsync({
        site_url,
        inspection_urls: ['https://example.com/a/', 'https://example.com/b/'],
      })).success).toBe(true);
      expect((await batchSchema.safeParseAsync({
        site_url,
        inspection_urls: 'https://example.com/a/\nhttps://example.com/a/',
      })).success).toBe(false);
      expect((await prompts['gsc-brand-traffic-review'].argsSchema.safeParseAsync({
        site_url,
        countries: 'DEU,NOT_A_COUNTRY',
      })).success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offers a scoped client-ready weekly report prompt without provider calls or outbound actions', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { type: string; text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    expect(prompts['gsc-weekly-client-report']).toBeDefined();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const report = await prompts['gsc-weekly-client-report'].handler({
        site_url: 'sc-domain:example.com',
        end_date: '2026-11-10',
        search_type: 'web',
        page_contains: '/de/',
        query_contains: 'technical seo',
        country: 'DEU',
        device: 'mobile',
      });
      const guidance = report.messages[0].content.text;
      for (const value of ['sc-domain:example.com', '2026-11-10', '/de/', 'technical seo', 'DEU', 'mobile']) {
        expect(guidance).toContain(value);
      }
      expect(guidance).toContain('reports.weekly_digest');
      expect(guidance).toContain('analytics.compare');
      expect(guidance).toContain('not property-wide');
      expect(guidance).toContain('not zero traffic');
      expect(guidance).toContain('Never email');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('preserves multi-country and device scope in guided weekly client reporting', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: {
          safeParseAsync: (input: unknown) => Promise<{
            success: boolean;
            data?: Record<string, unknown>;
          }>;
        };
        handler: (args: Record<string, unknown>) => Promise<{
          messages: Array<{ content: { text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    const weekly = prompts['gsc-weekly-client-report'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const parsed = await weekly.argsSchema.safeParseAsync({
        site_url: 'sc-domain:example.com',
        end_date: '2026-11-10',
        search_type: 'web',
        page_contains: '/de/',
        countries: 'DEU,AUT',
        devices: '["mobile","desktop"]',
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.countries).toEqual(['DEU', 'AUT']);
      expect(parsed.data?.devices).toEqual(['mobile', 'desktop']);

      const response = await weekly.handler(parsed.data!);
      const guidance = response.messages[0].content.text;
      expect(guidance).toContain('"countries":["DEU","AUT"]');
      expect(guidance).toContain('"devices":["MOBILE","DESKTOP"]');
      expect(guidance).toContain('reports.weekly_digest');
      expect(guidance).toContain('Google-side filterLists');
      expect(guidance).toContain('Do not call analytics.compare');
      expect(guidance).toContain('not property-wide');
      expect(guidance).toContain('Never email');
      await expect(weekly.handler({
        site_url: 'sc-domain:example.com',
        country: 'DEU',
        countries: ['AUT'],
      })).rejects.toThrow('country or countries');
      await expect(weekly.handler({
        site_url: 'sc-domain:example.com',
        device: 'mobile',
        devices: ['desktop'],
      })).rejects.toThrow('device or devices');
      await expect(weekly.handler({
        site_url: 'sc-domain:example.com',
        countries: ['deu', 'DEU'],
      })).rejects.toThrow('duplicates');
      expect((await weekly.argsSchema.safeParseAsync({
        site_url: 'sc-domain:example.com',
        countries: 'DEU,AUT,CHE,SVN,HRV,ITA,FRA,ESP,PRT,NLD,GBR',
      })).success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offers a native brand-segmentation review prompt without provider requests', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<{
          messages: Array<{ content: { type: string; text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    expect(prompts['gsc-brand-traffic-review']).toBeDefined();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await prompts['gsc-brand-traffic-review'].handler({
        site_url: 'sc-domain:example.com',
        end_date: '2026-11-10',
        search_type: 'image',
        countries: ['deu', 'aut'],
        devices: ['mobile', 'desktop'],
      });
      const guidance = result.messages[0].content.text;
      for (const value of ['sc-domain:example.com', '2026-11-10', 'image', 'analytics.query', 'brandedClassification', 'BRANDED', 'NON_BRANDED']) {
        expect(guidance).toContain(value);
      }
      expect(guidance).toContain('no rows');
      expect(guidance).toContain('not measured zero traffic');
      expect(guidance).toContain('Do not use a query filter');
      expect(guidance).toContain('filterLists');
      expect(guidance).toContain('DEU');
      expect(guidance).toContain('AUT');
      expect(guidance).toContain('MOBILE');
      expect(guidance).toContain('DESKTOP');
      expect(guidance).toContain('identical regional and device');
      expect(guidance).toContain('Never call indexing.request');
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(prompts['gsc-brand-traffic-review'].handler({
        site_url: 'https://example.com/?bad=1',
      })).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offers a visual-search page review prompt without provider requests or unsupported query grouping', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<{
          messages: Array<{ content: { type: string; text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    expect(prompts['gsc-visual-search-review']).toBeDefined();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await prompts['gsc-visual-search-review'].handler({
        site_url: 'sc-domain:example.com',
        end_date: '2026-11-10',
        page_contains: '/de/',
        countries: ['deu', 'aut'],
        devices: ['mobile'],
      });
      const guidance = result.messages[0].content.text;
      for (const value of ['sc-domain:example.com', '2026-11-10', '/de/', 'DEU', 'AUT', 'MOBILE']) {
        expect(guidance).toContain(value);
      }
      expect(guidance).toContain('webMultimodal');
      expect(guidance).toContain('analytics.query');
      expect(guidance).toContain('analytics.compare');
      expect(guidance).toContain('dimension="page"');
      expect(guidance).toContain('dimensions=[]');
      expect(guidance).toContain('filterLists');
      expect(guidance).toContain('text query');
      expect(guidance).toContain('not measured zero');
      expect(guidance).toContain('Never call indexing.request');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offers a quota-aware quick-win review prompt without triggering Google calls', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { type: string; text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    expect(prompts['gsc-quick-win-review']).toBeDefined();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const response = await prompts['gsc-quick-win-review'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-10-01',
        end_date: '2026-10-28',
        search_type: 'web',
        page_contains: '/de/',
        query_contains: 'technical seo',
        country: 'DEU',
        device: 'mobile',
      });
      const text = response.messages[0].content.text;
      for (const expected of ['sc-domain:example.com', '2026-10-01', '2026-10-28', '/de/', 'technical seo', 'DEU', 'mobile']) {
        expect(text).toContain(expected);
      }
      expect(text).toContain('insights.quick_wins');
      expect(text).toContain('insights.page_queries');
      expect(text).toContain('not property-wide');
      expect(text).toContain('not a live rank');
      expect(text).toContain('not zero traffic');
      expect(text).toContain('Never request indexing');
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(prompts['gsc-quick-win-review'].handler({
        site_url: 'sc-domain:example.com', start_date: '2026-10-28', end_date: '2026-10-01',
      })).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('preserves combined country/device scopes in guided quick-win discovery without provider calls', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompt = (server as unknown as {
      _registeredPrompts: Record<string, {
        argsSchema: { safeParseAsync: (args: unknown) => Promise<{ success: boolean; data?: Record<string, unknown> }> };
        handler: (args: Record<string, unknown>) => Promise<{ messages: Array<{ content: { text: string } }> }>;
      }>;
    })._registeredPrompts['gsc-quick-win-review'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const parsed = await prompt.argsSchema.safeParseAsync({
        site_url: 'sc-domain:example.com',
        start_date: '2026-10-01',
        end_date: '2026-10-28',
        page_contains: '/de/',
        query_contains: 'technical seo',
        countries: 'deu,usa',
        devices: '["desktop","mobile"]',
      });
      expect(parsed.success).toBe(true);
      const guidance = (await prompt.handler(parsed.data!)).messages[0].content.text;
      expect(guidance).toContain('"countries":["DEU","USA"]');
      expect(guidance).toContain('"devices":["DESKTOP","MOBILE"]');
      expect(guidance).toContain('insights.quick_wins once');
      expect(guidance).toContain('analytics.query');
      expect(guidance).toContain('filterLists');
      expect(guidance).not.toContain('Do not call insights.quick_wins');
      expect(guidance).toContain('not separately measured');
      await expect(prompt.handler({ ...parsed.data!, country: 'DEU' }))
        .rejects.toThrow('Supply either country or countries');
      await expect(prompt.handler({ ...parsed.data!, device: 'mobile' }))
        .rejects.toThrow('Supply either device or devices');
      await expect(prompt.handler({ ...parsed.data!, countries: ['DEU', 'DEU'] }))
        .rejects.toThrow('Country list cannot contain duplicates');
      expect((await prompt.argsSchema.safeParseAsync({
        site_url: 'sc-domain:example.com',
        start_date: '2026-10-01', end_date: '2026-10-28',
        countries: 'DEU,USA,FRA,GBR,ESP,ITA,NLD,CAN,AUS,JPN,SWE',
      })).success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('guides a scoped query/page overlap review without asserting cannibalization or making provider calls', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
    );
    const prompts = (server as unknown as {
      _registeredPrompts: Record<string, {
        handler: (args: Record<string, string>) => Promise<{
          messages: Array<{ content: { type: string; text: string } }>;
        }>;
      }>;
    })._registeredPrompts;
    expect(prompts['gsc-query-overlap-review']).toBeDefined();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const response = await prompts['gsc-query-overlap-review'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-10-01',
        end_date: '2026-10-28',
        search_type: 'web',
        query_contains: 'technical seo',
        page_contains: '/de/',
        country: 'DEU',
        device: 'mobile',
      });
      const guidance = response.messages[0].content.text;
      for (const expected of ['sc-domain:example.com', '2026-10-01', '2026-10-28',
        'technical seo', '/de/', 'DEU', 'mobile', 'insights.cannibalization',
        'insights.query_pages']) {
        expect(guidance).toContain(expected);
      }
      expect(guidance).toContain('not proof');
      expect(guidance).toContain('not property-wide');
      expect(guidance).toContain('Never request indexing');
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(prompts['gsc-query-overlap-review'].handler({
        site_url: 'sc-domain:example.com', start_date: '2026-10-28', end_date: '2026-10-01',
      })).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('exposes the registered read-only prompt catalog through capabilities without provider calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const mode of ['readonly', 'readwrite'] as const) {
        const server = await createGscMcpServer(
          { GSC_ACCESS_MODE: mode } as unknown as Env,
        );
        const internals = server as unknown as {
          _registeredPrompts: Record<string, unknown>;
          _registeredTools: Record<string, {
            handler: (args: Record<string, never>) => Promise<{
              structuredContent: {
                prompts: Array<{ name: string; description: string }>;
                prompts_note: string;
              };
            }>;
          }>;
        };
        const capabilities = await internals._registeredTools['server.capabilities'].handler({});
        const catalog = capabilities.structuredContent.prompts;
        expect(catalog.map((prompt) => prompt.name).sort()).toEqual(
          Object.keys(internals._registeredPrompts).sort(),
        );
        expect(new Set(catalog.map((prompt) => prompt.name)).size).toBe(catalog.length);
        expect(catalog.every((prompt) => prompt.description.trim().length > 10)).toBe(true);
        expect(capabilities.structuredContent.prompts_note).toContain('prompts/list');
        expect(capabilities.structuredContent.prompts_note).toContain('client');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('advertises the existing low-CTR quick-wins filter in capabilities', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
      { google_id: 'catalog-user', email: 'catalog@example.test' },
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, never>) => Promise<{
          structuredContent: { tools: Array<{ name: string; description: string }> };
        }>;
      }>;
    })._registeredTools;
    const capabilities = await registered['server.capabilities'].handler({});
    const quickWins = capabilities.structuredContent.tools.find(
      (tool) => tool.name === 'insights.quick_wins',
    );
    expect(quickWins?.description).toContain('max_ctr');
    expect(quickWins?.description).toContain('after Google pagination');
  });

  it('advertises observed analytics comparison ranking and direction filters in capabilities', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
      { google_id: 'catalog-user', email: 'catalog@example.test' },
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, never>) => Promise<{
          structuredContent: { tools: Array<{ name: string; description: string }> };
        }>;
      }>;
    })._registeredTools;
    const capabilities = await registered['server.capabilities'].handler({});
    const comparison = capabilities.structuredContent.tools.find(
      (tool) => tool.name === 'analytics.compare',
    );
    expect(comparison?.description).toContain('sort_by');
    expect(comparison?.description).toContain('ctr_change_direction');
    expect(comparison?.description).toContain('position_change_direction');
    expect(comparison?.description).toContain('min_impressions_per_period');
    expect(comparison?.description).toContain('min_baseline_clicks');
    expect(comparison?.description).toContain('min_absolute_click_change');
    expect(comparison?.description).toContain('before pagination');
    expect(comparison?.description).toContain('Discover');
  });

  it('advertises historical and high-signal content-decay inspection in capabilities', async () => {
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly' } as unknown as Env,
      { google_id: 'catalog-user', email: 'catalog@example.test' },
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, never>) => Promise<{
          structuredContent: { tools: Array<{ name: string; description: string }> };
        }>;
      }>;
    })._registeredTools;
    const capabilities = await registered['server.capabilities'].handler({});
    const decay = capabilities.structuredContent.tools.find(
      (tool) => tool.name === 'insights.content_decay',
    );
    expect(decay?.description).toContain('end_date');
    expect(decay?.description).toContain('classification_filter');
    expect(decay?.description).toContain('min_click_loss');
    expect(decay?.description).toContain('before pagination');
    expect(decay?.description).toContain('not property-wide');
  });

  it('denies all four property/sitemap metadata reads before requesting Google credentials', async () => {
    const take = vi.fn(async (_bucket: string, _policy: { category: string }, _units: number) => (
      { allowed: false, retry_after_ms: 30_000 }
    ));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const getAccessToken = vi.fn(async () => {
      throw new Error('Denied requests must not reach credential refresh');
    });
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'metadata-budget-user', email: 'metadata@example.test' },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, string>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
      }>;
    })._registeredTools;
    const requests = [
      ['sites.list', {}],
      ['sites.get', { site_url: 'sc-domain:example.com' }],
      ['sitemaps.list', { site_url: 'sc-domain:example.com' }],
      ['sitemaps.get', { site_url: 'sc-domain:example.com', feedpath: 'https://example.com/sitemap.xml' }],
    ] as const;

    for (const [name, args] of requests) {
      const result = await tools[name].handler(args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(`Rate limit reached for ${name}`);
    }
    expect(take).toHaveBeenCalledTimes(4);
    expect(take.mock.calls.every((call) => call[1]?.category === 'search-console-metadata-read')).toBe(true);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('charges indexing write ownership checks to the shared metadata budget', async () => {
    const take = vi.fn(async (_bucket: string, policy: { category: string }) => ({
      allowed: policy.category !== 'search-console-metadata-read',
      retry_after_ms: 30_000,
    }));
    const getAccessToken = vi.fn(async () => {
      throw new Error('Denied metadata reads must not request Google credentials');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readwrite',
        TOOL_RATE_LIMITER: {
          idFromName: (name: string) => name,
          get: () => ({ take }),
        },
      } as unknown as Env,
      { google_id: 'indexing-owner-budget-user', email: 'indexing-owner@example.test' },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: { site_url: string; url: string }) => Promise<{
          isError?: boolean;
          content?: Array<{ text?: string }>;
        }>;
      }>;
    })._registeredTools;

    for (const name of ['indexing.request', 'indexing.remove']) {
      const result = await tools[name].handler({
        site_url: 'sc-domain:example.com',
        url: 'https://example.com/careers/engineer',
      });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain('Rate limit reached for sites.list');
    }
    expect(take.mock.calls.map((call) => call[1].category)).toEqual([
      'indexing-request',
      'search-console-metadata-read',
      'indexing-request',
      'search-console-metadata-read',
    ]);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('stops indexing write ownership retries when the metadata budget is exhausted', async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const name of ['indexing.request', 'indexing.remove']) {
        let metadataReservations = 0;
        const take = vi.fn(async (_bucket: string, policy: { category: string }) => {
          if (policy.category === 'search-console-metadata-read') {
            metadataReservations += 1;
            return { allowed: metadataReservations === 1, retry_after_ms: 30_000 };
          }
          return { allowed: true };
        });
        const server = await createGscMcpServer(
          {
            GSC_ACCESS_MODE: 'readwrite',
            TOOL_RATE_LIMITER: {
              idFromName: (key: string) => key,
              get: () => ({ take }),
            },
          } as unknown as Env,
          { google_id: `indexing-retry-${name}`, email: 'indexing-retry@example.test' },
          { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
        );
        const handler = (server as unknown as {
          _registeredTools: Record<string, {
            handler: (args: { site_url: string; url: string }) => Promise<unknown>;
          }>;
        })._registeredTools[name].handler;
        const outboundUrls: string[] = [];
        globalThis.fetch = async (input: RequestInfo | URL) => {
          const url = requestUrl(input);
          outboundUrls.push(url);
          if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
            return new Response('transient', {
              status: 503,
              headers: { 'retry-after': '0' },
            });
          }
          throw new Error(`Unexpected outbound request: ${url}`);
        };

        await expect(handler({
          site_url: 'sc-domain:example.com',
          url: 'https://example.com/careers/engineer',
        })).rejects.toThrow('Search Console metadata retry budget exhausted');
        expect(outboundUrls).toEqual(['https://www.googleapis.com/webmasters/v3/sites']);
        expect(take.mock.calls.map((call) => call[1].category)).toEqual([
          'indexing-request',
          'search-console-metadata-read',
          'search-console-metadata-read',
        ]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('charges a separate Search Analytics budget unit before a retry', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: (name: string) => name, get: () => ({ take }) },
      } as unknown as Env,
      { google_id: 'analytics-retry-user', email: 'analytics-retry@example.test' },
      { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['analytics.query'].handler;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async () => {
        requests += 1;
        if (requests === 1) {
          return new Response('transient', { status: 503, headers: { 'retry-after': '0' } });
        }
        return response({ rows: [] });
      };
      await handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        dimensions: ['query'],
        row_limit: 5,
        start_row: 0,
        search_type: 'web',
        data_state: 'final',
      });
      expect(requests).toBe(2);
      expect(take).toHaveBeenCalledTimes(2);
      expect(take.mock.calls.map((call) => [call[1].category, call[2]])).toEqual([
        ['search-analytics', 1], ['search-analytics', 1],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('pages and sorts property lists without breaking the legacy text array', async () => {
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: {
          idFromName: (name: string) => name,
          get: () => ({ take: async () => ({ allowed: true }) }),
        },
      } as unknown as Env,
      { google_id: 'many-properties-user', email: 'many@example.test' },
      { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<{
          content: Array<{ text: string }>;
          structuredContent: {
            sites: Array<{ siteUrl: string }>;
            result_page: { has_more: boolean; next_start_row?: number; total_count: number };
          };
        }>;
      }>;
    })._registeredTools['sites.list'].handler;
    const originalFetch = globalThis.fetch;
    const properties = Array.from({ length: 145 }, (_, i) => ({
      siteUrl: `sc-domain:site-${String(144 - i).padStart(3, '0')}.example`,
      permissionLevel: 'siteOwner',
    }));
    try {
      globalThis.fetch = async () => response({ siteEntry: properties });
      const first = await handler({ limit: 50 });
      const second = await handler({ start_row: 50, limit: 50 });
      const last = await handler({ start_row: 100, limit: 50 });
      expect(first.structuredContent.sites).toHaveLength(50);
      expect(second.structuredContent.sites).toHaveLength(50);
      expect(last.structuredContent.sites).toHaveLength(45);
      expect(last.structuredContent.result_page.has_more).toBe(false);
      expect(first.structuredContent.result_page).toMatchObject({
        has_more: true, next_start_row: 50, total_count: 145,
      });
      expect(first.structuredContent.sites[0].siteUrl).toBe('sc-domain:site-000.example');
      expect(second.structuredContent.sites[0].siteUrl).toBe('sc-domain:site-050.example');
      expect(JSON.parse(first.content[0].text)).toEqual(first.structuredContent.sites);
      expect(JSON.parse(first.content[1].text)).toEqual({
        result_page: first.structuredContent.result_page,
      });
      const largeProperties = Array.from({ length: 90 }, (_, i) => ({
        siteUrl: `sc-domain:site-${String(i).padStart(3, '0')}-${'x'.repeat(1100)}.example`,
        permissionLevel: 'siteOwner',
      }));
      globalThis.fetch = async () => response({ siteEntry: largeProperties });
      const bounded = await handler({ limit: 90 });
      expect(bounded.structuredContent.result_page.has_more).toBe(true);
      expect(bounded.structuredContent.result_page.next_start_row).toBeGreaterThan(0);
      expect(new TextEncoder().encode(bounded.content[0].text).byteLength).toBeLessThan(48_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds sitemap list payload bytes and supports deterministic continuation', async () => {
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: {
          idFromName: (name: string) => name,
          get: () => ({ take: async () => ({ allowed: true }) }),
        },
      } as unknown as Env,
      { google_id: 'many-sitemaps-user', email: 'sitemaps@example.test' },
      { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<{
          isError?: boolean;
          content: Array<{ text: string }>;
          structuredContent: {
            sitemaps: Array<{ path: string }>;
            result_page: {
              has_more: boolean; byte_limit_reached: boolean;
              next_start_row?: number; total_count: number;
            };
          };
        }>;
      }>;
    })._registeredTools['sitemaps.list'].handler;
    const originalFetch = globalThis.fetch;
    const sitemaps = Array.from({ length: 90 }, (_, i) => ({
      path: `https://example.com/${String(89 - i).padStart(3, '0')}/${'x'.repeat(1200)}.xml`,
      errors: '0',
    }));
    try {
      globalThis.fetch = async () => response({ sitemap: sitemaps });
      const first = await handler({ site_url: 'sc-domain:example.com', limit: 90 });
      const page = first.structuredContent.result_page;
      expect(first.isError).not.toBe(true);
      expect(page.has_more).toBe(true);
      expect(page.byte_limit_reached).toBe(true);
      expect(page.next_start_row).toBe(first.structuredContent.sitemaps.length);
      expect(first.structuredContent.sitemaps[0].path).toContain('/000/');
      expect(new TextEncoder().encode(first.content[0].text).byteLength).toBeLessThan(48_000);
      const next = await handler({
        site_url: 'sc-domain:example.com', limit: 90, start_row: page.next_start_row,
      });
      expect(next.structuredContent.sitemaps[0].path).toContain(
        `/${String(page.next_start_row).padStart(3, '0')}/`,
      );
      expect(next.structuredContent.result_page.total_count).toBe(90);
      globalThis.fetch = async () => response({
        sitemap: [{ path: `https://example.com/${'x'.repeat(55_000)}.xml` }],
      });
      const oversize = await handler({ site_url: 'sc-domain:example.com' });
      expect(oversize.isError).toBe(true);
      expect(oversize.content[0].text).toContain('exceeds the response byte limit');
      globalThis.fetch = async () => response({ sitemap: [] });
      const empty = await handler({ site_url: 'sc-domain:example.com' });
      expect(empty.structuredContent.sitemaps).toHaveLength(0);
      expect(empty.structuredContent.result_page).toMatchObject({
        has_more: false, total_count: 0, byte_limit_reached: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not send a Search Analytics retry when the additional unit is denied', async () => {
    const take = vi.fn(async () => (
      take.mock.calls.length === 1
        ? { allowed: true }
        : { allowed: false, retry_after_ms: 2_000 }
    ));
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: (name: string) => name, get: () => ({ take }) },
      } as unknown as Env,
      { google_id: 'analytics-denied-user', email: 'analytics-denied@example.test' },
      { getAccessToken: async () => 'access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['analytics.query'].handler;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async () => {
        requests += 1;
        return new Response('retryable', { status: 429, headers: { 'retry-after': '0' } });
      };
      await expect(handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        dimensions: ['query'],
        row_limit: 5,
        start_row: 0,
        search_type: 'web',
        data_state: 'final',
      })).rejects.toThrow(/Search Analytics retry budget exhausted/);
      expect(requests).toBe(1);
      expect(take).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the root discovery response deployment-neutral', async () => {
    const result = await defaultHandler.fetch(
      new Request('http://127.0.0.1:8080/'),
      workerEnv,
    );

    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('text/plain');
    await expect(result.text()).resolves.toBe(
      'mcp-gsc — Google Search Console MCP server.\n' +
        'MCP endpoint: http://127.0.0.1:8080/mcp\n' +
        'Setup: https://github.com/AKzar1el/mcp-gsc#readme\n',
    );
  });

  it('uses configured KV and Durable Object bindings to consume OAuth state once', async () => {
    expect(workerEnv.OAUTH_KV).toBeDefined();
    expect(workerEnv.USER_KV).toBeDefined();
    expect(workerEnv.PENDING_AUTH_STATE).toBeDefined();
    expect(workerEnv.MCP_OBJECT).toBeDefined();

    const nonce = 'concurrent-state';
    const request = { client_id: 'mcp-client', scope: 'openid' };
    const stub = workerEnv.PENDING_AUTH_STATE.get(
      workerEnv.PENDING_AUTH_STATE.idFromName(nonce),
    );
    await runInDurableObject(stub, (instance: PendingAuthState) =>
      instance.store(request),
    );

    const consumed = await Promise.all([
      runInDurableObject(stub, (instance: PendingAuthState) =>
        instance.consume(),
      ),
      runInDurableObject(stub, (instance: PendingAuthState) =>
        instance.consume(),
      ),
    ]);

    expect(consumed.filter((value) => value !== null)).toHaveLength(1);
    expect(consumed.find((value) => value !== null)?.claudeAuthRequest).toEqual(
      request,
    );
    expect(
      await runInDurableObject(stub, (instance: PendingAuthState) =>
        instance.consume(),
      ),
    ).toBeNull();
  });

  it('persists the OAuth callback credential through Worker KV and rejects a reused state', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === GOOGLE_TOKEN_URL) {
        return response({
          access_token: 'callback-access-token',
          refresh_token: 'callback-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email',
        });
      }
      if (url === GOOGLE_USERINFO_URL) {
        return response({ id: 'callback-user', email: 'user@example.test' });
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    };

    const completed: unknown[] = [];
    const oauthProvider = {
      parseAuthRequest: async () => ({
        responseType: 'code',
        clientId: 'mcp-client',
        redirectUri: 'https://client.example/callback',
        scope: ['openid'],
        state: 'client-state',
        issuer: 'https://worker.example',
      }),
      lookupClient: async () => ({
        clientId: 'mcp-client',
        clientName: 'Test MCP client',
        redirectUris: ['https://client.example/callback'],
      }),
      completeAuthorization: async (authorization: unknown) => {
        completed.push(authorization);
        return { redirectTo: 'https://client.example/callback?code=issued' };
      },
    };
    const oauthEnv = {
      ...workerEnv,
      OAUTH_PROVIDER: oauthProvider,
      PENDING_AUTH_STATE: createPendingStateBinding(),
    } as Env;

    try {
      const authorize = await defaultHandler.fetch(
        new Request('https://worker.example/authorize'),
        oauthEnv,
      );
      expect(authorize.status).toBe(200);
      const consentHtml = await authorize.text();
      const consentNonce = consentHtml.match(
        /name="consent_nonce" value="([^"]+)"/,
      )?.[1];
      expect(consentNonce).toBeTruthy();
      const consentCookie = authorize.headers.get('set-cookie')?.split(';', 1)[0];
      expect(consentCookie).toBeTruthy();
      expect(authorize.headers.get('set-cookie')).toContain('__Host-MCP_GSC_CONSENT=');
      expect(authorize.headers.get('set-cookie')).toContain('Secure');

      const approved = await defaultHandler.fetch(
        new Request('https://worker.example/authorize', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: consentCookie!,
          },
          body: new URLSearchParams({
            consent_nonce: consentNonce!,
            decision: 'allow',
          }),
        }),
        oauthEnv,
      );
      expect(approved.status).toBe(302);

      const state = new URL(approved.headers.get('location')!).searchParams.get(
        'state',
      );
      expect(state).toBeTruthy();

      const callback = await defaultHandler.fetch(
        new Request(
          `https://worker.example/google/callback?code=google-code&state=${state}`,
        ),
        oauthEnv,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe(
        'https://client.example/callback?code=issued',
      );
      expect(completed).toHaveLength(1);
      expect(await getDecryptedRefreshToken(workerEnv, 'callback-user')).toBe(
        'callback-refresh-token',
      );

      const reused = await defaultHandler.fetch(
        new Request(
          `https://worker.example/google/callback?code=google-code&state=${state}`,
        ),
        oauthEnv,
      );
      expect(reused.status).toBe(400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('registers the MCP tool catalog on a stateless server and applies write annotations', async () => {
    const server = await createGscMcpServer(workerEnv, {
      google_id: 'tool-user',
      email: 'tool@example.test',
    });
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { annotations?: Record<string, boolean>; inputSchema?: unknown }
      >;
    })._registeredTools;

    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        'analytics.query',
        'insights.page_queries',
        'insights.query_pages',
        'reports.weekly_digest',
        'sites.add',
        'sites.delete',
        'sitemaps.submit',
        'sitemaps.delete',
        'indexing.status',
        'indexing.request',
        'indexing.remove',
      ]),
    );
    expect(tools['analytics.query'].inputSchema).toBeDefined();
    expect(tools['insights.page_queries'].inputSchema).toBeDefined();
    expect(tools['insights.query_pages'].inputSchema).toBeDefined();
    const analyticsQuerySchema = tools['analytics.query'].inputSchema as {
      safeParse: (value: unknown) => {
        success: boolean;
        data?: {
          data_state?: string;
          dimension_filter_groups?: Array<{
            groupType: string;
            filters: Array<{ operator: string; expression: string }>;
          }>;
        };
      };
    };
    const analyticsCompareSchema = tools['analytics.compare']
      .inputSchema as typeof analyticsQuerySchema;
    const compareDefaults = analyticsCompareSchema.safeParse({
      site_url: 'sc-domain:example.com',
      start_date_a: '2026-09-01',
      end_date_a: '2026-09-07',
      start_date_b: '2026-08-25',
      end_date_b: '2026-08-31',
    });
    expect(compareDefaults.success).toBe(true);
    expect(compareDefaults.data?.data_state).toBe('final');
    for (const sort_by of ['absolute_impression_change', 'absolute_daily_impression_change']) {
      expect(analyticsCompareSchema.safeParse({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01',
        end_date_a: '2026-09-07',
        start_date_b: '2026-08-25',
        end_date_b: '2026-08-31',
        sort_by,
      }).success).toBe(true);
    }
    expect(
      analyticsCompareSchema.safeParse({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01',
        end_date_a: '2026-09-07',
        start_date_b: '2026-08-25',
        end_date_b: '2026-08-31',
        data_state: 'hourly_all',
      }).success,
    ).toBe(false);
    const requiredAnalyticsQueryInput = {
      site_url: 'sc-domain:example.com',
      start_date: '2026-09-01',
      end_date: '2026-09-07',
    };
    expect(
      analyticsQuerySchema.safeParse({
        ...requiredAnalyticsQueryInput,
        dimensions: ['query', 'query'],
      }).success,
    ).toBe(false);
    expect(
      analyticsQuerySchema.safeParse({
        ...requiredAnalyticsQueryInput,
        dimensions: ['searchAppearance', 'page'],
      }).success,
    ).toBe(false);
    const filterInput = {
      dimension_filter_groups: [
        {
          filters: [{ dimension: 'country', expression: 'usa' }],
        },
      ],
    };
    for (const [schema, requiredInput] of [
      [
        analyticsQuerySchema,
        {
          site_url: 'sc-domain:example.com',
          start_date: '2026-09-01',
          end_date: '2026-09-07',
        },
      ],
      [
        analyticsCompareSchema,
        {
          site_url: 'sc-domain:example.com',
          start_date_a: '2026-09-01',
          end_date_a: '2026-09-07',
          start_date_b: '2026-08-25',
          end_date_b: '2026-08-31',
        },
      ],
    ] as const) {
      const parsed = schema.safeParse({ ...requiredInput, ...filterInput });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.dimension_filter_groups?.[0]).toEqual({
        groupType: 'and',
        filters: [
          {
            dimension: 'country',
            operator: 'equals',
            expression: 'usa',
          },
        ],
      });
      expect(
        schema.safeParse({
          ...requiredInput,
          dimension_filter_groups: [
            {
              filters: [
                {
                  dimension: 'country',
                  expression: 'x'.repeat(4097),
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...requiredInput,
          dimension_filter_groups: [
            {
              filters: [
                {
                  dimension: 'country',
                  operator: 'equals',
                  expression: 'us',
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...requiredInput,
          dimension_filter_groups: [
            {
              filters: [
                {
                  dimension: 'device',
                  operator: 'equals',
                  expression: 'PHONE',
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...requiredInput,
          dimension_filter_groups: [
            {
              filters: [
                {
                  dimension: 'device',
                  operator: 'includingRegex',
                  expression: 'MOB.*',
                },
              ],
            },
          ],
        }).success,
      ).toBe(true);
    }
    expect(tools['sites.add'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tools['sitemaps.submit'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tools['sites.delete'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(tools['indexing.request'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(tools['indexing.remove'].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(tools['indexing.status'].annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it('rejects incompatible Search Analytics requests before budget or credential work', async () => {
    const limiterIdFromName = vi.fn(() => {
      throw new Error('rate limiter should not run');
    });
    const getAccessToken = vi.fn(async () => {
      throw new Error('access-token lifecycle should not run');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readwrite',
        TOOL_RATE_LIMITER: { idFromName: limiterIdFromName },
      } as unknown as Env,
      {
        google_id: 'analytics-preflight-user',
        email: 'analytics-preflight@example.test',
      },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const analyticsQuery = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (input: {
            site_url: string;
            start_date: string;
            end_date: string;
            dimensions: ['hour'];
            row_limit: number;
            start_row: number;
            data_state: 'all';
            search_type: 'web';
            aggregation_type: 'auto';
          }) => Promise<unknown>;
        }
      >;
    })._registeredTools['analytics.query'];

    await expect(
      analyticsQuery.handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        dimensions: ['hour'],
        row_limit: 100,
        start_row: 0,
        data_state: 'all',
        search_type: 'web',
        aggregation_type: 'auto',
      }),
    ).rejects.toThrow('Search Analytics hour dimension requires dataState hourly_all.');
    expect(limiterIdFromName).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('rejects future Search Analytics ranges before budget or credential work', async () => {
    const limiterIdFromName = vi.fn(() => {
      throw new Error('rate limiter should not run');
    });
    const getAccessToken = vi.fn(async () => {
      throw new Error('access-token lifecycle should not run');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: limiterIdFromName },
      } as unknown as Env,
      {
        google_id: 'analytics-future-date-user',
        email: 'analytics-future-date@example.test',
      },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const analyticsQuery = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (input: {
            site_url: string;
            start_date: string;
            end_date: string;
            dimensions: ['query'];
            row_limit: number;
            start_row: number;
            data_state: 'all';
            search_type: 'web';
            aggregation_type: 'auto';
          }) => Promise<unknown>;
        }
      >;
    })._registeredTools['analytics.query'];

    await expect(
      analyticsQuery.handler({
        site_url: 'sc-domain:example.com',
        start_date: '2999-01-01',
        end_date: '2999-01-02',
        dimensions: ['query'],
        row_limit: 100,
        start_row: 0,
        data_state: 'all',
        search_type: 'web',
        aggregation_type: 'auto',
      }),
    ).rejects.toThrow('end_date must be today or earlier');
    expect(limiterIdFromName).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('rejects page-query URLs outside site_url before budget or credential work', async () => {
    const limiterIdFromName = vi.fn(() => {
      throw new Error('rate limiter should not run');
    });
    const getAccessToken = vi.fn(async () => {
      throw new Error('access-token lifecycle should not run');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: limiterIdFromName },
      } as unknown as Env,
      {
        google_id: 'page-query-preflight-user',
        email: 'page-query-preflight@example.test',
      },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const pageQueries = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (input: {
            site_url: string;
            page_url: string;
            start_date: string;
            end_date: string;
            search_type: 'web';
          }) => Promise<unknown>;
        }
      >;
    })._registeredTools['insights.page_queries'];

    await expect(
      pageQueries.handler({
        site_url: 'https://example.com/docs/',
        page_url: 'https://example.com/blog/outside-prefix/',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        search_type: 'web',
      }),
    ).rejects.toThrow(
      'page_url must belong to the site_url Search Console property.',
    );
    expect(limiterIdFromName).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('rejects Indexing API URLs outside site_url before budget or credential work', async () => {
    const limiterIdFromName = vi.fn(() => {
      throw new Error('rate limiter should not run');
    });
    const getAccessToken = vi.fn(async () => {
      throw new Error('access-token lifecycle should not run');
    });
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readwrite',
        TOOL_RATE_LIMITER: { idFromName: limiterIdFromName },
      } as unknown as Env,
      {
        google_id: 'indexing-preflight-user',
        email: 'indexing-preflight@example.test',
      },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (input: { site_url: string; url: string }) => Promise<unknown>;
        }
      >;
    })._registeredTools;

    for (const toolName of ['indexing.status', 'indexing.request', 'indexing.remove']) {
      await expect(
        tools[toolName].handler({
          site_url: 'sc-domain:example.com',
          url: 'https://outside.example.net/job',
        }),
      ).rejects.toThrow('url must belong to the site_url Search Console property.');
    }
    expect(limiterIdFromName).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('rejects duplicate urls.inspect_many inputs before provider work', async () => {
    const originalFetch = globalThis.fetch;
    let outboundRequests = 0;
    globalThis.fetch = async () => {
      outboundRequests += 1;
      throw new Error('Duplicate inspection input must not reach a provider request.');
    };

    try {
      const result = await mcpApiHandler.fetch(
        new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 81,
            method: 'tools/call',
            params: {
              name: 'urls.inspect_many',
              arguments: {
                site_url: 'sc-domain:example.com',
                inspection_urls: [
                  'https://example.com/page',
                  'https://example.com/page',
                ],
              },
            },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'duplicate-inspection-user',
            email: 'duplicate-inspection@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const serialized = JSON.stringify(await readMcpJsonRpc(result));
      expect(serialized).toContain('inspection_urls must not contain duplicate URLs');
      expect(outboundRequests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('charges URL Inspection retries separately from first attempts', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'inspection-retry-user', email: 'inspection-retry@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect'].handler;
    const originalFetch = globalThis.fetch;
    const attempts = new Map<string, number>();

    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const inspectionUrl = (JSON.parse(String(init?.body)) as { inspectionUrl: string }).inspectionUrl;
        const count = (attempts.get(inspectionUrl) ?? 0) + 1;
        attempts.set(inspectionUrl, count);
        if (inspectionUrl.endsWith('/retry') && count === 1) {
          return new Response('temporarily unavailable', {
            status: 503,
            headers: { 'retry-after': '0' },
          });
        }
        return response({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
      };

      for (const inspectionUrl of ['https://example.com/stable', 'https://example.com/retry']) {
        await handler({ site_url: 'sc-domain:example.com', inspection_url: inspectionUrl });
      }
      expect(attempts.get('https://example.com/stable')).toBe(1);
      expect(attempts.get('https://example.com/retry')).toBe(2);
      expect(take).toHaveBeenCalledTimes(3);
      expect(take.mock.calls.map((call) => call[2])).toEqual([1, 1, 1]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stops URL Inspection before a retry when the daily budget is exhausted', async () => {
    let reservations = 0;
    const take = vi.fn(async () => (
      ++reservations === 1 ? { allowed: true } : { allowed: false, retry_after_ms: 5_000 }
    ));
    const limiter = {
      idFromName: (name: string) => name,
      get: () => ({ take }),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'inspection-denied-user', email: 'inspection-denied@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect'].handler;
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;

    try {
      globalThis.fetch = async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? new Response('try again', { status: 429, headers: { 'retry-after': '0' } })
          : response({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
      };

      await expect(handler({
        site_url: 'sc-domain:example.com',
        inspection_url: 'https://example.com/denied',
      })).rejects.toThrow(/URL Inspection retry budget exhausted/);
      expect(providerCalls).toBe(1);
      expect(take).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accounts for concurrent batch retries and returns per-URL budget failures', async () => {
    let usedUnits = 0;
    const take = vi.fn(async (_bucket: string, _policy: unknown, units: number) => {
      if (usedUnits + units > 3) return { allowed: false, retry_after_ms: 5_000 };
      usedUnits += units;
      return { allowed: true };
    });
    const limiter = {
      idFromName: (name: string) => name,
      get: () => ({ take }),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'inspection-batch-retry-user', email: 'inspection-batch@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect_many'].handler;
    const originalFetch = globalThis.fetch;
    const attempts = new Map<string, number>();

    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const inspectionUrl = (JSON.parse(String(init?.body)) as { inspectionUrl: string }).inspectionUrl;
        const count = (attempts.get(inspectionUrl) ?? 0) + 1;
        attempts.set(inspectionUrl, count);
        return count === 1
          ? new Response('transient', { status: 503, headers: { 'retry-after': '0' } })
          : response({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
      };

      const result = await handler({
        site_url: 'sc-domain:example.com',
        inspection_urls: ['https://example.com/a', 'https://example.com/b'],
      }) as {
        structuredContent: {
          requested_count: number;
          succeeded_count: number;
          failed_count: number;
          results: Array<{ error?: string }>;
        };
      };
      expect(result.structuredContent.requested_count).toBe(2);
      expect(result.structuredContent.succeeded_count).toBe(1);
      expect(result.structuredContent.failed_count).toBe(1);
      expect(result.structuredContent.results.filter((entry) => entry.error)).toEqual([
        expect.objectContaining({ error: expect.stringContaining('URL Inspection retry budget exhausted') }),
      ]);
      expect(Array.from(attempts.values()).sort()).toEqual([1, 2]);
      expect(take.mock.calls.map((call) => call[2])).toEqual([2, 1, 1]);
      expect(usedUnits).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds oversized single URL Inspection results without losing indexed state', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'single-inspection-bound-user', email: 'single-inspection@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect'].handler;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => response({
        inspectionResult: {
          indexStatusResult: { verdict: 'PASS', coverageState: 'large-status-'.repeat(5_000) },
          richResultsResult: { details: 'x'.repeat(65_000) },
        },
      });

      const result = await handler({
        site_url: 'sc-domain:example.com',
        inspection_url: 'https://example.com/large',
      }) as {
        content: Array<{ text: string }>;
        structuredContent: {
          inspection_result?: unknown;
          inspection_result_omitted?: boolean;
          summary_fields_omitted?: boolean;
          index_status_summary: { indexed_state: string };
          note: string;
        };
      };

      expect(result.structuredContent.index_status_summary.indexed_state).toBe('indexed');
      expect(result.structuredContent.inspection_result).toBeUndefined();
      expect(result.structuredContent.inspection_result_omitted).toBe(true);
      expect(result.structuredContent.summary_fields_omitted).toBe(true);
      expect(result.structuredContent.note).toContain('does not run a live URL test');
      expect(new TextEncoder().encode(JSON.stringify(result.structuredContent)).byteLength).toBeLessThanOrEqual(48_000);
      expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThanOrEqual(48_000);
      expect(take).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds large URL Inspection batches while preserving every URL status', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'inspection-output-user', email: 'inspection-output@example.test' },
      { getAccessToken: async () => 'test-access-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['urls.inspect_many'].handler;
    const originalFetch = globalThis.fetch;
    const inspectionUrls = [
      'https://example.com/huge-a',
      'https://example.com/small',
      'https://example.com/failed',
      'https://example.com/huge-b',
      'https://example.com/huge-c',
    ];
    let providerCalls = 0;

    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerCalls += 1;
        const inspectionUrl = (JSON.parse(String(init?.body)) as { inspectionUrl: string }).inspectionUrl;
        if (inspectionUrl.endsWith('/failed')) return new Response('not found', { status: 404 });
        return response({
          inspectionResult: {
            indexStatusResult: {
              verdict: inspectionUrl.endsWith('/huge-b')
                ? 'NEUTRAL'
                : inspectionUrl.endsWith('/huge-c') ? 'PARTIAL' : 'PASS',
              coverageState: inspectionUrl.endsWith('/huge-a')
                ? 'oversized-status-'.repeat(5_000)
                : 'Submitted and indexed',
            },
            richResultsResult: {
              details: inspectionUrl.endsWith('/small') ? 'normal' : 'x'.repeat(65_000),
            },
          },
        });
      };

      const result = await handler({
        site_url: 'sc-domain:example.com',
        inspection_urls: inspectionUrls,
      }) as {
        content: Array<{ text: string }>;
        structuredContent: {
          requested_count: number;
          succeeded_count: number;
          failed_count: number;
          index_status_counts: { indexed: number; not_indexed: number; unknown: number };
          raw_results_omitted_count: number;
          results: Array<{
            inspection_url: string;
            inspection_result?: unknown;
            index_status_summary?: { indexed_state: string };
            inspection_result_omitted?: boolean;
            error?: string;
          }>;
        };
      };

      const payload = result.structuredContent;
      expect(providerCalls).toBe(inspectionUrls.length);
      expect(payload.requested_count).toBe(5);
      expect(payload.succeeded_count).toBe(4);
      expect(payload.failed_count).toBe(1);
      expect(payload.index_status_counts).toEqual({ indexed: 2, not_indexed: 1, unknown: 1 });
      expect(payload.results.map((entry) => entry.inspection_url)).toEqual(inspectionUrls);
      expect(payload.results.filter((entry) => entry.index_status_summary?.indexed_state === 'indexed')).toHaveLength(2);
      expect(payload.results.filter((entry) => entry.index_status_summary?.indexed_state === 'not_indexed')).toHaveLength(1);
      expect(payload.results.filter((entry) => entry.index_status_summary?.indexed_state === 'unknown')).toHaveLength(1);
      expect(JSON.parse(result.content[0].text).index_status_counts).toEqual(payload.index_status_counts);
      expect(payload.results[2].error).toContain('404');
      expect(payload.results[1].inspection_result).toBeDefined();
      expect(payload.raw_results_omitted_count).toBe(3);
      expect(payload.results.filter((entry) => entry.inspection_result_omitted)).toHaveLength(3);
      expect(payload.results[0]).toMatchObject({ summary_fields_omitted: true });
      expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(48_000);
      expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThanOrEqual(48_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns a schema-discoverable URL Inspection index-status summary alongside the raw provider result', async () => {
    await saveUser(
      workerEnv,
      'inspection-summary-user',
      'inspection-summary@example.test',
      'inspection-summary-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'inspection-summary-user',
        email: 'inspection-summary@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'inspection-summary-access-token', expires_in: 3600 });
        }
        if (url === 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect') {
          return response({
            inspectionResult: {
              indexStatusResult: {
                verdict: 'PASS',
                coverageState: 'Submitted and indexed',
                robotsTxtState: 'ALLOWED',
                indexingState: 'INDEXING_ALLOWED',
                pageFetchState: 'SUCCESSFUL',
                googleCanonical: 'https://example.com/page',
              },
              richResultsResult: { verdict: 'PASS' },
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await tools['urls.inspect'].handler({
        site_url: 'sc-domain:example.com',
        inspection_url: 'https://example.com/page',
        language_code: 'en-US',
      }) as {
        structuredContent: {
          inspection_result: Record<string, unknown>;
          index_status_summary: Record<string, unknown>;
          note: string;
        };
      };

      expect(result.structuredContent.index_status_summary).toEqual({
        indexed_state: 'indexed',
        verdict: 'PASS',
        coverage_state: 'Submitted and indexed',
        robots_txt_state: 'ALLOWED',
        indexing_state: 'INDEXING_ALLOWED',
        page_fetch_state: 'SUCCESSFUL',
        google_canonical: 'https://example.com/page',
      });
      expect(result.structuredContent.inspection_result).toMatchObject({
        indexStatusResult: { verdict: 'PASS' },
        richResultsResult: { verdict: 'PASS' },
      });
      expect(result.structuredContent.note).toContain('does not run a live URL test');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('adds a Search Console property without implying ownership verification', async () => {
    await saveUser(
      workerEnv,
      'site-add-user',
      'site-add@example.test',
      'site-add-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'site-add-user',
        email: 'site-add@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        requestedUrls.push(url);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'site-add-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com'
        ) {
          expect(init?.method).toBe('PUT');
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await tools['sites.add'].handler({
        site_url: 'sc-domain:example.com',
      }) as {
        structuredContent: {
          message: string;
          ownership_verification_performed: boolean;
          ownership_verification_note: string;
        };
      };

      expect(requestedUrls).toContain(
        'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com',
      );
      expect(result.structuredContent.ownership_verification_performed).toBe(false);
      expect(result.structuredContent.ownership_verification_note).toContain(
        'does not verify ownership',
      );
      expect(result.structuredContent.ownership_verification_note).toContain(
        'separate Google Site Verification/Search Console workflow',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('removes a Search Console property from the connected account without implying website deletion', async () => {
    await saveUser(
      workerEnv,
      'site-delete-user',
      'site-delete@example.test',
      'site-delete-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'site-delete-user',
        email: 'site-delete@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({
            access_token: 'site-delete-access-token',
            expires_in: 3600,
          });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com'
        ) {
          expect(init?.method).toBe('DELETE');
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await tools['sites.delete'].handler({
        site_url: 'sc-domain:example.com',
      }) as {
        structuredContent: {
          message: string;
          removed_from_connected_account_site_set: boolean;
          website_content_deleted: boolean;
          provider_scope_note: string;
        };
      };

      expect(result.structuredContent.message).toContain(
        "removed site property from the connected account's Search Console site set",
      );
      expect(result.structuredContent.removed_from_connected_account_site_set).toBe(true);
      expect(result.structuredContent.website_content_deleted).toBe(false);
      expect(result.structuredContent.provider_scope_note).toContain(
        "removes the property from the connected user's Search Console site set",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps sitemap write receipts scoped to Search Console effects', async () => {
    await saveUser(
      workerEnv,
      'sitemap-write-user',
      'sitemap-write@example.test',
      'sitemap-write-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'sitemap-write-user',
        email: 'sitemap-write@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const sitemapUrl = 'https://example.com/sitemap.xml';
    const sitemapEndpoint =
      'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml';

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({
            access_token: 'sitemap-write-access-token',
            expires_in: 3600,
          });
        }
        if (url === sitemapEndpoint) {
          expect(init?.method === 'PUT' || init?.method === 'DELETE').toBe(true);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const submitResult = await tools['sitemaps.submit'].handler({
        site_url: 'sc-domain:example.com',
        feedpath: sitemapUrl,
      }) as {
        structuredContent: {
          message: string;
          submitted_to_search_console: boolean;
          sitemap_processing_completion_proven: boolean;
          page_indexing_proven: boolean;
          provider_scope_note: string;
        };
      };
      const deleteResult = await tools['sitemaps.delete'].handler({
        site_url: 'sc-domain:example.com',
        feedpath: sitemapUrl,
      }) as {
        structuredContent: {
          message: string;
          removed_from_search_console: boolean;
          sitemap_file_deleted: boolean;
          page_deindexing_proven: boolean;
          provider_scope_note: string;
        };
      };

      expect(submitResult.structuredContent.submitted_to_search_console).toBe(true);
      expect(
        submitResult.structuredContent.sitemap_processing_completion_proven,
      ).toBe(false);
      expect(submitResult.structuredContent.page_indexing_proven).toBe(false);
      expect(submitResult.structuredContent.provider_scope_note).toContain(
        'not completed sitemap processing or page indexing',
      );

      expect(deleteResult.structuredContent.removed_from_search_console).toBe(true);
      expect(deleteResult.structuredContent.sitemap_file_deleted).toBe(false);
      expect(deleteResult.structuredContent.page_deindexing_proven).toBe(false);
      expect(deleteResult.structuredContent.provider_scope_note).toContain(
        'does not delete the remotely hosted sitemap file',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reads Indexing API notification metadata without implying index coverage', async () => {
    await saveUser(
      workerEnv,
      'indexing-status-user',
      'indexing-status@example.test',
      'indexing-status-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'indexing-status-user',
        email: 'indexing-status@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const targetUrl = 'https://example.com/careers/senior-engineer';
    let siteListRequests = 0;

    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({
            access_token: 'indexing-status-access-token',
            expires_in: 3600,
          });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
          siteListRequests += 1;
          return response({
            siteEntry: [
              { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
            ],
          });
        }
        const parsed = new URL(url);
        if (
          `${parsed.origin}${parsed.pathname}` ===
          'https://indexing.googleapis.com/v3/urlNotifications/metadata'
        ) {
          expect(parsed.searchParams.get('url')).toBe(targetUrl);
          return response({
            url: targetUrl,
            latestUpdate: {
              url: targetUrl,
              type: 'URL_UPDATED',
              notifyTime: '2026-09-22T07:30:00Z',
            },
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await tools['indexing.status'].handler({
        site_url: 'sc-domain:example.com',
        url: targetUrl,
      }) as {
        structuredContent: {
          notification_metadata: {
            latestUpdate?: { type?: string; notifyTime?: string };
          };
          notification_receipt_only: boolean;
          index_coverage_report: boolean;
          indexing_or_removal_completion_proven: boolean;
          note: string;
        };
      };

      expect(result.structuredContent.notification_metadata.latestUpdate).toMatchObject({
        type: 'URL_UPDATED',
        notifyTime: '2026-09-22T07:30:00Z',
      });
      expect(result.structuredContent.notification_receipt_only).toBe(true);
      expect(result.structuredContent.index_coverage_report).toBe(false);
      expect(result.structuredContent.indexing_or_removal_completion_proven).toBe(false);
      expect(result.structuredContent.note).toContain('does not report whether Google crawled, indexed, or removed');

      // The owner preflight is itself a Google sites.list request. It must
      // consume the same shared metadata budget as explicit property reads.
      for (let index = 0; index < 9; index += 1) {
        const listResult = await tools['sites.list'].handler({}) as { isError?: boolean };
        expect(listResult.isError).not.toBe(true);
      }
      const exhausted = await tools['sites.list'].handler({}) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      expect(exhausted.isError).toBe(true);
      expect(exhausted.content?.[0]?.text).toContain('Rate limit reached for sites.list');
      expect(siteListRequests).toBe(10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('explains sitemap provider timestamps without rewriting provider values', async () => {
    await saveUser(
      workerEnv,
      'sitemap-user',
      'sitemap@example.test',
      'sitemap-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'sitemap-user',
        email: 'sitemap@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const sitemap = {
      path: 'https://example.com/sitemap.xml',
      lastSubmitted: '2026-08-03T10:00:00Z',
      lastDownloaded: '2026-09-14T08:30:00Z',
      isPending: false,
      warnings: '0',
      errors: '0',
      contents: [{ type: 'web', submitted: '321' }],
    };

    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'sitemap-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps'
        ) {
          return response({ sitemap: [sitemap] });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml'
        ) {
          return response(sitemap);
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const listResult = await tools['sitemaps.list'].handler({
        site_url: 'sc-domain:example.com',
      }) as {
        structuredContent: {
          sitemaps: Array<typeof sitemap>;
          provider_note: string;
        };
      };
      const getResult = await tools['sitemaps.get'].handler({
        site_url: 'sc-domain:example.com',
        feedpath: sitemap.path,
      }) as {
        structuredContent: {
          sitemap: typeof sitemap;
          provider_note: string;
        };
      };

      expect(listResult.structuredContent.sitemaps[0].lastSubmitted).toBe(
        '2026-08-03T10:00:00Z',
      );
      expect(listResult.structuredContent.sitemaps[0].lastDownloaded).toBe(
        '2026-09-14T08:30:00Z',
      );
      expect(getResult.structuredContent.sitemap.lastSubmitted).toBe(
        '2026-08-03T10:00:00Z',
      );
      expect(getResult.structuredContent.sitemap.lastDownloaded).toBe(
        '2026-09-14T08:30:00Z',
      );
      for (const note of [
        listResult.structuredContent.provider_note,
        getResult.structuredContent.provider_note,
      ]) {
        expect(note).toContain('submitted to Search Console');
        expect(note).toContain('last downloaded the sitemap');
        expect(note).toContain('not a page crawl or indexing timestamp');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes exact page/query drilldowns through Search Analytics filters', async () => {
    await saveUser(
      workerEnv,
      'drilldown-user',
      'drilldown@example.test',
      'drilldown-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'drilldown-user',
        email: 'drilldown@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const analyticsRequests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'drilldown-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          analyticsRequests.push(body);
          if ((body.startRow as number | undefined ?? 0) > 0) {
            return response({ rows: [] });
          }
          const dimensions = body.dimensions as string[];
          return response({
            rows: dimensions[0] === 'query'
              ? [{ keys: ['seo audit'], clicks: 7, impressions: 90, ctr: 0.077 }]
              : [{ keys: ['https://example.com/seo-audit/'], clicks: 7, impressions: 90, ctr: 0.077, position: 8.2 }],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const pageResult = await tools['insights.page_queries'].handler({
        site_url: 'sc-domain:example.com',
        page_url: 'https://example.com/seo-audit/',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
        data_state: 'all',
      }) as { structuredContent: { page: string; queries: Array<{ query: string }>; data_state: string; preliminary_data_possible: boolean } };
      const queryResult = await tools['insights.query_pages'].handler({
        site_url: 'sc-domain:example.com',
        query: 'seo audit',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
      }) as { structuredContent: { query: string; pages: Array<{ page: string }>; data_state: string; preliminary_data_possible: boolean } };
      const imageResult = await tools['insights.query_pages'].handler({
        site_url: 'sc-domain:example.com',
        query: 'seo audit',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'image',
        data_state: 'all',
      }) as { structuredContent: Record<string, unknown> };

      expect(pageResult.structuredContent).toMatchObject({
        page: 'https://example.com/seo-audit/',
        site_url: 'sc-domain:example.com',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
        queries: [{ query: 'seo audit', clicks: 7, impressions: 90, position: null }],
        data_state: 'all',
        preliminary_data_possible: true,
      });
      expect(queryResult.structuredContent).toMatchObject({
        query: 'seo audit',
        site_url: 'sc-domain:example.com',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
        pages: [{ page: 'https://example.com/seo-audit/' }],
        data_state: 'final',
        preliminary_data_possible: false,
      });
      expect(imageResult.structuredContent).toMatchObject({
        site_url: 'sc-domain:example.com',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'image',
      });
      expect(analyticsRequests).toHaveLength(3);
      expect(analyticsRequests.map((request) => request.startRow ?? 0)).toEqual([
        0,
        0,
        0,
      ]);
      expect(analyticsRequests[0]).toMatchObject({
        dimensions: ['query'],
        type: 'web',
        dataState: 'all',
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [{ dimension: 'page', operator: 'equals', expression: 'https://example.com/seo-audit/' }],
        }],
      });
      expect(analyticsRequests[1]).toMatchObject({
        dimensions: ['page'],
        type: 'web',
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [{ dimension: 'query', operator: 'equals', expression: 'seo audit' }],
        }],
      });
      expect(analyticsRequests[1]).not.toHaveProperty('dataState');
      expect(analyticsRequests[2]).toMatchObject({ dimensions: ['page'], type: 'image', dataState: 'all' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes exact-page query drilldowns by topic at Google before source pagination', async () => {
    await saveUser(workerEnv, 'page-topic-user', 'page-topic@example.test', 'page-topic-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'page-topic-user', email: 'page-topic@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'page-topic-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const groups = body.dimensionFilterGroups as Array<{
            filters: Array<{ dimension: string; operator: string; expression: string }>;
          }>;
          const topicScoped = groups[0]?.filters.some((filter) =>
            filter.dimension === 'query' && filter.operator === 'contains' && filter.expression === 'seo');
          return response({
            rows: [{
              keys: [topicScoped ? 'seo audit' : 'brand name'],
              clicks: 4,
              impressions: 80,
              ctr: 0.05,
              position: 8,
            }],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const input = {
        site_url: 'sc-domain:example.com',
        page_url: 'https://example.com/de/guides/',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
      };
      const unfiltered = await tools['insights.page_queries'].handler(input) as {
        structuredContent: { query_contains: string | null; device: string | null; queries: Array<{ query: string }> };
      };
      const scoped = await tools['insights.page_queries'].handler({ ...input, query_contains: 'seo', country: 'deu', device: 'mobile' }) as {
        structuredContent: {
          query_contains: string | null;
          country: string | null;
          device: string | null;
          scope_note: string;
          queries: Array<{ query: string }>;
        };
      };
      expect(unfiltered.structuredContent).toMatchObject({
        query_contains: null,
        device: null,
        queries: [{ query: 'brand name' }],
      });
      expect(scoped.structuredContent).toMatchObject({
        query_contains: 'seo',
        country: 'DEU',
        device: 'mobile',
        queries: [{ query: 'seo audit' }],
      });
      expect(scoped.structuredContent.scope_note).toContain('not all queries');
      expect(scoped.structuredContent.scope_note).toContain('searcher country');
      expect(scoped.structuredContent.scope_note).toContain('device');
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        dimensions: ['query'],
        dimensionFilterGroups: [{
          filters: [{ dimension: 'page', operator: 'equals', expression: input.page_url }],
        }],
      });
      expect(requests[1]).toMatchObject({
        dimensions: ['query'],
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [
            { dimension: 'page', operator: 'equals', expression: input.page_url },
            { dimension: 'query', operator: 'contains', expression: 'seo' },
            { dimension: 'country', operator: 'equals', expression: 'DEU' },
            { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
          ],
        }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes exact-query page drilldowns at Google before source pagination', async () => {
    await saveUser(
      workerEnv,
      'localized-query-user',
      'localized-query@example.test',
      'localized-query-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'localized-query-user',
        email: 'localized-query@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const analyticsRequests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'localized-query-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          analyticsRequests.push(body);
          const groups = body.dimensionFilterGroups as Array<{
            filters: Array<{ dimension: string; operator: string; expression: string }>;
          }>;
          const scoped = groups[0]?.filters.some((filter) =>
            filter.dimension === 'page' && filter.operator === 'contains' && filter.expression === '/de/');
          return response({
            rows: [{
              keys: [scoped ? 'https://example.com/de/preise/' : 'https://example.com/en/pricing/'],
              clicks: 5,
              impressions: 100,
              ctr: 0.05,
              ...(scoped ? {} : { position: 9 }),
            }],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const input = {
        site_url: 'sc-domain:example.com',
        query: 'pricing',
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        search_type: 'web',
      };
      const unfiltered = await tools['insights.query_pages'].handler(input) as {
        structuredContent: { page_contains: string | null; device: string | null; pages: Array<{ page: string }> };
      };
      const scoped = await tools['insights.query_pages'].handler({
        ...input,
        page_contains: '/de/',
        country: 'deu',
        device: 'mobile',
      }) as {
        structuredContent: {
          page_contains: string | null;
          country: string | null;
          device: string | null;
          scope_note: string;
          pages: Array<{ page: string }>;
        };
      };
      expect(unfiltered.structuredContent.page_contains).toBeNull();
      expect(unfiltered.structuredContent.device).toBeNull();
      expect(unfiltered.structuredContent.pages[0]?.page).toBe('https://example.com/en/pricing/');
      expect(unfiltered.structuredContent.pages[0]).toMatchObject({ position: 9 });
      expect(scoped.structuredContent).toMatchObject({
        page_contains: '/de/',
        country: 'DEU',
        device: 'mobile',
        pages: [{ page: 'https://example.com/de/preise/', clicks: 5, impressions: 100, ctr: 0.05, position: null }],
      });
      expect(scoped.structuredContent.scope_note).toContain('not property-wide');
      expect(scoped.structuredContent.scope_note).toContain('searcher country');
      expect(scoped.structuredContent.scope_note).toContain('device');
      expect(analyticsRequests).toHaveLength(2);
      expect(analyticsRequests[0]).toMatchObject({
        dimensions: ['page'],
        dimensionFilterGroups: [{
          filters: [{ dimension: 'query', operator: 'equals', expression: 'pricing' }],
        }],
      });
      expect(analyticsRequests[1]).toMatchObject({
        dimensions: ['page'],
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [
            { dimension: 'query', operator: 'equals', expression: 'pricing' },
            { dimension: 'page', operator: 'contains', expression: '/de/' },
            { dimension: 'country', operator: 'equals', expression: 'DEU' },
            { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
          ],
        }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('propagates OAuth application props through the stateless MCP handler', async () => {
    await saveUser(
      workerEnv,
      'handler-user',
      'handler@example.test',
      'handler-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'handler-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
          return response({
            siteEntry: [
              { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
              { siteUrl: 'https://pending.example.com/', permissionLevel: 'siteUnverifiedUser' },
            ],
          });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com'
        ) {
          return response({
            siteUrl: 'sc-domain:example.com',
            permissionLevel: 'siteOwner',
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await mcpApiHandler.fetch(
        new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'sites.list', arguments: {} },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'handler-user',
            email: 'handler@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const envelope = await readMcpJsonRpc(result);
      const serializedList = JSON.stringify(envelope);
      expect(serializedList).toContain('sc-domain:example.com');
      expect(serializedList).toContain('api_identifier_kind');
      expect(serializedList).toContain('mcp_site_url_accepted');
      expect(serializedList).toContain('"verification_state":"verified"');
      expect(serializedList).toContain('"verification_state":"unverified"');
      expect(serializedList).toContain('"owner":true');
      expect(serializedList).toContain('"owner":false');
      expect(serializedList).not.toContain('Not authenticated');

      const detailResult = await mcpApiHandler.fetch(
        new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'sites.get',
              arguments: { site_url: 'sc-domain:example.com' },
            },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'handler-user',
            email: 'handler@example.test',
          },
        } as unknown as ExecutionContext,
      );
      expect(detailResult.status).toBe(200);
      const detailEnvelope = await readMcpJsonRpc(detailResult);
      const serializedDetail = JSON.stringify(detailEnvelope);
      expect(serializedDetail).toContain('"verification_state":"verified"');
      expect(serializedDetail).toContain('"owner":true');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts a true site-total Search Analytics row when Google omits keys', async () => {
    await saveUser(
      workerEnv,
      'aggregate-user',
      'aggregate@example.test',
      'aggregate-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'aggregate-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          return response({
            rows: [
              {
                clicks: 73,
                impressions: 121404,
                ctr: 0.000601,
                position: 58.36,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await mcpApiHandler.fetch(
        new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'analytics.query',
              arguments: {
                site_url: 'sc-domain:example.com',
                start_date: '2026-08-22',
                end_date: '2026-09-18',
                dimensions: [],
                row_limit: 1,
                dimension_filter_groups: [{
                  groupType: 'and',
                  filters: [{ dimension: 'query', operator: 'contains', expression: 'private-topic-fixture' }],
                }],
              },
            },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'aggregate-user',
            email: 'aggregate@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const envelope = await readMcpJsonRpc(result);
      const serialized = JSON.stringify(envelope);
      expect(serialized).toContain('121404');
      expect(serialized).toContain('\"dimensions\":[]');
      expect(serialized).toContain('\"search_type\":\"web\"');
      expect(serialized).toContain('\"site_url\":\"sc-domain:example.com\"');
      expect(serialized).toContain('\"start_date\":\"2026-08-22\"');
      expect(serialized).toContain('\"end_date\":\"2026-09-18\"');
      expect(serialized).toContain('\"filter_group_count\":1');
      expect(serialized).not.toContain('private-topic-fixture');
      expect(serialized).toContain('"provider_exhaustiveness_guaranteed":false');
      expect(serialized).toContain('Google Search Analytics does not guarantee all data rows');
      expect(serialized).toContain('do not prove provider-level exhaustiveness');
      expect(serialized).toContain('"generative_ai_report_isolatable":false');
      expect(serialized).toContain('dedicated Generative AI performance reports');
      expect(serialized).toContain('overall web Search performance data');
      expect(serialized).toContain('"multimodal_report_isolatable":true');
      expect(serialized).toContain("search_type='webMultimodal'");
      expect(serialized).toContain("search_type='multimodal'");
      expect(serialized).not.toContain('Output validation error');
      expect(serialized).not.toContain('\"keys\"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forwards documented webMultimodal type in query and both comparison periods', async () => {
    await saveUser(workerEnv, 'visual-user', 'visual@example.test', 'visual-refresh-token');
    const originalFetch = globalThis.fetch;
    const providerTypes: unknown[] = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'visual-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          providerTypes.push(body.type);
          return response({ rows: [{
            keys: ['https://example.com/visual-guide/'],
            clicks: 6, impressions: 80, ctr: 0.075, position: 3.1,
          }] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const call = async (name: string, args: Record<string, unknown>, id: number) => {
        const result = await mcpApiHandler.fetch(new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        }), workerEnv, { props: {
          google_id: 'visual-user', email: 'visual@example.test',
        } } as unknown as ExecutionContext);
        expect(result.status).toBe(200);
        return JSON.stringify(await readMcpJsonRpc(result));
      };
      const query = await call('analytics.query', {
        site_url: 'sc-domain:example.com',
        start_date: '2026-10-01', end_date: '2026-10-08',
        dimensions: ['page'], row_limit: 10, search_type: 'webMultimodal',
      }, 99);
      expect(query).toContain('\\"search_type\\":\\"webMultimodal\\"');
      expect(query).toContain('\\"multimodal_report_isolatable\\":true');
      expect(query).not.toContain('Output validation error');
      const compare = await call('analytics.compare', {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-10-09', end_date_a: '2026-10-16',
        start_date_b: '2026-10-01', end_date_b: '2026-10-08',
        dimension: 'page', search_type: 'webMultimodal',
      }, 100);
      expect(compare).not.toContain('Output validation error');
      expect(providerTypes).toEqual(['webMultimodal', 'webMultimodal', 'webMultimodal']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forwards Google-native multi-country and multi-device filterLists without extra provider reads', async () => {
    await saveUser(workerEnv, 'regional-user', 'region@example.test', 'regional-refresh-token');
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'regional-access-token', expires_in: 3600 });
        }
        if (url.endsWith('/searchAnalytics/query')) {
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return response({ rows: [{
            keys: ['https://example.com/dach/'], clicks: 6,
            impressions: 60, ctr: 0.1, position: 3,
          }] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const call = async (name: string, args: Record<string, unknown>, id: number) => {
        const res = await mcpApiHandler.fetch(new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        }), workerEnv, { props: { google_id: 'regional-user', email: 'region@example.test' } } as unknown as ExecutionContext);
        expect(res.status).toBe(200);
        return JSON.stringify(await readMcpJsonRpc(res));
      };
      const dimension_filter_groups = [{ filterLists: [
        { dimension: 'country', expressions: ['deu', 'aut', 'che'] },
        { dimension: 'device', expressions: ['mobile', 'desktop'] },
      ] }];
      const direct = await call('analytics.query', {
        site_url: 'sc-domain:example.com', start_date: '2026-11-01', end_date: '2026-11-07',
        dimensions: ['page'], row_limit: 10, dimension_filter_groups,
      }, 810);
      expect(direct).not.toContain('Output validation error');
      expect(requests).toHaveLength(1);
      const expected = [{ groupType: 'and', filters: [], filterLists: [
        { dimension: 'country', expressions: ['DEU', 'AUT', 'CHE'] },
        { dimension: 'device', expressions: ['MOBILE', 'DESKTOP'] },
      ] }];
      expect(requests[0]?.dimensionFilterGroups).toEqual(expected);
      const compared = await call('analytics.compare', {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-11-08', end_date_a: '2026-11-14',
        start_date_b: '2026-11-01', end_date_b: '2026-11-07',
        dimension: 'page', dimension_filter_groups,
      }, 811);
      expect(compared).not.toContain('Output validation error');
      expect(requests).toHaveLength(3);
      expect(requests.slice(1).every((req) => JSON.stringify(req.dimensionFilterGroups) === JSON.stringify(expected))).toBe(true);
      const invalid = await call('analytics.query', {
        site_url: 'sc-domain:example.com', start_date: '2026-11-01', end_date: '2026-11-07',
        dimensions: ['page'], row_limit: 10, dimension_filter_groups: [{
          filters: [{ dimension: 'country', expression: 'DEU', operator: 'equals' }],
          filterLists: [{ dimension: 'country', expressions: ['AUT', 'CHE'] }],
        }],
      }, 812);
      expect(invalid).toContain('cannot appear in both filters and filterLists');
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps query/page dimension keys and exposes usable analytics pagination metadata', async () => {
    await saveUser(
      workerEnv,
      'dimension-user',
      'dimension@example.test',
      'dimension-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'dimension-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as {
            dimensions: string[];
          };
          const key =
            body.dimensions[0] === 'query'
              ? 'gsc mcp'
              : 'https://example.com/gsc-mcp/';
          return response({
            rows: [
              {
                keys: [key],
                clicks: 2,
                impressions: 100,
                ctr: 0.02,
                position: 9,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const callAnalytics = async (
        dimensions: ['query'] | ['page'],
        startRow: number,
        dataState: 'all' | 'final' = 'all',
      ) =>
        mcpApiHandler.fetch(
          new Request('https://worker.example/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': '2025-06-18',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: startRow + 10,
              method: 'tools/call',
              params: {
                name: 'analytics.query',
                arguments: {
                  site_url: 'sc-domain:example.com',
                  start_date: '2026-08-22',
                  end_date: '2026-09-18',
                  dimensions,
                  row_limit: 1,
                  start_row: startRow,
                  data_state: dataState,
                },
              },
            }),
          }),
          workerEnv,
          {
            props: {
              google_id: 'dimension-user',
              email: 'dimension@example.test',
            },
          } as unknown as ExecutionContext,
        );

      const queryResponse = await callAnalytics(['query'], 0);
      expect(queryResponse.status).toBe(200);
      const querySerialized = JSON.stringify(
        await readMcpJsonRpc(queryResponse),
      );
      expect(querySerialized).toContain('gsc mcp');
      expect(querySerialized).toContain('\"dimensions\":[\"query\"]');
      expect(querySerialized).toContain('\"search_type\":\"web\"');
      expect(querySerialized).toContain('\"has_more\":true');
      expect(querySerialized).toContain('\"next_start_row\":1');
      expect(querySerialized).toContain('\"data_state\":\"all\"');
      expect(querySerialized).toContain('\"preliminary_data_possible\":true');
      expect(querySerialized).not.toContain('Output validation error');

      const pageResponse = await callAnalytics(['page'], 10, 'final');
      expect(pageResponse.status).toBe(200);
      const pageSerialized = JSON.stringify(await readMcpJsonRpc(pageResponse));
      expect(pageSerialized).toContain('https://example.com/gsc-mcp/');
      expect(pageSerialized).toContain('\"dimensions\":[\"page\"]');
      expect(pageSerialized).toContain('\"search_type\":\"web\"');
      expect(pageSerialized).toContain('\"has_more\":true');
      expect(pageSerialized).toContain('\"next_start_row\":11');
      expect(pageSerialized).toContain('\"data_state\":\"final\"');
      expect(pageSerialized).toContain('\"preliminary_data_possible\":false');
      expect(pageSerialized).not.toContain('Output validation error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks analytics.query terminal after a short non-empty provider page', async () => {
    await saveUser(
      workerEnv,
      'short-page-user',
      'short-page@example.test',
      'short-page-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'short-page-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as {
            startRow?: number;
            rowLimit: number;
          };
          expect(body.rowLimit).toBe(10);
          if ((body.startRow ?? 0) === 10) {
            return response({ rows: [] });
          }
          expect(body.startRow ?? 0).toBe(0);
          return response({
            rows: [
              {
                keys: ['short provider page'],
                clicks: 2,
                impressions: 20,
                ctr: 0.1,
                position: 5,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const callAnalytics = async (startRow: number) =>
        mcpApiHandler.fetch(
          new Request('https://worker.example/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': '2025-06-18',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 40 + startRow,
              method: 'tools/call',
              params: {
                name: 'analytics.query',
                arguments: {
                  site_url: 'sc-domain:example.com',
                  start_date: '2026-08-22',
                  end_date: '2026-09-18',
                  dimensions: ['query'],
                  row_limit: 10,
                  start_row: startRow,
                },
              },
            }),
          }),
          workerEnv,
          {
            props: {
              google_id: 'short-page-user',
              email: 'short-page@example.test',
            },
          } as unknown as ExecutionContext,
        );

      const first = JSON.stringify(await readMcpJsonRpc(await callAnalytics(0)));
      expect(first).toContain('short provider page');
      expect(first).toContain('\\"has_more\\":false');
      expect(first).not.toContain('\\"next_start_row\\"');
      expect(first).not.toContain('Output validation error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks average position unavailable for Discover Search Analytics results', async () => {
    await saveUser(
      workerEnv,
      'discover-user',
      'discover@example.test',
      'discover-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'discover-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.type).toBe('discover');
          return response({
            rows: [
              {
                keys: ['https://example.com/discover-story/'],
                clicks: 12,
                impressions: 340,
                ctr: 0.035,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await mcpApiHandler.fetch(
        new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 29,
            method: 'tools/call',
            params: {
              name: 'analytics.query',
              arguments: {
                site_url: 'sc-domain:example.com',
                start_date: '2026-08-22',
                end_date: '2026-09-18',
                dimensions: ['page'],
                search_type: 'discover',
                row_limit: 10,
              },
            },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'discover-user',
            email: 'discover@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const serialized = JSON.stringify(await readMcpJsonRpc(result));
      expect(serialized).toContain('\"position_supported\":false');
      expect(serialized).toContain('Google Discover does not support average position');
      expect(serialized).not.toContain('Output validation error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks average position unavailable for Google News Search Analytics results', async () => {
    await saveUser(
      workerEnv,
      'google-news-user',
      'google-news@example.test',
      'google-news-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'google-news-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.type).toBe('googleNews');
          return response({
            rows: [
              {
                keys: ['https://example.com/google-news-story/'],
                clicks: 9,
                impressions: 210,
                ctr: 0.043,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = await mcpApiHandler.fetch(
        new Request('https://worker.example/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 30,
            method: 'tools/call',
            params: {
              name: 'analytics.query',
              arguments: {
                site_url: 'sc-domain:example.com',
                start_date: '2026-08-22',
                end_date: '2026-09-18',
                dimensions: ['page'],
                search_type: 'googleNews',
                row_limit: 10,
              },
            },
          }),
        }),
        workerEnv,
        {
          props: {
            google_id: 'google-news-user',
            email: 'google-news@example.test',
          },
        } as unknown as ExecutionContext,
      );

      expect(result.status).toBe(200);
      const serialized = JSON.stringify(await readMcpJsonRpc(result));
      expect(serialized).toContain('\"position_supported\":false');
      expect(serialized).toContain('Google News does not support average position');
      expect(serialized).not.toContain('Output validation error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds structured output for comparison, impression-page proxy, and cannibalization', async () => {
    await saveUser(
      workerEnv,
      'bounded-user',
      'bounded@example.test',
      'bounded-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'bounded-user',
        email: 'bounded@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const registered = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const longSuffix = 'x'.repeat(220);
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'bounded-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as {
            startDate: string;
            dimensions: string[];
            startRow?: number;
          };
          if ((body.startRow ?? 0) > 0) {
            return response({ rows: [] });
          }
          if (body.dimensions.length === 2) {
            return response({
              rows: Array.from({ length: 800 }, (_, index) => {
                const queryIndex = Math.floor(index / 2);
                return {
                  keys: [
                    `query-${queryIndex}-${longSuffix}`,
                    `https://example.com/candidate-${index}-${longSuffix}`,
                  ],
                  clicks: 1,
                  impressions: 1000 - queryIndex,
                  ctr: 0.001,
                  position: 20 + (index % 2),
                };
              }),
            });
          }
          const isListPageCall = body.startDate === '2026-06-01';
          const rowCount = isListPageCall ? 500 : 700;
          const multiplier = body.startDate === '2026-09-01' ? 2 : 1;
          return response({
            rows: Array.from({ length: rowCount }, (_, index) => ({
              keys: [`https://example.com/page-${index}-${longSuffix}`],
              clicks: (index % 20) * multiplier,
              impressions: 2000 - index,
              ctr: 0.01,
              position: 10 + (index % 40),
            })),
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const indexed = (await registered['indexing.list_pages'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        row_limit: 1000,
        start_row: 0,
      })) as {
        structuredContent: {
          result_page: { has_more: boolean; next_start_row?: number };
        };
      };
      expect(indexed.structuredContent.result_page.has_more).toBe(true);
      expect(indexed.structuredContent.result_page.next_start_row).toBeGreaterThan(0);
      expect(
        new TextEncoder().encode(JSON.stringify(indexed.structuredContent)).byteLength,
      ).toBeLessThan(55_000);

      const comparison = (await registered['analytics.compare'].handler({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01',
        end_date_a: '2026-09-23',
        start_date_b: '2026-08-01',
        end_date_b: '2026-08-31',
        dimension: 'page',
        search_type: 'web',
        limit: 100,
        start_row: 0,
      })) as {
        structuredContent: {
          result_page: { has_more: boolean; next_start_row?: number };
          comparison_note: string;
        };
      };
      expect(comparison.structuredContent.result_page.has_more).toBe(true);
      expect(comparison.structuredContent.result_page.next_start_row).toBeGreaterThan(0);
      expect(comparison.structuredContent.comparison_note).toContain('dimension=page');
      expect(comparison.structuredContent.comparison_note).toContain('search_type=web');
      expect(comparison.structuredContent.comparison_note).toContain('dimension_filter_groups=0');
      expect(
        new TextEncoder().encode(JSON.stringify(comparison.structuredContent)).byteLength,
      ).toBeLessThan(55_000);

      const cannibalization = (await registered['insights.cannibalization'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        limit: 100,
        start_row: 0,
      })) as {
        structuredContent: {
          result_page: { has_more: boolean; next_start_row?: number };
        };
      };
      expect(cannibalization.structuredContent.result_page.has_more).toBe(true);
      expect(cannibalization.structuredContent.result_page.next_start_row).toBeGreaterThan(0);
      expect(
        new TextEncoder().encode(JSON.stringify(cannibalization.structuredContent)).byteLength,
      ).toBeLessThan(55_000);

      const topicCandidates = (await registered['insights.cannibalization'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        query_contains: 'QUERY-17-',
        limit: 100,
        start_row: 0,
      })) as {
        structuredContent: {
          candidates: Array<{ query: string; page_count: number }>;
          result_page: { has_more: boolean };
        };
      };
      expect(topicCandidates.structuredContent.candidates).toHaveLength(1);
      expect(topicCandidates.structuredContent.candidates[0].query).toMatch(/^query-17-/);
      expect(topicCandidates.structuredContent.candidates[0].page_count).toBe(2);
      expect(topicCandidates.structuredContent.result_page.has_more).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes quick wins at Google before pagination while retaining the unfiltered default', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-locale-user', email: 'quick-wins-locale@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const rows = [
      { keys: ['seo basics', 'https://example.com/en/guide'], impressions: 900 },
      { keys: ['seo grundlagen', 'https://example.com/de/guide'], impressions: 150 },
      { keys: ['seo tipps', 'https://example.com/de/tips'], impressions: 75 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    let requests = 0;
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: Array<{ filters: Array<{ dimension: string; operator: string; expression: string }> }>;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        requests += 1;
        const filter = body.dimensionFilterGroups?.[0]?.filters?.[0];
        if (requests === 1) {
          expect(filter).toEqual({ dimension: 'page', operator: 'contains', expression: '/de/' });
        } else {
          expect(filter).toBeUndefined();
        }
        return response({
          rows: filter
            ? rows.filter((row) => row.keys[1].toLowerCase().includes(filter.expression.toLowerCase()))
            : rows,
        });
      };

      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.quick_wins'].handler({ ...args, page_contains: '/de/' })) as {
        structuredContent: { page_contains: string | null; scope_note: string; quick_wins: Array<{ page: string }> };
      };
      expect(scoped.structuredContent.page_contains).toBe('/de/');
      expect(scoped.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(scoped.structuredContent.quick_wins.map((row) => row.page)).toEqual(['https://example.com/de/guide']);

      const defaultResult = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { page_contains: string | null; quick_wins: Array<{ page: string }> };
      };
      expect(defaultResult.structuredContent.page_contains).toBeNull();
      expect(defaultResult.structuredContent.quick_wins).toHaveLength(2);
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters quick-win query topics at Google with optional page scope', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-topic-user', email: 'quick-wins-topic@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const rows = [
      { keys: ['brand guide', 'https://example.com/de/brand'], impressions: 950 },
      { keys: ['technical seo', 'https://example.com/en/technical'], impressions: 850 },
      { keys: ['technical seo', 'https://example.com/de/technical'], impressions: 210 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    const requests: Array<Array<{ dimension: string; operator: string; expression: string }>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: Array<{ groupType: string; filters: Array<{
            dimension: string; operator: string; expression: string;
          }> }>;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        const filters = body.dimensionFilterGroups?.[0]?.filters ?? [];
        if (filters.length) expect(body.dimensionFilterGroups?.[0]?.groupType).toBe('and');
        requests.push(filters);
        return response({ rows: rows.filter((row) => filters.every((filter) =>
          row.keys[filter.dimension === 'query' ? 0 : 1]
            .toLowerCase().includes(filter.expression.toLowerCase())
        )) });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.quick_wins'].handler({
        ...args, page_contains: '/de/', query_contains: 'SEO',
      })) as { structuredContent: {
        query_contains: string | null; scope_note: string; quick_wins: Array<{ page: string }>;
      } };
      expect(requests[0]).toEqual([
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'query', operator: 'contains', expression: 'SEO' },
      ]);
      expect(scoped.structuredContent.query_contains).toBe('SEO');
      expect(scoped.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(scoped.structuredContent.quick_wins.map((row) => row.page))
        .toEqual(['https://example.com/de/technical']);
      const topicOnly = (await registered['insights.quick_wins'].handler({
        ...args, query_contains: 'seo',
      })) as { structuredContent: { quick_wins: Array<{ page: string }> } };
      expect(requests[1]).toEqual([{ dimension: 'query', operator: 'contains', expression: 'seo' }]);
      expect(topicOnly.structuredContent.quick_wins).toHaveLength(2);
      const all = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { query_contains: string | null; quick_wins: Array<{ page: string }> };
      };
      expect(requests[2]).toEqual([]);
      expect(all.structuredContent.query_contains).toBeNull();
      expect(all.structuredContent.quick_wins).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes quick wins to searcher country alongside page and query before pagination', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-country-user', email: 'quick-wins-country@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const rows = [
      { country: 'DEU', keys: ['technical seo', 'https://example.com/de/guide'], impressions: 210 },
      { country: 'USA', keys: ['technical seo', 'https://example.com/de/other'], impressions: 320 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    const requests: Array<Array<{ dimension: string; operator: string; expression: string }>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: Array<{ groupType: string; filters: Array<{
            dimension: string; operator: string; expression: string;
          }> }>;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        const filters = body.dimensionFilterGroups?.[0]?.filters ?? [];
        if (filters.length) expect(body.dimensionFilterGroups?.[0]?.groupType).toBe('and');
        requests.push(filters);
        return response({ rows: rows.filter((row) => filters.every((filter) => {
          const value = filter.dimension === 'country'
            ? row.country : row.keys[filter.dimension === 'query' ? 0 : 1];
          return filter.operator === 'equals'
            ? value.toUpperCase() === filter.expression.toUpperCase()
            : value.toLowerCase().includes(filter.expression.toLowerCase());
        })) });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.quick_wins'].handler({
        ...args, page_contains: '/de/', query_contains: 'SEO', country: 'deu',
      })) as { structuredContent: {
        country: string | null; scope_note: string; quick_wins: Array<{ page: string }>;
      } };
      expect(requests[0]).toEqual([
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'query', operator: 'contains', expression: 'SEO' },
        { dimension: 'country', operator: 'equals', expression: 'DEU' },
      ]);
      expect(scoped.structuredContent.country).toBe('DEU');
      expect(scoped.structuredContent.scope_note).toMatch(/searcher country.*not property-wide/i);
      expect(scoped.structuredContent.quick_wins.map((row) => row.page))
        .toEqual(['https://example.com/de/guide']);
      const unfiltered = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { country: string | null; quick_wins: unknown[] };
      };
      expect(requests[1]).toEqual([]);
      expect(unfiltered.structuredContent.country).toBeNull();
      expect(unfiltered.structuredContent.quick_wins).toHaveLength(2);
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes mobile quick wins before pagination without changing the unfiltered request', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-device-user', email: 'quick-wins-device@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const rows = [
      { device: 'MOBILE', keys: ['seo audit', 'https://example.com/de/audit'], impressions: 210 },
      { device: 'DESKTOP', keys: ['seo audit', 'https://example.com/de/desktop'], impressions: 320 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    const requests: Array<Array<{ dimension: string; operator: string; expression: string }>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensionFilterGroups?: Array<{ groupType: string; filters: Array<{
            dimension: string; operator: string; expression: string;
          }> }>;
        };
        const filters = body.dimensionFilterGroups?.[0]?.filters ?? [];
        if (filters.length) expect(body.dimensionFilterGroups?.[0]?.groupType).toBe('and');
        requests.push(filters);
        return response({ rows: rows.filter((row) => filters.every((filter) => {
          const value = filter.dimension === 'device' ? row.device
            : row.keys[filter.dimension === 'query' ? 0 : 1];
          return filter.operator === 'equals'
            ? value.toUpperCase() === filter.expression.toUpperCase()
            : value.toLowerCase().includes(filter.expression.toLowerCase());
        })) });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const mobile = (await registered['insights.quick_wins'].handler({
        ...args, device: 'mobile', page_contains: '/de/', query_contains: 'seo',
      })) as { structuredContent: {
        device: string | null; scope_note: string; quick_wins: Array<{ page: string }>;
      } };
      expect(requests[0]).toEqual([
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'query', operator: 'contains', expression: 'seo' },
        { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
      ]);
      expect(mobile.structuredContent.device).toBe('mobile');
      expect(mobile.structuredContent.scope_note).toMatch(/device.*not property-wide/i);
      expect(mobile.structuredContent.quick_wins.map((row) => row.page))
        .toEqual(['https://example.com/de/audit']);
      const all = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { device: string | null; quick_wins: unknown[] };
      };
      expect(requests[1]).toEqual([]);
      expect(all.structuredContent.device).toBeNull();
      expect(all.structuredContent.quick_wins).toHaveLength(2);
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves combined country/device quick-win scope at Google with one bounded request', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-multimarket-user', email: 'quick-wins-multimarket@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        return response({ rows: [{
          keys: ['technical seo', 'https://example.com/de/guide'],
          clicks: 5, impressions: 240, ctr: 5 / 240, position: 12,
        }] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
        page_contains: '/de/', query_contains: 'seo', countries: ['deu', 'usa'], devices: ['mobile', 'desktop'],
      };
      const result = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { countries: string[]; devices: string[]; scope_note: string; quick_wins: unknown[] };
      };
      expect(requests).toHaveLength(1);
      expect(requests[0].dimensionFilterGroups).toEqual([{
        groupType: 'and',
        filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'query', operator: 'contains', expression: 'seo' },
        ],
        filterLists: [
          { dimension: 'country', expressions: ['DEU', 'USA'] },
          { dimension: 'device', expressions: ['MOBILE', 'DESKTOP'] },
        ],
      }]);
      expect(result.structuredContent.countries).toEqual(['DEU', 'USA']);
      expect(result.structuredContent.devices).toEqual(['mobile', 'desktop']);
      expect(result.structuredContent.quick_wins).toHaveLength(1);
      expect(result.structuredContent.scope_note).toMatch(/one combined segment/i);
      await registered['insights.quick_wins'].handler({ ...args, country: 'FRA' });
      expect(requests).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('finds image/video/news quick wins on the selected Search surface while preserving Web default', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-surface-user', email: 'quick-wins-surface@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ type?: string; filters: Array<{ dimension: string; expression: string }> }> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          type?: string;
          dimensionFilterGroups?: Array<{ filters: Array<{ dimension: string; expression: string }> }>;
        };
        requests.push({ type: body.type, filters: body.dimensionFilterGroups?.[0]?.filters ?? [] });
        return response({ rows: [{
          keys: [body.type === 'image' ? 'image seo' : 'search seo', 'https://example.com/de/guide'],
          clicks: 10, impressions: 150, ctr: 10 / 150, position: 12,
        }] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const image = (await registered['insights.quick_wins'].handler({
        ...args, search_type: 'image', page_contains: '/de/', device: 'mobile',
      })) as { structuredContent: { search_type: string; note: string; quick_wins: Array<{ query: string }> } };
      expect(requests[0]).toEqual({ type: 'image', filters: [
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
      ] });
      expect(image.structuredContent.search_type).toBe('image');
      expect(image.structuredContent.quick_wins[0]?.query).toBe('image seo');
      expect(image.structuredContent.note).toMatch(/selected search surface/i);
      const video = (await registered['insights.quick_wins'].handler({ ...args, search_type: 'video' })) as {
        structuredContent: { search_type: string };
      };
      const news = (await registered['insights.quick_wins'].handler({ ...args, search_type: 'news' })) as {
        structuredContent: { search_type: string };
      };
      const web = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { search_type: string };
      };
      expect(requests.slice(1).map((entry) => entry.type ?? 'web')).toEqual(['video', 'news', 'web']);
      expect([video.structuredContent.search_type, news.structuredContent.search_type, web.structuredContent.search_type])
        .toEqual(['video', 'news', 'web']);
      expect(requests).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters quick wins by optional CTR ceiling without another provider request', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-ctr-user', email: 'quick-wins-ctr@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async () => {
        requests += 1;
        return response({ rows: [
          { keys: ['higher ctr', 'https://example.com/a'], clicks: 10, impressions: 200, ctr: 0.05, position: 12 },
          { keys: ['low ctr', 'https://example.com/b'], clicks: 2, impressions: 200, ctr: 0.01, position: 12 },
          { keys: ['no clicks', 'https://example.com/c'], clicks: 0, impressions: 150, ctr: 0, position: 12 },
        ] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const invoke = async (additional: Record<string, unknown>) => {
        const result = (await registered['insights.quick_wins'].handler({ ...args, ...additional })) as {
          structuredContent: { max_ctr: number | null; quick_wins: Array<{ query: string }> };
        };
        return result.structuredContent;
      };
      const filtered = await invoke({ max_ctr: 0.02 });
      expect(filtered.max_ctr).toBe(0.02);
      expect(filtered.quick_wins.map((row) => row.query)).toEqual(['low ctr', 'no clicks']);
      const zero = await invoke({ max_ctr: 0 });
      expect(zero.quick_wins.map((row) => row.query)).toEqual(['no clicks']);
      const unfiltered = await invoke({});
      expect(unfiltered.max_ctr).toBeNull();
      expect(unfiltered.quick_wins).toHaveLength(3);
      expect(requests).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('offers explicitly preliminary quick wins without changing the finalized default', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'quick-wins-fresh-user', email: 'quick-wins-fresh@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ dataState?: string }> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as { dataState?: string });
        return response({ rows: [{ keys: ['seo guide', 'https://example.com/guide'], clicks: 4, impressions: 150, ctr: 4 / 150, position: 11 }] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 100, min_position: 8, max_position: 20, limit: 20, start_row: 0,
      };
      const preliminary = (await registered['insights.quick_wins'].handler({ ...args, data_state: 'all' })) as {
        structuredContent: { site_url: string; start_date: string; end_date: string; data_state: string; preliminary_data_possible: boolean; quick_wins: unknown[]; note: string };
      };
      expect(requests[0]?.dataState).toBe('all');
      expect(preliminary.structuredContent).toMatchObject({
        site_url: args.site_url, start_date: args.start_date, end_date: args.end_date,
      });
      expect(preliminary.structuredContent.data_state).toBe('all');
      expect(preliminary.structuredContent.preliminary_data_possible).toBe(true);
      expect(preliminary.structuredContent.note).toMatch(/preliminary/i);
      expect(preliminary.structuredContent.quick_wins).toHaveLength(1);
      const finalized = (await registered['insights.quick_wins'].handler(args)) as {
        structuredContent: { site_url: string; start_date: string; end_date: string; data_state: string; preliminary_data_possible: boolean };
      };
      expect(requests[1]?.dataState).toBeUndefined();
      expect(finalized.structuredContent).toMatchObject({
        site_url: args.site_url, start_date: args.start_date, end_date: args.end_date,
      });
      expect(finalized.structuredContent.data_state).toBe('final');
      expect(finalized.structuredContent.preliminary_data_possible).toBe(false);
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('labels preliminary cannibalization evidence while preserving finalized default requests', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-fresh-user', email: 'cannibal-fresh@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ dataState?: string; dimensions: string[] }> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as { dataState?: string; dimensions: string[] });
        return response({ rows: [
          { keys: ['pricing', 'https://example.com/pricing'], impressions: 250, clicks: 15, ctr: 0.06, position: 11 },
          { keys: ['pricing', 'https://example.com/plans'], impressions: 150, clicks: 10, ctr: 0.067, position: 12 },
        ] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 1, min_page_percentage: 1, limit: 20, start_row: 0,
      };
      const preliminary = (await registered['insights.cannibalization'].handler({ ...args, data_state: 'all' })) as {
        structuredContent: { site_url: string; start_date: string; end_date: string; data_state: string; preliminary_data_possible: boolean; scope_note: string; candidates: unknown[] };
      };
      expect(requests[0]).toMatchObject({ dataState: 'all', dimensions: ['query', 'page'] });
      expect(preliminary.structuredContent).toMatchObject({
        site_url: args.site_url, start_date: args.start_date, end_date: args.end_date,
      });
      expect(preliminary.structuredContent).toMatchObject({ data_state: 'all', preliminary_data_possible: true });
      expect(preliminary.structuredContent.scope_note).toMatch(/preliminary.*change/i);
      expect(preliminary.structuredContent.candidates).toHaveLength(1);
      const finalized = (await registered['insights.cannibalization'].handler(args)) as {
        structuredContent: { site_url: string; start_date: string; end_date: string; data_state: string; preliminary_data_possible: boolean };
      };
      expect(requests[1]?.dataState).toBeUndefined();
      expect(finalized.structuredContent).toMatchObject({
        site_url: args.site_url, start_date: args.start_date, end_date: args.end_date,
      });
      expect(finalized.structuredContent).toMatchObject({ data_state: 'final', preliminary_data_possible: false });
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes cannibalization to one locale before aggregating candidate page shares', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-locale-user', email: 'cannibal-locale@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const rows = [
      { keys: ['pricing', 'https://example.com/de/pricing'], impressions: 400 },
      { keys: ['pricing', 'https://example.com/de/preise'], impressions: 200 },
      { keys: ['pricing', 'https://example.com/en/pricing'], impressions: 700 },
      { keys: ['support', 'https://example.com/de/support'], impressions: 200 },
      { keys: ['support', 'https://example.com/en/support'], impressions: 250 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toBe(
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
        );
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: Array<{ filters: Array<{ dimension: string; operator: string; expression: string }> }>;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        requests += 1;
        const filter = body.dimensionFilterGroups?.[0]?.filters?.[0];
        if (requests === 1) {
          expect(filter).toEqual({ dimension: 'page', operator: 'contains', expression: '/de/' });
        } else {
          expect(filter).toBeUndefined();
        }
        return response({
          rows: filter
            ? rows.filter((row) => row.keys[1].toLowerCase().includes(filter.expression.toLowerCase()))
            : rows,
        });
      };

      const filtered = (await registered['insights.cannibalization'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        page_contains: '/de/',
        limit: 20,
        start_row: 0,
      })) as {
        structuredContent: {
          page_contains: string | null;
          scope_note: string;
          candidates: Array<{ query: string; total_impressions: number; page_count: number; pages: Array<{ page: string; impression_share: number }> }>;
        };
      };
      expect(filtered.structuredContent.page_contains).toBe('/de/');
      expect(filtered.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(filtered.structuredContent.candidates).toHaveLength(1);
      expect(filtered.structuredContent.candidates[0]).toMatchObject({
        query: 'pricing', total_impressions: 600, page_count: 2,
      });
      expect(filtered.structuredContent.candidates[0].pages.map((page) => page.impression_share)).toEqual([66.7, 33.3]);

      const unfiltered = (await registered['insights.cannibalization'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        limit: 20,
        start_row: 0,
      })) as { structuredContent: { page_contains: string | null; candidates: Array<{ query: string }> } };
      expect(unfiltered.structuredContent.page_contains).toBeNull();
      expect(unfiltered.structuredContent.candidates.map((candidate) => candidate.query)).toEqual(['pricing', 'support']);
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves positionless competing-page evidence in cannibalization tool responses', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-positionless-user', email: 'cannibal-positionless@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        expect(requestUrl(input)).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
        requests += 1;
        return response({ rows: [
          { keys: ['shared intent', 'https://example.com/a'], clicks: 20, impressions: 100, ctr: 0.2, position: 8 },
          { keys: ['shared intent', 'https://example.com/b'], clicks: 4, impressions: 80, ctr: 0.05 },
        ] });
      };
      const result = (await registered['insights.cannibalization'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 50,
        min_page_percentage: 10,
      })) as { structuredContent: {
        candidates: Array<{ total_clicks: number; total_impressions: number; pages: Array<{ position: number | null }> }>;
      } };
      expect(result.structuredContent.candidates).toHaveLength(1);
      expect(result.structuredContent.candidates[0]).toMatchObject({ total_clicks: 24, total_impressions: 180 });
      expect(result.structuredContent.candidates[0].pages.map((page) => page.position)).toEqual([8, null]);
      expect(requests).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters cannibalization query topics at Google before pagination and combines URL scope', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-topic-user', email: 'cannibal-topic@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      groupType?: string;
      filters: Array<{ dimension: string; operator: string; expression: string }>;
    } | undefined> = [];
    const rows = [
      { keys: ['pricing calculator', 'https://example.com/de/pricing'], impressions: 400 },
      { keys: ['pricing calculator', 'https://example.com/de/preise'], impressions: 200 },
      { keys: ['pricing calculator', 'https://example.com/en/pricing'], impressions: 700 },
      { keys: ['support options', 'https://example.com/de/support'], impressions: 250 },
      { keys: ['support options', 'https://example.com/en/support'], impressions: 200 },
    ].map((row) => ({ ...row, clicks: 10, ctr: 0.05, position: 12 }));
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toBe(
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
        );
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: typeof requests;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        const group = body.dimensionFilterGroups?.[0];
        requests.push(group);
        const filteredRows = rows.filter((row) => (group?.filters ?? []).every((filter) => {
          const value = row.keys[filter.dimension === 'query' ? 0 : 1];
          return filter.operator === 'contains' && value.toLowerCase().includes(filter.expression.toLowerCase());
        }));
        return response({ rows: filteredRows });
      };

      const args = {
        site_url: 'sc-domain:example.com',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        min_impressions: 1,
        min_page_percentage: 1,
        limit: 20,
        start_row: 0,
      };
      const scoped = (await registered['insights.cannibalization'].handler({
        ...args, page_contains: '/de/', query_contains: 'PRICING',
      })) as { structuredContent: { candidates: Array<{ query: string; page_count: number; total_impressions: number }> } };
      expect(requests[0]).toEqual({
        groupType: 'and',
        filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'query', operator: 'contains', expression: 'PRICING' },
        ],
      });
      expect(scoped.structuredContent.candidates).toMatchObject([
        { query: 'pricing calculator', page_count: 2, total_impressions: 600 },
      ]);

      const queryOnly = (await registered['insights.cannibalization'].handler({
        ...args, query_contains: 'PRICING',
      })) as { structuredContent: { candidates: Array<{ query: string; page_count: number }> } };
      expect(requests[1]).toEqual({
        groupType: 'and',
        filters: [{ dimension: 'query', operator: 'contains', expression: 'PRICING' }],
      });
      expect(queryOnly.structuredContent.candidates[0]).toMatchObject({
        query: 'pricing calculator', page_count: 3,
      });

      const defaultResult = (await registered['insights.cannibalization'].handler(args)) as {
        structuredContent: { candidates: Array<{ query: string }> };
      };
      expect(requests[2]).toBeUndefined();
      expect(defaultResult.structuredContent.candidates).toHaveLength(2);
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters cannibalization by searcher country alongside locale and query before pagination', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-country-user', email: 'cannibal-country@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ groupType: string; filters: Array<{ dimension: string; operator: string; expression: string }> } | undefined> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toBe(
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
        );
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          dimensionFilterGroups?: typeof requests;
        };
        expect(body.dimensions).toEqual(['query', 'page']);
        requests.push(body.dimensionFilterGroups?.[0]);
        return response({ rows: [
          { keys: ['pricing', 'https://example.com/de/pricing'], impressions: 250, clicks: 15, ctr: 0.06, position: 11 },
          { keys: ['pricing', 'https://example.com/de/preise'], impressions: 150, clicks: 10, ctr: 0.067, position: 12 },
        ] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 1, min_page_percentage: 1, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.cannibalization'].handler({
        // Direct handler invocation bypasses MCP's Zod trim; test normalized input separately.
        ...args, page_contains: '/de/', query_contains: 'pricing', country: 'deu',
      })) as { structuredContent: { country: string | null; scope_note: string; candidates: Array<{ page_count: number }> } };
      expect(requests[0]).toEqual({
        groupType: 'and',
        filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'query', operator: 'contains', expression: 'pricing' },
          { dimension: 'country', operator: 'equals', expression: 'DEU' },
        ],
      });
      expect(scoped.structuredContent.country).toBe('DEU');
      expect(scoped.structuredContent.scope_note).toMatch(/searcher country/i);
      expect(scoped.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(scoped.structuredContent.candidates[0].page_count).toBe(2);

      const unfiltered = (await registered['insights.cannibalization'].handler(args)) as {
        structuredContent: { country: string | null };
      };
      expect(requests[1]).toBeUndefined();
      expect(unfiltered.structuredContent.country).toBeNull();
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves combined country/device scope in one cannibalization request without inventing market attribution', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-combined-user', email: 'cannibal-combined@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ rows: [
          { keys: ['seo', 'https://example.com/de/seo'], impressions: 300, clicks: 15, ctr: 0.05, position: 9 },
          { keys: ['seo', 'https://example.com/en/seo'], impressions: 150, clicks: 6, ctr: 0.04, position: 12 },
        ] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 1, min_page_percentage: 1, limit: 20, start_row: 0,
      };
      const combined = (await registered['insights.cannibalization'].handler({
        ...args, query_contains: 'seo', countries: ['deu', 'USA'], devices: ['mobile', 'desktop'],
      })) as { structuredContent: {
        country: string | null; device: string | null; countries: string[]; devices: string[];
        scope_note: string; candidates: Array<{ page_count: number }>;
      } };
      expect(requests).toHaveLength(1);
      expect(requests[0].dimensionFilterGroups).toEqual([{
        groupType: 'and',
        filters: [{ dimension: 'query', operator: 'contains', expression: 'seo' }],
        filterLists: [
          { dimension: 'country', expressions: ['DEU', 'USA'] },
          { dimension: 'device', expressions: ['MOBILE', 'DESKTOP'] },
        ],
      }]);
      expect(combined.structuredContent.country).toBeNull();
      expect(combined.structuredContent.device).toBeNull();
      expect(combined.structuredContent.countries).toEqual(['DEU', 'USA']);
      expect(combined.structuredContent.devices).toEqual(['mobile', 'desktop']);
      expect(combined.structuredContent.scope_note).toMatch(/one combined segment/i);
      expect(combined.structuredContent.scope_note).toMatch(/not independent.*attribution/i);
      expect(combined.structuredContent.candidates[0].page_count).toBe(2);
      const mixed = await registered['insights.cannibalization'].handler({
        ...args, country: 'DEU', countries: ['USA'],
      }) as { isError?: boolean };
      expect(mixed.isError).toBe(true);
      expect(requests).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves device scope when investigating query/page overlap', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-device-user', email: 'cannibal-device@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Array<{ dimension: string; operator: string; expression: string }> | undefined> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          dimensionFilterGroups?: Array<{ groupType: string; filters: Array<{ dimension: string; operator: string; expression: string }> }>;
        };
        if (body.dimensionFilterGroups?.length) expect(body.dimensionFilterGroups[0].groupType).toBe('and');
        requests.push(body.dimensionFilterGroups?.[0]?.filters);
        return response({ rows: [
          { keys: ['pricing', 'https://example.com/de/pricing'], impressions: 250, clicks: 15, ctr: 0.06, position: 11 },
          { keys: ['pricing', 'https://example.com/de/preise'], impressions: 150, clicks: 10, ctr: 0.067, position: 12 },
        ] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 1, min_page_percentage: 1, limit: 20, start_row: 0,
      };
      const scoped = (await registered['insights.cannibalization'].handler({
        ...args, page_contains: '/de/', query_contains: 'pricing', country: 'deu', device: 'mobile',
      })) as { structuredContent: { device: string | null; scope_note: string; candidates: Array<{ page_count: number }> } };
      expect(requests[0]).toEqual([
        { dimension: 'page', operator: 'contains', expression: '/de/' },
        { dimension: 'query', operator: 'contains', expression: 'pricing' },
        { dimension: 'country', operator: 'equals', expression: 'DEU' },
        { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
      ]);
      expect(scoped.structuredContent.device).toBe('mobile');
      expect(scoped.structuredContent.scope_note).toMatch(/device/i);
      expect(scoped.structuredContent.scope_note).toMatch(/not property-wide/i);
      expect(scoped.structuredContent.candidates[0].page_count).toBe(2);
      const allDevices = (await registered['insights.cannibalization'].handler(args)) as { structuredContent: { device: string | null } };
      expect(requests[1]).toBeUndefined();
      expect(allDevices.structuredContent.device).toBeNull();
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps Image/Video/News-tab cannibalization on its selected search surface', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'cannibal-surface-user', email: 'cannibal-surface@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ rows: [
          { keys: ['visual seo', 'https://example.com/de/visual'], impressions: 230, clicks: 12, ctr: 0.052, position: 11 },
          { keys: ['visual seo', 'https://example.com/de/gallery'], impressions: 130, clicks: 6, ctr: 0.046, position: 13 },
        ] });
      };
      const args = {
        site_url: 'sc-domain:example.com', start_date: '2026-07-01', end_date: '2026-07-31',
        min_impressions: 1, min_page_percentage: 1, limit: 20, start_row: 0,
      };
      const image = (await registered['insights.cannibalization'].handler({
        ...args, search_type: 'image', page_contains: '/de/', query_contains: 'visual', country: 'deu', device: 'mobile',
      })) as { structuredContent: { search_type: string; scope_note: string; candidates: Array<{ page_count: number }> } };
      expect(requests[0].type).toBe('image');
      expect(requests[0].dimensions).toEqual(['query', 'page']);
      expect(requests[0].dimensionFilterGroups).toEqual([{
        groupType: 'and', filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'query', operator: 'contains', expression: 'visual' },
          { dimension: 'country', operator: 'equals', expression: 'DEU' },
          { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
        ],
      }]);
      expect(image.structuredContent.search_type).toBe('image');
      expect(image.structuredContent.scope_note).toMatch(/Image.*not.*all-search|Image.*not property-wide/i);
      expect(image.structuredContent.candidates[0].page_count).toBe(2);

      for (const search_type of ['video', 'news']) {
        const scoped = (await registered['insights.cannibalization'].handler({
          ...args, search_type,
        })) as { structuredContent: { search_type: string; candidates: Array<{ page_count: number }> } };
        expect(requests[requests.length - 1].type).toBe(search_type);
        expect(scoped.structuredContent.search_type).toBe(search_type);
        expect(scoped.structuredContent.candidates[0].page_count).toBe(2);
      }

      const web = (await registered['insights.cannibalization'].handler(args)) as { structuredContent: { search_type: string } };
      expect(requests[3].type).toBeUndefined();
      expect(web.structuredContent.search_type).toBe('web');
      expect(requests).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves multi-country and multi-device content-decay scope across both periods', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'decay-multimarket-user', email: 'decay-multimarket@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const tool = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<{
          isError?: boolean;
          content: Array<{ text: string }>;
          structuredContent: { countries: string[] | null; devices: string[] | null; scope_note: string };
        }>;
      }>;
    })._registeredTools['insights.content_decay'];
    const originalFetch = globalThis.fetch;
    const requests: Array<{ dimensionFilterGroups?: unknown[] }> = [];
    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return response({ rows: [{
          keys: ['https://example.com/de/guide'], clicks: requests.length === 1 ? 8 : 35,
          impressions: requests.length === 1 ? 200 : 500, ctr: 0.04, position: 9,
        }] });
      };
      const result = await tool.handler({
        site_url: 'sc-domain:example.com', compare_days: 14,
        page_contains: '/de/', countries: ['deu', 'aut'], devices: ['desktop', 'mobile'],
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.countries).toEqual(['DEU', 'AUT']);
      expect(result.structuredContent.devices).toEqual(['desktop', 'mobile']);
      expect(result.structuredContent.scope_note).toMatch(/combined|OR within/i);
      expect(requests).toHaveLength(2);
      const expectedFilters = [{
        groupType: 'and',
        filters: [{ dimension: 'page', operator: 'contains', expression: '/de/' }],
        filterLists: [
          { dimension: 'country', expressions: ['DEU', 'AUT'] },
          { dimension: 'device', expressions: ['DESKTOP', 'MOBILE'] },
        ],
      }];
      expect(requests[0].dimensionFilterGroups).toEqual(expectedFilters);
      expect(requests[1].dimensionFilterGroups).toEqual(expectedFilters);
      const mixedCountry = await tool.handler({ site_url: 'sc-domain:example.com', country: 'DEU', countries: ['AUT'] });
      const mixedDevice = await tool.handler({ site_url: 'sc-domain:example.com', device: 'mobile', devices: ['desktop'] });
      expect(mixedCountry.isError).toBe(true);
      expect(mixedDevice.isError).toBe(true);
      expect(requests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('focuses content decay on one locale without treating other pages as missing data', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'decay-locale-user', email: 'decay-locale@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let searchRequests = 0;
    let expectedSearchType = 'image';
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url !== 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          throw new Error(`Unexpected outbound request: ${url}`);
        }
        const body = JSON.parse(String(init?.body)) as {
          dimensions: string[];
          type?: string;
          dimensionFilterGroups?: Array<{
            groupType: string;
            filters: Array<{ dimension: string; operator: string; expression: string }>;
          }>;
        };
        expect(body.dimensions).toEqual(['page']);
        expect(body.type).toBe(expectedSearchType);
        if (expectedSearchType === 'image') {
          expect(body.dimensionFilterGroups).toEqual([{
            groupType: 'and',
            filters: [
              { dimension: 'page', operator: 'contains', expression: '/DE/' },
              { dimension: 'query', operator: 'contains', expression: 'TECHNICAL SEO' },
              { dimension: 'country', operator: 'equals', expression: 'DEU' },
              { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
            ],
          }]);
        } else if (expectedSearchType === 'news') {
          expect(body.dimensionFilterGroups).toEqual([{
            groupType: 'and',
            filters: [{ dimension: 'query', operator: 'contains', expression: 'seo' }],
          }]);
        } else {
          expect(body.dimensionFilterGroups).toBeUndefined();
        }
        searchRequests += 1;
        const recent = searchRequests % 2 === 1;
        return response({
          rows: (expectedSearchType === 'image'
            ? ['/de/pricing']
            : ['/de/pricing', '/en/pricing']).map((path) => ({
            keys: [`https://example.com${path}`],
            clicks: recent ? 12 : 100,
            impressions: recent ? 400 : 1000,
            ctr: recent ? 0.03 : 0.1,
            position: expectedSearchType === 'image' && recent ? undefined : recent ? 12 : 4,
          })),
        });
      };

      const result = (await registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com',
        compare_days: 14,
        search_type: 'image',
        page_contains: '/DE/',
        query_contains: 'TECHNICAL SEO',
        country: 'deu',
        device: 'mobile',
        limit: 20,
        start_row: 0,
      })) as {
        structuredContent: {
          site_url: string;
          search_type: string;
          page_contains: string | null;
          query_contains: string | null;
          country: string | null;
          device: string | null;
          scope_note: string;
          decay_results: Array<{ page: string; previous_clicks: number; recent_clicks: number; previous_position: number | null; recent_position: number | null; position_change: number | null }>;
          assessment_count: number;
          observed_page_overlap: { comparable_count: number };
          result_page: { total_count: number; has_more: boolean };
        };
      };

      expect(result.structuredContent.decay_results).toHaveLength(1);
      expect(result.structuredContent.site_url).toBe('sc-domain:example.com');
      expect(result.structuredContent.search_type).toBe('image');
      expect(result.structuredContent.page_contains).toBe('/DE/');
      expect(result.structuredContent.query_contains).toBe('TECHNICAL SEO');
      expect(result.structuredContent.country).toBe('DEU');
      expect(result.structuredContent.device).toBe('mobile');
      expect(result.structuredContent.scope_note).toContain('not property-wide totals');
      expect(result.structuredContent.scope_note).toMatch(/searcher country/i);
      expect(result.structuredContent.scope_note).toMatch(/device/i);
      expect(result.structuredContent.decay_results[0]).toMatchObject({
        page: 'https://example.com/de/pricing',
        previous_clicks: 100,
        recent_clicks: 12,
        previous_position: 4,
        recent_position: null,
        position_change: null,
      });
      expect(result.structuredContent.assessment_count).toBe(1);
      expect(result.structuredContent.observed_page_overlap.comparable_count).toBe(1);
      expect(result.structuredContent.result_page.has_more).toBe(false);
      expect(searchRequests).toBe(2);

      expectedSearchType = 'web';
      const defaultResult = (await registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com',
        compare_days: 14,
        limit: 20,
        start_row: 0,
      })) as { structuredContent: { search_type: string; page_contains: string | null; query_contains: string | null; country: string | null; device: string | null; decay_results: unknown[] } };
      expect(defaultResult.structuredContent.search_type).toBe('web');
      expect(defaultResult.structuredContent.page_contains).toBeNull();
      expect(defaultResult.structuredContent.query_contains).toBeNull();
      expect(defaultResult.structuredContent.country).toBeNull();
      expect(defaultResult.structuredContent.device).toBeNull();
      expect(defaultResult.structuredContent.decay_results).toHaveLength(2);
      expect(searchRequests).toBe(4);

      expectedSearchType = 'news';
      const queryOnlyResult = (await registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com', compare_days: 14, search_type: 'news', query_contains: 'seo',
      })) as { structuredContent: { query_contains: string; page_contains: string | null; scope_note: string } };
      expect(queryOnlyResult.structuredContent.query_contains).toBe('seo');
      expect(queryOnlyResult.structuredContent.page_contains).toBeNull();
      expect(queryOnlyResult.structuredContent.scope_note).toContain('not property-wide totals');
      expect(searchRequests).toBe(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters content decay by observed classification without hiding source coverage', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'decay-classification-user', email: 'decay-classification@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        expect(requestUrl(input)).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
        requests += 1;
        const recent = requests % 2 === 1;
        return response({ rows: [
          { keys: ['https://example.com/declining'], clicks: recent ? 50 : 100,
            impressions: recent ? 600 : 1000, ctr: 0.08, position: recent ? 10 : 4 },
          { keys: ['https://example.com/volatile'], clicks: recent ? 6 : 8,
            impressions: 100, ctr: 0.06, position: 5 },
          { keys: ['https://example.com/improving'], clicks: recent ? 3 : 5,
            impressions: recent ? 150 : 100, ctr: 0.02, position: recent ? 7 : 10 },
        ] });
      };

      const analyze = async (classification_filter?: string) => {
        const result = await registered['insights.content_decay'].handler({
          site_url: 'sc-domain:example.com', compare_days: 14,
          ...(classification_filter ? { classification_filter } : {}),
        });
        return (result as { structuredContent: {
          classification_filter: string;
          min_click_loss: number | null;
          assessment_count: number;
          decay_count: number;
          decay_results: Array<{ page: string; classification: string }>;
          observed_page_overlap: { comparable_count: number };
          result_page: { total_count: number };
        } }).structuredContent;
      };

      const all = await analyze();
      expect(all.classification_filter).toBe('all');
      expect(all.decay_results.map((r) => r.classification)).toEqual([
        'likely_decay', 'weak_insufficient_evidence', 'improving_visibility_with_click_volatility',
      ]);
      const likely = await analyze('likely_decay');
      expect(likely.classification_filter).toBe('likely_decay');
      expect(likely.decay_results.map((r) => r.page)).toEqual(['https://example.com/declining']);
      expect(likely.result_page.total_count).toBe(1);
      expect(likely.assessment_count).toBe(3);
      expect(likely.decay_count).toBe(1);
      expect(likely.observed_page_overlap.comparable_count).toBe(3);
      const improving = await analyze('improving_visibility_with_click_volatility');
      expect(improving.decay_results.map((r) => r.page)).toEqual(['https://example.com/improving']);
      expect(all.min_click_loss).toBeNull();
      expect(requests).toBe(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('focuses observed click declines by absolute impact without changing coverage counts', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'decay-impact-user', email: 'decay-impact@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async () => {
        requests += 1;
        const recent = requests % 2 === 1;
        return response({ rows: [
          { keys: ['https://example.com/high-impact'], clicks: recent ? 50 : 100,
            impressions: recent ? 600 : 1000, ctr: 0.08, position: recent ? 10 : 4 },
          { keys: ['https://example.com/small-change'], clicks: recent ? 8 : 10,
            impressions: 200, ctr: 0.04, position: 7 },
        ] });
      };
      const analyze = async (min_click_loss: number, classification_filter?: string) => {
        const result = await registered['insights.content_decay'].handler({
          site_url: 'sc-domain:example.com', compare_days: 14, min_click_loss,
          ...(classification_filter ? { classification_filter } : {}),
        });
        return (result as { structuredContent: {
          min_click_loss: number;
          assessment_count: number;
          decay_count: number;
          observed_click_loss: { all_declining_pages: number; likely_decay_pages: number; note: string };
          decay_results: Array<{ page: string }>;
          observed_page_overlap: { comparable_count: number };
          result_page: { total_count: number };
        } }).structuredContent;
      };
      const prioritized = await analyze(20);
      expect(prioritized.min_click_loss).toBe(20);
      expect(prioritized.decay_results.map((row) => row.page)).toEqual(['https://example.com/high-impact']);
      expect(prioritized.result_page.total_count).toBe(1);
      expect(prioritized.assessment_count).toBe(2);
      expect(prioritized.decay_count).toBe(1);
      expect(prioritized.observed_click_loss.all_declining_pages).toBe(52);
      expect(prioritized.observed_click_loss.likely_decay_pages).toBe(50);
      expect(prioritized.observed_click_loss.note).toContain('not property-wide');
      expect((prioritized as unknown as { observed_click_gain: { all_gaining_pages: number; gaining_page_count: number } }).observed_click_gain).toMatchObject({
        all_gaining_pages: 0, gaining_page_count: 0,
      });
      expect(prioritized.observed_page_overlap.comparable_count).toBe(2);
      const zero = await analyze(0);
      expect(zero.min_click_loss).toBe(0);
      expect(zero.decay_results).toHaveLength(2);
      expect(zero.observed_click_loss).toEqual(prioritized.observed_click_loss);
      const combined = await analyze(20, 'weak_insufficient_evidence');
      expect(combined.decay_results).toHaveLength(0);
      expect(combined.assessment_count).toBe(2);
      expect(combined.result_page.total_count).toBe(0);
      expect(combined.observed_click_loss).toEqual(prioritized.observed_click_loss);
      expect(requests).toBe(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports observed gains across comparable page rows even without position data', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'decay-gains-user', email: 'decay-gains@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async () => {
        requests += 1;
        const recent = requests % 2 === 1;
        const amounts = recent
          ? [['/gaining', 18], ['/declining', 8], ['/stable', 7], ['/recent-only', 90], ['/no-position', 100]] as const
          : [['/gaining', 5], ['/declining', 20], ['/stable', 7], ['/previous-only', 80], ['/no-position', 1]] as const;
        return response({ rows: amounts.map(([path, clicks]) => ({
          keys: [`https://example.com${path}`], clicks, impressions: 200,
          ctr: clicks / 200, position: path === '/no-position' ? undefined : 7,
        })) });
      };
      const analyze = async (min_click_loss?: number) => {
        const result = await registered['insights.content_decay'].handler({
          site_url: 'sc-domain:example.com', compare_days: 14,
          ...(min_click_loss === undefined ? {} : { min_click_loss }),
        });
        return (result as { structuredContent: {
          observed_click_gain: { all_gaining_pages: number; gaining_page_count: number; note: string };
          observed_click_loss: { all_declining_pages: number };
          observed_page_overlap: { comparable_count: number };
          assessment_count: number;
          decay_results: Array<{ page: string }>;
        } }).structuredContent;
      };
      const all = await analyze();
      expect(all.observed_click_gain.all_gaining_pages).toBe(112);
      expect(all.observed_click_gain.gaining_page_count).toBe(2);
      expect(all.observed_click_gain.note).toContain('not property-wide');
      expect(all.observed_click_loss.all_declining_pages).toBe(12);
      expect(all.observed_page_overlap.comparable_count).toBe(4);
      expect(all.assessment_count).toBe(1);
      const filtered = await analyze(100);
      expect(filtered.decay_results).toEqual([]);
      expect(filtered.observed_click_gain).toEqual(all.observed_click_gain);
      expect(filtered.observed_click_loss).toEqual(all.observed_click_loss);
      expect(requests).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('distinguishes observed missing-period pages from comparable content-decay rows', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'decay-overlap-user', email: 'decay-overlap@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        expect(requestUrl(input)).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
        requests += 1;
        const paths = requests === 1
          ? ['/shared', '/recent-only']
          : ['/shared', '/previous-only'];
        return response({ rows: paths.map((path) => ({
          keys: [`https://example.com${path}`],
          clicks: requests === 1 ? 10 : 50,
          impressions: requests === 1 ? 100 : 500,
          ctr: 0.1,
          position: requests === 1 ? 12 : 4,
        })) });
      };
      const result = (await registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com',
        compare_days: 14,
      })) as { structuredContent: {
        assessment_count: number;
        decay_results: Array<{ page: string }>;
        observed_page_overlap: {
          recent_count: number;
          previous_count: number;
          comparable_count: number;
          recent_only_count: number;
          previous_only_count: number;
          note: string;
        };
      } };

      expect(result.structuredContent.observed_page_overlap).toMatchObject({
        recent_count: 2,
        previous_count: 2,
        comparable_count: 1,
        recent_only_count: 1,
        previous_only_count: 1,
      });
      expect(result.structuredContent.observed_page_overlap.note).toMatch(/not.*zero traffic/i);
      expect(result.structuredContent.assessment_count).toBe(1);
      expect(result.structuredContent.decay_results.map((row) => row.page)).toEqual([
        'https://example.com/shared',
      ]);
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('anchors content decay to a historical finalized end date and rejects unavailable periods', async () => {
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'historical-decay-user', email: 'historical-decay@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const today = getSearchConsoleCalendarDate();
    const daysAgo = (days: number) => {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - days);
      return date.toISOString().slice(0, 10);
    };
    const sourceRequests: Array<{ startDate: string; endDate: string }> = [];
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
        const body = JSON.parse(String(init?.body)) as { startDate: string; endDate: string };
        sourceRequests.push({ startDate: body.startDate, endDate: body.endDate });
        return response({ rows: [{
          keys: ['https://example.com/de/guide'],
          clicks: 12, impressions: 500, ctr: 0.024, position: 12,
        }] });
      };
      const result = (await registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com', compare_days: 7, end_date: daysAgo(35),
      })) as { structuredContent: {
        comparison_periods: { recent: { start: string; end: string }; previous: { start: string; end: string } };
      } };
      expect(result.structuredContent.comparison_periods).toEqual({
        recent: { start: daysAgo(41), end: daysAgo(35) },
        previous: { start: daysAgo(48), end: daysAgo(42) },
      });
      expect(sourceRequests).toEqual([
        { startDate: daysAgo(41), endDate: daysAgo(35) },
        { startDate: daysAgo(48), endDate: daysAgo(42) },
      ]);
      await expect(registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com', compare_days: 7, end_date: today,
      })).rejects.toThrow(/finalized/i);
      await expect(registered['insights.content_decay'].handler({
        site_url: 'sc-domain:example.com', compare_days: 7, end_date: '2020-01-01',
      })).rejects.toThrow(/16.month/i);
      expect(sourceRequests).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks indexing.list_pages terminal after a short non-empty Search Analytics page', async () => {
    await saveUser(
      workerEnv,
      'short-list-user',
      'short-list@example.test',
      'short-list-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'short-list-user',
        email: 'short-list@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const registered = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'short-list-access-token', expires_in: 3600 });
        }
        if (
          url ===
          'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query'
        ) {
          const body = JSON.parse(String(init?.body)) as {
            startRow?: number;
            rowLimit: number;
          };
          expect(body.rowLimit).toBe(500);
          if ((body.startRow ?? 0) === 500) {
            return response({ rows: [] });
          }
          expect(body.startRow ?? 0).toBe(0);
          return response({
            rows: [
              {
                keys: ['https://example.com/short-provider-page/'],
                clicks: 3,
                impressions: 30,
                ctr: 0.1,
                position: 7,
              },
              {
                keys: ['https://example.com/observed-without-position/'],
                clicks: 5,
                impressions: 50,
                ctr: 0.1,
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const first = (await registered['indexing.list_pages'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        row_limit: 1000,
        start_row: 0,
      })) as {
        structuredContent: {
          pages: Array<{ page: string; clicks: number; impressions: number; position: number | null }>;
          result_page: { has_more: boolean; next_start_row?: number };
        };
      };
      expect(first.structuredContent.pages[0]?.page).toBe(
        'https://example.com/short-provider-page/',
      );
      expect(first.structuredContent.pages).toHaveLength(2);
      expect(first.structuredContent.pages[1]).toMatchObject({
        page: 'https://example.com/observed-without-position/',
        clicks: 5,
        impressions: 50,
        position: null,
      });
      expect(first.structuredContent.result_page).toMatchObject({
        has_more: false,
      });
      expect(first.structuredContent.result_page.next_start_row).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scopes search-visible pages to a URL section at Google before pagination', async () => {
    await saveUser(workerEnv, 'section-pages-user', 'section@example.test', 'section-refresh-token');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'section-pages-user', email: 'section@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const registered = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'section-pages-access', expires_in: 3600 });
        }
        if (url.endsWith('/searchAnalytics/query')) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          return response({
            rows: [{
              keys: ['https://example.com/de/guide/'],
              clicks: 4,
              impressions: 40,
              ctr: 0.1,
              position: 8,
            }],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const filtered = (await registered['indexing.list_pages'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        page_contains: '/de/',
        row_limit: 25,
        start_row: 12,
      })) as {
        structuredContent: {
          page_contains: string | null;
          pages: Array<{ page: string }>;
          result_page: { start_row: number; has_more: boolean };
        };
      };
      expect(requests[0]).toMatchObject({
        dimensions: ['page'],
        rowLimit: 25,
        startRow: 12,
        dimensionFilterGroups: [{
          groupType: 'and',
          filters: [{ dimension: 'page', operator: 'contains', expression: '/de/' }],
        }],
      });
      expect(filtered.structuredContent.page_contains).toBe('/de/');
      expect(filtered.structuredContent.pages[0]?.page).toBe('https://example.com/de/guide/');
      expect(filtered.structuredContent.result_page).toMatchObject({ start_row: 12, has_more: false });

      const unfiltered = (await registered['indexing.list_pages'].handler({
        site_url: 'sc-domain:example.com',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        row_limit: 25,
      })) as { structuredContent: { page_contains: string | null } };
      expect(requests).toHaveLength(2);
      expect(requests[1]).not.toHaveProperty('dimensionFilterGroups');
      expect(unfiltered.structuredContent.page_contains).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forwards native branded classification grouping and filters without extra provider reads', async () => {
    await saveUser(workerEnv, 'native-brand-user', 'brand@example.test', 'brand-refresh-token');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'native-brand-user', email: 'brand@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    const filters = [{ groupType: 'and', filters: [{
      dimension: 'brandedClassification', operator: 'equals', expression: 'NON_BRANDED',
    }] }];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'native-brand-access', expires_in: 3600 });
        }
        if (url.endsWith('/searchAnalytics/query')) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          return response({ rows: [{
            keys: (body.dimensions as string[])[0] === 'brandedClassification'
              ? ['NON_BRANDED'] : ['https://example.com/page'],
            clicks: 7, impressions: 70, ctr: 0.1, position: 3,
          }] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const direct = (await tools['analytics.query'].handler({
        site_url: 'sc-domain:example.com', start_date: '2026-06-01', end_date: '2026-06-07',
        dimensions: ['brandedClassification'], row_limit: 10, start_row: 0,
        data_state: 'final', search_type: 'web', aggregation_type: 'auto',
        dimension_filter_groups: filters,
      })) as { structuredContent: { rows: Array<{ keys: string[] }>; dimensions: string[] } };
      expect(direct.structuredContent.dimensions).toEqual(['brandedClassification']);
      expect(direct.structuredContent.rows[0]?.keys).toEqual(['NON_BRANDED']);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        dimensions: ['brandedClassification'], dimensionFilterGroups: filters,
      });

      await tools['analytics.compare'].handler({
        site_url: 'sc-domain:example.com', start_date_a: '2026-06-01', end_date_a: '2026-06-07',
        start_date_b: '2026-05-25', end_date_b: '2026-05-31', dimension: 'page',
        search_type: 'web', data_state: 'final', dimension_filter_groups: filters,
      });
      expect(requests).toHaveLength(3);
      expect(requests.slice(1).every((request) =>
        JSON.stringify(request.dimensionFilterGroups) === JSON.stringify(filters))).toBe(true);
      await expect(tools['analytics.query'].handler({
        site_url: 'sc-domain:example.com', start_date: '2026-06-01', end_date: '2026-06-07',
        dimensions: ['brandedClassification'], row_limit: 10, start_row: 0,
        data_state: 'final', search_type: 'web', aggregation_type: 'auto',
        dimension_filter_groups: [{ groupType: 'and', filters: [{
          dimension: 'query', operator: 'contains', expression: 'example',
        }] }],
      })).rejects.toThrow(/brandedClassification.*query filter/);
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('applies the same Search Analytics segment to both comparison periods', async () => {
    await saveUser(
      workerEnv,
      'compare-user',
      'compare@example.test',
      'compare-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'compare-user',
        email: 'compare@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const analyticsRequests: Array<Record<string, unknown>> = [];
    const filters = [
      {
        groupType: 'and',
        filters: [
          {
            dimension: 'query',
            operator: 'includingRegex',
            expression: 'example|brand',
          },
        ],
      },
    ];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'compare-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          analyticsRequests.push(body);
          if ((body.startRow as number | undefined ?? 0) > 0) {
            return response({ rows: [] });
          }
          return response({
            rows: [
              {
                keys: ['example query'],
                clicks: 10,
                impressions: 100,
                ctr: 0.1,
                position: 5,
              },
              {
                keys: [body.startDate === '2026-09-01' ? 'recent only' : 'previous only'],
                clicks: 2,
                impressions: 30,
                ctr: 0.067,
                position: 9,
              },
              ...(body.startDate === '2026-09-01'
                ? [
                    { keys: ['not-comparable'], clicks: 2, impressions: 30, ctr: 0.067 },
                    { keys: ['highest only'], clicks: 7, impressions: 80, ctr: 0.0875 },
                    { keys: ['small only'], clicks: 0, impressions: 1, ctr: 0 },
                  ]
                : []),
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const result = (await tools['analytics.compare'].handler({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01',
        end_date_a: '2026-09-07',
        start_date_b: '2026-08-25',
        end_date_b: '2026-08-31',
        dimension: 'query',
        search_type: 'image',
        data_state: 'final',
        dimension_filter_groups: filters,
      })) as {
        structuredContent: {
          site_url: string;
          data_state: string;
          preliminary_data_possible: boolean;
          comparison_note: string;
          comparisons: Array<{ key: string }>;
          observed_common_rows_daily_average: {
            period_a: { clicks: number; impressions: number };
            period_b: { clicks: number; impressions: number };
            diff: { clicks: number; impressions: number };
            note: string;
          };
          period_comparability: {
            period_a_days: number;
            period_b_days: number;
            equal_length: boolean;
            periods_overlap: boolean;
            note: string;
          };
          observed_dimension_overlap: {
            period_a_count: number;
            period_b_count: number;
            comparable_count: number;
            period_a_only_count: number;
            period_b_only_count: number;
            period_a_only_samples: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number | null }>;
            period_b_only_samples: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number | null }>;
            note: string;
          };
        };
      };

      expect(analyticsRequests).toHaveLength(2);
      expect(analyticsRequests.map((request) => request.startRow ?? 0)).toEqual([
        0,
        0,
      ]);
      expect(analyticsRequests.map((request) => request.type)).toEqual([
        'image',
        'image',
      ]);
      expect(analyticsRequests.map((request) => request.dataState)).toEqual([
        'final',
        'final',
      ]);
      expect(
        analyticsRequests.map((request) => request.dimensionFilterGroups),
      ).toEqual([filters, filters]);
      expect(analyticsRequests.map((request) => request.dimensions)).toEqual([
        ['query'],
        ['query'],
      ]);
      expect(analyticsRequests.map((request) => request.startDate)).toEqual([
        '2026-09-01',
        '2026-08-25',
      ]);
      expect(result.structuredContent).toMatchObject({
        site_url: 'sc-domain:example.com',
        data_state: 'final',
        preliminary_data_possible: false,
      });
      expect(result.structuredContent.comparisons.map((item) => item.key)).toEqual(['example query']);
      expect(result.structuredContent.observed_dimension_overlap).toMatchObject({
        // Positionless rows are still observed keys, even if absent in the other period.
        period_a_count: 5,
        period_b_count: 2,
        comparable_count: 1,
        period_a_only_count: 4,
        period_b_only_count: 1,
        sample_limit: 3,
      });
      expect(result.structuredContent.observed_dimension_overlap.note).toContain('not zero');
      expect(result.structuredContent.observed_dimension_overlap.period_a_only_samples).toEqual([
        { key: 'highest only', clicks: 7, impressions: 80, ctr: 0.0875, position: null },
        { key: 'not-comparable', clicks: 2, impressions: 30, ctr: 0.067, position: null },
        { key: 'recent only', clicks: 2, impressions: 30, ctr: 0.067, position: 9 },
      ]);
      expect(result.structuredContent.observed_dimension_overlap.period_b_only_samples).toEqual([
        { key: 'previous only', clicks: 2, impressions: 30, ctr: 0.067, position: 9 },
      ]);
      const scopeNote = result.structuredContent.comparison_note;
      expect(scopeNote).toContain('site_url=sc-domain:example.com');
      expect(scopeNote).toContain('data_state=final');
      expect(scopeNote).toContain('dimension=query');
      expect(scopeNote).toContain('search_type=image');
      expect(scopeNote).toContain('period_a=2026-09-01..2026-09-07');
      expect(scopeNote).toContain('period_b=2026-08-25..2026-08-31');
      expect(scopeNote).toContain('dimension_filter_groups=1');
      expect(scopeNote).not.toContain('example|brand');
      expect(result.structuredContent.period_comparability).toMatchObject({
        period_a_days: 7,
        period_b_days: 7,
        equal_length: true,
        periods_overlap: false,
      });

      const unequal = (await tools['analytics.compare'].handler({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-08-18', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'image', data_state: 'final',
        observed_only_sample_limit: 5,
      })) as typeof result;
      expect(unequal.structuredContent.period_comparability).toMatchObject({
        period_a_days: 7,
        period_b_days: 14,
        equal_length: false,
        periods_overlap: false,
      });
      expect(unequal.structuredContent.period_comparability.note).toContain('not normalized per day');
      const normalized = unequal.structuredContent.observed_common_rows_daily_average;
      // Identical returned common-key totals across unequal windows have different daily rates.
      expect(normalized.period_a.clicks).toBeCloseTo(10 / 7);
      expect(normalized.period_b.clicks).toBeCloseTo(10 / 14);
      expect(normalized.diff.clicks).toBeCloseTo(10 / 7 - 10 / 14);
      expect(normalized.period_a.impressions).toBeCloseTo(100 / 7);
      expect(normalized.period_b.impressions).toBeCloseTo(100 / 14);
      expect(normalized.diff.impressions).toBeCloseTo(100 / 7 - 100 / 14);
      expect(normalized.note).toContain('not property-wide');
      expect(unequal.structuredContent.observed_dimension_overlap.period_a_only_samples.map((row) => row.key))
        .toEqual(['highest only', 'not-comparable', 'recent only', 'small only']);
      expect(unequal.structuredContent.observed_dimension_overlap.period_b_only_samples.map((row) => row.key))
        .toEqual(['previous only']);
      expect(unequal.structuredContent.observed_dimension_overlap.sample_limit).toBe(5);
      expect(unequal.structuredContent.observed_dimension_overlap.note).toContain('up to 5');

      const overlapping = (await tools['analytics.compare'].handler({
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-09-04', end_date_b: '2026-09-10',
        dimension: 'query', search_type: 'image', data_state: 'final',
      })) as typeof result;
      expect(overlapping.structuredContent.period_comparability).toMatchObject({
        period_a_days: 7,
        period_b_days: 7,
        equal_length: true,
        periods_overlap: true,
      });
      expect(overlapping.structuredContent.period_comparability.note).toContain('overlap');
      expect(analyticsRequests).toHaveLength(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('can rank observed comparison keys by daily click change without changing the default', async () => {
    await saveUser(workerEnv, 'daily-sort-user', 'daily-sort@example.test', 'daily-sort-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'daily-sort-user', email: 'daily-sort@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'daily-sort-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const recent = body.startDate === '2026-09-01';
          return response({ rows: [
            { keys: ['raw winner'], clicks: recent ? 10 : 70, impressions: recent ? 100 : 700, ctr: 0.1, position: 5 },
            { keys: ['daily winner'], clicks: recent ? 42 : 14, impressions: recent ? 420 : 140, ctr: 0.1, position: 5 },
          ] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-08-18', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'web', data_state: 'final',
      };
      type ComparisonResult = {
        structuredContent: {
          comparisons: Array<{ key: string }>;
          comparison_note: string;
          result_page: { next_start_row?: number };
        };
      };
      const defaultOrder = await tools['analytics.compare'].handler(args) as ComparisonResult;
      expect(defaultOrder.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['raw winner', 'daily winner']);
      const dailyOrder = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_daily_click_change',
      }) as ComparisonResult;
      expect(dailyOrder.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['daily winner', 'raw winner']);
      expect(dailyOrder.structuredContent.comparison_note)
        .toContain('sort_by=absolute_daily_click_change');
      const secondPage = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_daily_click_change', start_row: 1, limit: 1,
      }) as ComparisonResult;
      expect(secondPage.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['raw winner']);
      expect(requests).toHaveLength(6);
      expect(requests.map((request) => request.startRow ?? 0)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ranks observed relative click movement without treating zero baselines as growth', async () => {
    await saveUser(workerEnv, 'relative-click-sort-user', 'relative-click-sort@example.test', 'relative-click-sort-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'relative-click-sort-user', email: 'relative-click-sort@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'relative-click-sort-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const recent = body.startDate === '2026-09-01';
          return response({ rows: [
            { keys: ['raw leader'], clicks: recent ? 150 : 100, impressions: 500, ctr: recent ? 0.3 : 0.2, position: 6 },
            { keys: ['relative leader'], clicks: recent ? 15 : 5, impressions: 500, ctr: recent ? 0.03 : 0.01, position: 7 },
            { keys: ['zero baseline'], clicks: recent ? 100 : 0, impressions: 500, ctr: recent ? 0.2 : 0, position: 8 },
            { keys: ['zero both'], clicks: 0, impressions: 500, ctr: 0, position: 9 },
            { keys: ['loss leader'], clicks: recent ? 1 : 5, impressions: 500, ctr: recent ? 0.002 : 0.01, position: 10 },
            { keys: ['fine winner'], clicks: recent ? 100 : 99, impressions: 500, ctr: recent ? 0.2 : 0.198, position: 9 },
            { keys: ['fine loser'], clicks: recent ? 102 : 101, impressions: 500, ctr: recent ? 0.204 : 0.202, position: 9 },
          ] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-08-25', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'web', data_state: 'final',
        sort_by: 'absolute_click_percentage_change',
      };
      type Result = { structuredContent: {
        comparisons: Array<{ key: string; diff: { clicks_percentage: number | null } }>;
        comparison_note: string;
        min_baseline_clicks: number;
        min_absolute_click_change: number;
        result_page: { next_start_row?: number };
      } };
      const sorted = await tools['analytics.compare'].handler({ ...args, limit: 10 }) as Result;
      expect(sorted.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['relative leader', 'loss leader', 'raw leader', 'fine winner', 'fine loser']);
      expect(sorted.structuredContent.comparisons[0].diff.clicks_percentage).toBe(200);
      expect(sorted.structuredContent.comparisons[3].diff.clicks_percentage)
        .toBe(sorted.structuredContent.comparisons[4].diff.clicks_percentage);
      expect(sorted.structuredContent.comparison_note).toContain('sort_by=absolute_click_percentage_change');
      expect(sorted.structuredContent.comparison_note).toContain('positive baseline clicks');
      const secondPage = await tools['analytics.compare'].handler({ ...args, limit: 1, start_row: 1 }) as Result;
      expect(secondPage.structuredContent.comparisons.map((row) => row.key)).toEqual(['loss leader']);
      expect(secondPage.structuredContent.result_page.next_start_row).toBe(2);
      const floor = await tools['analytics.compare'].handler({
        ...args, min_baseline_clicks: 20, min_absolute_click_change: 2, limit: 2,
      }) as Result;
      expect(floor.structuredContent.min_baseline_clicks).toBe(20);
      expect(floor.structuredContent.min_absolute_click_change).toBe(2);
      expect(floor.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['raw leader']);
      expect(floor.structuredContent.comparison_note).toContain('min_baseline_clicks=20');
      expect(floor.structuredContent.comparison_note).toContain('min_absolute_click_change=2');
      expect(requests).toHaveLength(6);
      expect(requests.every((request) => (request.startRow ?? 0) === 0)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ranks impression-only visibility movers using raw or daily impressions without extra requests', async () => {
    await saveUser(workerEnv, 'impression-sort-user', 'impression-sort@example.test', 'impression-sort-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'impression-sort-user', email: 'impression-sort@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'impression-sort-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const recent = body.startDate === '2026-09-01';
          return response({ rows: [
            { keys: ['click mover'], clicks: recent ? 70 : 20, impressions: 100, ctr: recent ? 0.7 : 0.2, position: 5 },
            { keys: ['raw impression mover'], clicks: 0, impressions: recent ? 350 : 850, ctr: 0, position: 6 },
            { keys: ['daily impression mover'], clicks: 0, impressions: 280, ctr: 0, position: 8 },
          ] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-08-18', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'web', data_state: 'final',
      };
      type ComparisonResult = { structuredContent: {
        comparisons: Array<{ key: string }>;
        comparison_note: string;
      } };
      const defaultOrder = await tools['analytics.compare'].handler(args) as ComparisonResult;
      expect(defaultOrder.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['click mover', 'raw impression mover', 'daily impression mover']);
      const rawImpressions = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_impression_change',
      }) as ComparisonResult;
      expect(rawImpressions.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['raw impression mover', 'click mover', 'daily impression mover']);
      const dailyImpressions = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_daily_impression_change',
      }) as ComparisonResult;
      expect(dailyImpressions.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['daily impression mover', 'raw impression mover', 'click mover']);
      expect(dailyImpressions.structuredContent.comparison_note)
        .toContain('sort_by=absolute_daily_impression_change');
      expect(requests).toHaveLength(6);
      expect(requests.every((request) => (request.startRow ?? 0) === 0)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ranks observed average-position movement without rounding away differences or inventing missing positions', async () => {
    await saveUser(workerEnv, 'position-sort-user', 'position-sort@example.test', 'position-sort-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'position-sort-user', email: 'position-sort@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'position-sort-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const recent = body.startDate === '2026-09-01';
          return response({ rows: [
            { keys: ['large shift'], clicks: 10, impressions: 200, ctr: 0.05, position: recent ? 5.5 : 9 },
            { keys: ['precise shift'], clicks: 5, impressions: 1000, ctr: 0.005, position: recent ? 3.14 : 3 },
            { keys: ['smaller shift'], clicks: 5, impressions: 1000, ctr: 0.005, position: recent ? 4.11 : 4 },
            { keys: ['missing position'], clicks: 500, impressions: 1000, ctr: 0.5,
              ...(recent ? {} : { position: 20 }) },
            { keys: ['zero-impression baseline'], clicks: recent ? 10 : 0, impressions: recent ? 1000 : 0,
              ctr: recent ? 0.01 : 0, position: recent ? 1 : 30 },
          ] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-08-25', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'web', data_state: 'final',
      };
      type Result = { structuredContent: {
        comparisons: Array<{ key: string; diff: { position: number | null } }>;
        comparison_note: string;
      }; isError?: boolean };
      const sorted = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_position_change', limit: 10,
      }) as Result;
      expect(sorted.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['large shift', 'precise shift', 'smaller shift']);
      expect(sorted.structuredContent.comparisons.slice(1).map((row) => row.diff.position))
        .toEqual([0.1, 0.1]);
      const secondPage = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_position_change', start_row: 1, limit: 1,
      }) as Result;
      expect(secondPage.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['precise shift']);
      expect(sorted.structuredContent.comparison_note).toContain('not a live ranking');
      const unsupported = await tools['analytics.compare'].handler({
        ...args, search_type: 'discover', dimension: 'page', sort_by: 'absolute_position_change',
      }) as Result;
      expect(unsupported.isError).toBe(true);
      expect(requests).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('separates observed average-position improvements and declines before pagination', async () => {
    await saveUser(workerEnv, 'position-direction-user', 'position-direction@example.test', 'position-direction-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'position-direction-user', email: 'position-direction@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'position-direction-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const current = body.startDate === '2026-09-01';
          return response({ rows: [
            { keys: ['strong improvement'], clicks: 6, impressions: 1000, ctr: 0.006, position: current ? 4.2 : 10 },
            { keys: ['small improvement'], clicks: 6, impressions: 1000, ctr: 0.006, position: current ? 4.004 : 4.2 },
            { keys: ['decline'], clicks: 6, impressions: 1000, ctr: 0.006, position: current ? 8 : 5 },
            { keys: ['unchanged'], clicks: 6, impressions: 1000, ctr: 0.006, position: 7 },
            { keys: ['missing baseline'], clicks: 6, impressions: 1000, ctr: 0.006,
              ...(current ? { position: 2 } : {}) },
            { keys: ['zero-impression baseline'], clicks: current ? 6 : 0, impressions: current ? 1000 : 0,
              ctr: current ? 0.006 : 0, position: current ? 1 : 20 },
            { keys: ['low-volume improvement'], clicks: 1, impressions: 10, ctr: 0.1, position: current ? 1 : 15 },
          ] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-08-25', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'web', data_state: 'final',
        sort_by: 'absolute_position_change', min_impressions_per_period: 100,
      };
      type Result = { structuredContent: {
        comparisons: Array<{ key: string }>;
        position_change_direction: string;
        comparison_note: string;
      }; isError?: boolean };
      const improvements = await tools['analytics.compare'].handler({
        ...args, position_change_direction: 'improvement', limit: 10,
      }) as Result;
      expect(improvements.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['strong improvement', 'small improvement']);
      expect(improvements.structuredContent.position_change_direction).toBe('improvement');
      const declines = await tools['analytics.compare'].handler({
        ...args, position_change_direction: 'decline', limit: 10,
      }) as Result;
      expect(declines.structuredContent.comparisons.map((row) => row.key)).toEqual(['decline']);
      const secondImprovement = await tools['analytics.compare'].handler({
        ...args, position_change_direction: 'improvement', start_row: 1, limit: 1,
      }) as Result;
      expect(secondImprovement.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['small improvement']);
      const unsupported = await tools['analytics.compare'].handler({
        ...args, search_type: 'discover', dimension: 'page',
        sort_by: 'absolute_click_change', position_change_direction: 'decline',
      }) as Result;
      expect(unsupported.isError).toBe(true);
      expect(improvements.structuredContent.comparison_note).toContain('Lower average position');
      expect(requests).toHaveLength(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ranks unrounded CTR movement after requiring observed impressions in both periods', async () => {
    await saveUser(workerEnv, 'ctr-movement-user', 'ctr-movement@example.test', 'ctr-movement-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'ctr-movement-user', email: 'ctr-movement@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'ctr-movement-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const current = body.startDate === '2026-09-01';
          return response({ rows: [
            { keys: ['precise CTR mover'], clicks: current ? 19 : 10, impressions: 10000, ctr: current ? 0.0019 : 0.001 },
            { keys: ['large click mover'], clicks: current ? 16000 : 10000, impressions: 10000000, ctr: current ? 0.0016 : 0.001 },
            { keys: ['low sample'], clicks: current ? 1 : 0, impressions: 25, ctr: current ? 0.04 : 0 },
            { keys: ['no baseline'], clicks: current ? 2 : 0, impressions: current ? 200 : 0, ctr: current ? 0.01 : 0 },
          ] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-08-25', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'web', data_state: 'final',
      };
      type ComparisonResult = { structuredContent: {
        comparisons: Array<{ key: string; diff: { ctr: number } }>;
        min_impressions_per_period: number;
        comparison_note: string;
      } };
      const defaultResult = await tools['analytics.compare'].handler({ ...args, limit: 1 }) as ComparisonResult;
      expect(defaultResult.structuredContent.comparisons[0].key).toBe('large click mover');
      const unfiltered = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_ctr_change', limit: 10,
      }) as ComparisonResult;
      expect(unfiltered.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['low sample', 'precise CTR mover', 'large click mover']);
      expect(unfiltered.structuredContent.min_impressions_per_period).toBe(0);
      expect(unfiltered.structuredContent.comparisons[1].diff.ctr).toBe(0.001);
      const nextPage = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_ctr_change', min_impressions_per_period: 100,
        start_row: 1, limit: 1,
      }) as ComparisonResult;
      expect(nextPage.structuredContent.comparisons.map((row) => row.key)).toEqual(['large click mover']);
      expect(nextPage.structuredContent.min_impressions_per_period).toBe(100);
      expect(nextPage.structuredContent.comparison_note).toContain('both periods');
      expect(requests).toHaveLength(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('isolates observed CTR gainers and decliners before pagination without inventing zero-impression baselines', async () => {
    await saveUser(workerEnv, 'ctr-direction-user', 'ctr-direction@example.test', 'ctr-direction-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'ctr-direction-user', email: 'ctr-direction@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'ctr-direction-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const current = body.startDate === '2026-09-01';
          return response({ rows: [
            { keys: ['ctr decline'], clicks: current ? 1 : 6, impressions: 1000, ctr: current ? 0.001 : 0.006 },
            { keys: ['ctr rise'], clicks: current ? 8 : 3, impressions: 1000, ctr: current ? 0.008 : 0.003 },
            { keys: ['low-volume decline'], clicks: current ? 1 : 2, impressions: 10, ctr: current ? 0.1 : 0.2 },
            { keys: ['no CTR baseline'], clicks: current ? 2 : 0, impressions: current ? 1000 : 0, ctr: current ? 0.002 : 0 },
            { keys: ['unchanged CTR'], clicks: 4, impressions: 1000, ctr: 0.004 },
          ] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-08-25', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'web', data_state: 'final',
        sort_by: 'absolute_ctr_change', min_impressions_per_period: 100,
      };
      type Result = { structuredContent: {
        comparisons: Array<{ key: string }>;
        ctr_change_direction: string;
        comparison_note: string;
      } };
      const losses = await tools['analytics.compare'].handler({ ...args, ctr_change_direction: 'loss', limit: 1 }) as Result;
      expect(losses.structuredContent.comparisons.map((row) => row.key)).toEqual(['ctr decline']);
      expect(losses.structuredContent.ctr_change_direction).toBe('loss');
      const gains = await tools['analytics.compare'].handler({ ...args, ctr_change_direction: 'gain', limit: 10 }) as Result;
      expect(gains.structuredContent.comparisons.map((row) => row.key)).toEqual(['ctr rise']);
      const nextLossPage = await tools['analytics.compare'].handler({ ...args, ctr_change_direction: 'loss', start_row: 1, limit: 1 }) as Result;
      expect(nextLossPage.structuredContent.comparisons).toEqual([]);
      expect(nextLossPage.structuredContent.comparison_note).toContain('CTR');
      expect(requests).toHaveLength(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters observed impression gainers and decliners before pagination on raw or daily basis', async () => {
    await saveUser(workerEnv, 'impression-direction-user', 'impression-direction@example.test', 'impression-direction-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'impression-direction-user', email: 'impression-direction@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'impression-direction-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const recent = body.startDate === '2026-09-01';
          const values = recent ? [120, 350, 20, 80] : [100, 50, 80, 80];
          return response({ rows: ['raw up daily down', 'both up', 'both down', 'raw flat'].map((key, i) => ({
            keys: [key], clicks: 0, impressions: values[i], ctr: 0, position: 5,
          })) });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-14',
        start_date_b: '2026-08-25', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'web', data_state: 'final',
      };
      type ComparisonResult = { structuredContent: {
        comparisons: Array<{ key: string }>;
        impression_change_direction: string;
        comparison_note: string;
        result_page: { total_count: number; has_more: boolean };
      } };
      const rawGains = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_impression_change', impression_change_direction: 'gain',
      }) as ComparisonResult;
      expect(rawGains.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['both up', 'raw up daily down']);
      expect(rawGains.structuredContent.impression_change_direction).toBe('gain');
      expect(rawGains.structuredContent.result_page.total_count).toBe(2);
      const dailyLosses = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_daily_impression_change', impression_change_direction: 'loss',
        limit: 1,
      }) as ComparisonResult;
      expect(dailyLosses.structuredContent.comparisons.map((row) => row.key)).toEqual(['both down']);
      expect(dailyLosses.structuredContent.result_page).toMatchObject({ total_count: 3, has_more: true });
      expect(dailyLosses.structuredContent.comparison_note)
        .toContain('impression_change_direction=loss');
      const nextPage = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_daily_impression_change', impression_change_direction: 'loss',
        limit: 1, start_row: 1,
      }) as ComparisonResult;
      expect(nextPage.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['raw up daily down']);
      expect(requests).toHaveLength(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('filters comparison click gains and losses before pagination using the selected time basis', async () => {
    await saveUser(workerEnv, 'direction-user', 'direction@example.test', 'direction-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'direction-user', email: 'direction@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'direction-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const recent = body.startDate === '2026-09-01';
          const values = recent ? [20, 4, 50] : [14, 10, 10];
          return response({ rows: ['raw up daily down', 'both down', 'both up'].map((key, i) => ({
            keys: [key], clicks: values[i], impressions: values[i] * 10, ctr: 0.1, position: 5,
          })) });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-14',
        start_date_b: '2026-08-25', end_date_b: '2026-08-31',
        dimension: 'query', search_type: 'web', data_state: 'final',
      };
      type ComparisonResult = {
        structuredContent: {
          comparisons: Array<{ key: string }>;
          comparison_note: string;
          result_page: { total_count: number; has_more: boolean };
        };
      };
      const rawLosses = await tools['analytics.compare'].handler({
        ...args, click_change_direction: 'loss',
      }) as ComparisonResult;
      expect(rawLosses.structuredContent.comparisons.map((row) => row.key)).toEqual(['both down']);
      expect(rawLosses.structuredContent.result_page.total_count).toBe(1);
      const dailyLosses = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_daily_click_change', click_change_direction: 'loss',
        limit: 1,
      }) as ComparisonResult;
      expect(dailyLosses.structuredContent.comparisons.map((row) => row.key)).toEqual(['both down']);
      expect(dailyLosses.structuredContent.result_page).toMatchObject({ total_count: 2, has_more: true });
      expect(dailyLosses.structuredContent.comparison_note).toContain('click_change_direction=loss');
      const nextPage = await tools['analytics.compare'].handler({
        ...args, sort_by: 'absolute_daily_click_change', click_change_direction: 'loss',
        limit: 1, start_row: 1,
      }) as ComparisonResult;
      expect(nextPage.structuredContent.comparisons.map((row) => row.key))
        .toEqual(['raw up daily down']);
      expect(requests).toHaveLength(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('compares Discover page evidence without manufacturing average positions or permitting query grouping', async () => {
    await saveUser(workerEnv, 'discover-compare-user', 'discover@example.test', 'discover-refresh');
    const server = await createGscMcpServer(
      workerEnv,
      { google_id: 'discover-compare-user', email: 'discover@example.test' },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'discover-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          if ((body.startRow as number | undefined ?? 0) > 0) return response({ rows: [] });
          return response({ rows: [{
            keys: ['https://example.com/story'],
            clicks: body.startDate === '2026-09-01' ? 30 : 10,
            impressions: body.startDate === '2026-09-01' ? 400 : 200,
            ctr: body.startDate === '2026-09-01' ? 0.075 : 0.05,
          }] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      const args = {
        site_url: 'sc-domain:example.com',
        start_date_a: '2026-09-01', end_date_a: '2026-09-07',
        start_date_b: '2026-08-25', end_date_b: '2026-08-31',
        search_type: 'discover', dimension: 'page', data_state: 'final',
      };
      const result = (await tools['analytics.compare'].handler(args)) as {
        structuredContent: {
          comparisons: Array<{ period_a: { position: number | null }; period_b: { position: number | null }; diff: { clicks: number; position: number | null } }>;
          observed_dimension_overlap: { comparable_count: number };
          comparison_note: string;
        };
      };
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.type)).toEqual(['discover', 'discover']);
      expect(requests.map((request) => request.dimensions)).toEqual([['page'], ['page']]);
      expect(result.structuredContent.comparisons).toHaveLength(1);
      expect(result.structuredContent.comparisons[0]).toMatchObject({
        period_a: { position: null }, period_b: { position: null },
        diff: { clicks: 20, position: null },
      });
      expect(result.structuredContent.observed_dimension_overlap.comparable_count).toBe(1);
      expect(result.structuredContent.comparison_note).toContain('not supported');
      const newsResult = (await tools['analytics.compare'].handler({
        ...args, search_type: 'googleNews', dimension: 'country',
      })) as { structuredContent: { comparisons: Array<{ diff: { position: number | null } }> } };
      expect(requests.map((request) => request.type)).toEqual([
        'discover', 'discover', 'googleNews', 'googleNews',
      ]);
      expect(newsResult.structuredContent.comparisons[0].diff.position).toBeNull();
      await expect(tools['analytics.compare'].handler({ ...args, dimension: 'query' }))
        .rejects.toThrow(/does not support the query dimension/i);
      await expect(tools['analytics.compare'].handler({
        ...args, dimension: 'page', dimension_filter_groups: [{
          groupType: 'and', filters: [{ dimension: 'query', operator: 'equals', expression: 'test' }],
        }],
      })).rejects.toThrow(/does not support the query dimension or query filters/i);
      expect(requests).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not reuse a Google access token across distinct Worker environments', async () => {
    const makeEnvironment = () => {
      const users = new Map<string, string>();
      return {
        GSC_ACCESS_MODE: 'readonly',
        GOOGLE_CLIENT_ID: 'test-client',
        GOOGLE_CLIENT_SECRET: 'test-secret',
        TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
        USER_KV: {
          get: async (key: string) => users.get(key) ?? null,
          put: async (key: string, value: string) => { users.set(key, value); },
        },
        TOOL_RATE_LIMITER: {
          idFromName: (name: string) => name,
          get: () => ({ take: async () => ({ allowed: true }) }),
        },
      } as unknown as Env;
    };
    const firstEnv = makeEnvironment();
    const secondEnv = makeEnvironment();
    const googleId = 'same-account-in-two-environments';
    await saveUser(firstEnv, googleId, 'user@example.test', 'refresh-first-env');
    await saveUser(secondEnv, googleId, 'user@example.test', 'refresh-second-env');
    const props = { google_id: googleId, email: 'user@example.test' };
    const firstServer = await createGscMcpServer(firstEnv, props);
    const secondServer = await createGscMcpServer(secondEnv, props);
    const handler = (server: Awaited<ReturnType<typeof createGscMcpServer>>) =>
      (server as unknown as {
        _registeredTools: Record<string, {
          handler: (args: Record<string, never>) => Promise<unknown>;
        }>;
      })._registeredTools['sites.list'].handler;

    const originalFetch = globalThis.fetch;
    const observedAuth: string[] = [];
    const observedRefreshGrants: string[] = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          const refresh = new URLSearchParams(String(init?.body)).get('refresh_token');
          observedRefreshGrants.push(refresh ?? '');
          return response({ access_token: `access:${refresh}`, expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
          observedAuth.push(new Headers(init?.headers).get('authorization') ?? '');
          return response({ siteEntry: [] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      await handler(firstServer)({});
      await handler(secondServer)({});
      const repeatedFirstServer = await createGscMcpServer(firstEnv, props);
      await handler(repeatedFirstServer)({});
      expect(observedAuth).toEqual([
        'Bearer access:refresh-first-env',
        'Bearer access:refresh-second-env',
        'Bearer access:refresh-first-env',
      ]);
      expect(observedRefreshGrants).toEqual([
        'refresh-first-env',
        'refresh-second-env',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the normal tool token cache and preserves stored credentials on invalid_grant', async () => {
    await saveUser(
      workerEnv,
      'cached-user',
      'cached@example.test',
      'cached-refresh-token',
    );
    await saveUser(
      workerEnv,
      'revoked-user',
      'revoked@example.test',
      'revoked-refresh-token',
    );
    const lifecycle = new GoogleAccessTokenLifecycle(workerEnv);
    const cachedServer = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'cached-user',
        email: 'cached@example.test',
      },
      lifecycle,
    );
    const cachedTools = (cachedServer as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, never>) => Promise<unknown> }
      >;
    })._registeredTools;
    const revokedServer = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'revoked-user',
        email: 'revoked@example.test',
      },
      lifecycle,
    );
    const revokedTools = (revokedServer as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: Record<string, never>) => Promise<unknown> }
        >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    let cachedRefreshes = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          const body = String(init?.body ?? '');
          if (body.includes('revoked-refresh-token')) {
            return response({ error: 'invalid_grant' }, 400);
          }
          cachedRefreshes += 1;
          return response({ access_token: 'cached-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
          return response({ siteEntry: [] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      await cachedTools['sites.list'].handler({});
      await cachedTools['sites.list'].handler({});
      expect(cachedRefreshes).toBe(1);

      await expect(revokedTools['sites.list'].handler({})).rejects.toThrow(
        GSC_ACCESS_REVOKED_MESSAGE,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(await getUser(workerEnv, 'revoked-user')).not.toBeNull();
    expect(await getUser(workerEnv, 'cached-user')).not.toBeNull();
  });

  it('does not erase a newer Google grant when an older refresh fails late', async () => {
    await saveUser(workerEnv, 'reconnected-user', 'user@example.test', 'old-refresh');
    const lifecycle = new GoogleAccessTokenLifecycle(workerEnv);
    const originalFetch = globalThis.fetch;
    let resolveOldRefresh!: (value: Response) => void;
    let oldRefreshStarted!: () => void;
    const oldRefreshReachedGoogle = new Promise<void>((resolve) => {
      oldRefreshStarted = resolve;
    });

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input) !== GOOGLE_TOKEN_URL) {
          throw new Error(`Unexpected outbound request: ${requestUrl(input)}`);
        }
        const body = String(init?.body ?? '');
        if (body.includes('old-refresh')) {
          oldRefreshStarted();
          return new Promise<Response>((resolve) => {
            resolveOldRefresh = resolve;
          });
        }
        expect(body).toContain('new-refresh');
        return response({ access_token: 'new-access', expires_in: 3600 });
      };

      const staleRefresh = lifecycle.getAccessToken('reconnected-user');
      await oldRefreshReachedGoogle;
      await saveUser(workerEnv, 'reconnected-user', 'user@example.test', 'new-refresh');
      resolveOldRefresh(response({ error: 'invalid_grant' }, 400));
      await expect(staleRefresh).rejects.toThrow(GSC_ACCESS_REVOKED_MESSAGE);

      expect(await getDecryptedRefreshToken(workerEnv, 'reconnected-user')).toBe('new-refresh');
      await expect(lifecycle.getAccessToken('reconnected-user')).resolves.toBe('new-access');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('orchestrates the weekly digest through stored credentials and deterministic analytics responses', async () => {
    await saveUser(
      workerEnv,
      'digest-user',
      'digest@example.test',
      'digest-refresh-token',
    );
    const originalFetch = globalThis.fetch;
    const analyticsRequests: Array<Record<string, unknown>> = [];
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'digest-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          analyticsRequests.push(body);
          const dimensions = body.dimensions as string[];
          if (dimensions.length === 0) {
            return response({ rows: [{ keys: [], clicks: 20, impressions: 200, ctr: 0.1, position: 8 }] });
          }
          if (dimensions[0] === 'query') {
            return response({
              rows: [
                {
                  keys: ['example query'],
                  clicks: body.startDate === '2026-01-08' ? 10 : 1,
                  impressions: 100,
                  ctr: 0.1,
                  position: 9,
                },
              ],
            });
          }
          return response({ rows: [{ keys: ['https://example.com/page'], clicks: 10, impressions: 100, ctr: 0.1, position: 9 }] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const markdown = await generateWeeklyDigest(
        new GoogleAccessTokenLifecycle(workerEnv),
        'digest-user',
        'https://example.com/',
        '2026-01-14',
      );

      expect(markdown).toContain('Week of 2026-01-08 to 2026-01-14');
      expect(markdown).toContain('example query');
      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.map((request) => request.dimensions)).toEqual([
        [],
        [],
        ['query'],
        ['query'],
        ['page'],
      ]);

      analyticsRequests.length = 0;
      const imageMarkdown = await generateWeeklyDigest(
        new GoogleAccessTokenLifecycle(workerEnv),
        'digest-user',
        'https://example.com/',
        '2026-01-14',
        undefined,
        '2026-01-17',
        undefined,
        'image',
      );
      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.every((request) => request.type === 'image')).toBe(true);
      expect(imageMarkdown).toContain('**Search type:** Image search');
      expect(imageMarkdown).toContain('Review this search surface before changing content');
      expect(imageMarkdown).not.toContain('Change the title or meta description');

      analyticsRequests.length = 0;
      const desktopMarkdown = await generateWeeklyDigest(
        new GoogleAccessTokenLifecycle(workerEnv),
        'digest-user',
        'https://example.com/',
        '2026-01-14',
        undefined,
        '2026-01-17',
        undefined,
        'web',
        'desktop',
      );
      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.every((request) => JSON.stringify(request.dimensionFilterGroups) === JSON.stringify([{
        groupType: 'and',
        filters: [{ dimension: 'device', operator: 'equals', expression: 'DESKTOP' }],
      }]))).toBe(true);
      expect(desktopMarkdown).toContain('**Device filter:** Desktop');
      expect(desktopMarkdown).toContain('## Quick numbers');
      expect(desktopMarkdown).not.toContain('**Search type:**');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('withholds a weekly traffic comparison when Google returns no aggregate row', async () => {
    await saveUser(workerEnv, 'digest-no-rows', 'digest-no-rows@example.test', 'digest-no-rows-refresh');
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'digest-no-rows-access', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query') {
          const body = JSON.parse(String(init?.body)) as { startDate: string; dimensions: string[] };
          if (body.dimensions.length === 0 && body.startDate === '2026-01-01') {
            return response({ rows: [{ keys: [], clicks: 30, impressions: 300, ctr: 0.1, position: 10 }] });
          }
          return response({ rows: [] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      const markdown = await generateWeeklyDigest(
        new GoogleAccessTokenLifecycle(workerEnv),
        'digest-no-rows',
        'https://example.com/',
        '2026-01-14',
      );
      expect(markdown).toContain('## Data availability');
      expect(markdown).toContain('2026-01-08 to 2026-01-14');
      expect(markdown).toContain('withheld rather than treating absent rows');
      expect(markdown).toContain('Search Analytics alone does not tell us whether Google crawled or indexed');
      expect(markdown).toContain("use this server's `urls.inspect` tool");
      expect(markdown).not.toContain('## Quick numbers');
      expect(markdown).not.toContain('No Google Search impressions were recorded this week');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('reserves five shared Search Analytics units before running a weekly digest', async () => {
    const take = vi.fn(async (_bucket: string, policy: { category: string }, _units: number) => ({
      allowed: policy.category !== 'search-analytics',
      retry_after_ms: 20_000,
    }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const getAccessToken = vi.fn(async () => {
      throw new Error('Shared budget rejection must happen before credential work');
    });
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'digest-budget-user', email: 'digest-budget@example.test' },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, string>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
      }>;
    })._registeredTools;

    const result = await tools['reports.weekly_digest'].handler({
      site_url: 'sc-domain:example.com',
      end_date: '2026-09-17',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Rate limit reached for reports.weekly_digest');
    expect(take.mock.calls.map(([, policy, units]) => [policy.category, units])).toEqual([
      ['weekly-digest', 1],
      ['search-analytics', 5],
    ]);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('reserves only three shared Search Analytics units for preliminary weekly digests', async () => {
    const take = vi.fn(async (_bucket: string, policy: { category: string }) => ({
      allowed: policy.category !== 'search-analytics',
      retry_after_ms: 20_000,
    }));
    const limiter = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ take })),
    };
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: limiter } as unknown as Env,
      { google_id: 'digest-preliminary-user', email: 'preliminary@example.test' },
      { getAccessToken: async () => {
        throw new Error('Quota must be reserved before credentials');
      } } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, string>) => Promise<{ isError?: boolean }>;
      }>;
    })._registeredTools['reports.weekly_digest'].handler;

    const result = await handler({
      site_url: 'sc-domain:example.com',
      end_date: getSearchConsoleCalendarDate(),
    });
    expect(result.isError).toBe(true);
    expect(take.mock.calls.map(([, policy, units]) => [policy.category, units])).toEqual([
      ['weekly-digest', 1],
      ['search-analytics', 3],
    ]);
  });

  it('rejects ambiguous weekly digest single/list scopes before any quota or Google request', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const getAccessToken = vi.fn(async () => 'test-token');
    const server = await createGscMcpServer(
      { GSC_ACCESS_MODE: 'readonly', TOOL_RATE_LIMITER: { idFromName: (name: string) => name, get: () => ({ take }) } } as unknown as Env,
      { google_id: 'digest-conflict-user', email: 'conflict@example.test' },
      { getAccessToken } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
      }>;
    })._registeredTools['reports.weekly_digest'].handler;

    const countryResult = await handler({ site_url: 'sc-domain:example.com', country: 'SVN', countries: ['DEU'] });
    const deviceResult = await handler({ site_url: 'sc-domain:example.com', device: 'mobile', devices: ['desktop'] });
    expect(countryResult.isError).toBe(true);
    expect(countryResult.content[0]?.text).toContain('Use country or countries, not both');
    expect(deviceResult.isError).toBe(true);
    expect(deviceResult.content[0]?.text).toContain('Use device or devices, not both');
    expect(take).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });
  it('charges a weekly digest retry in addition to its five upfront Analytics units', async () => {
    const take = vi.fn(async () => ({ allowed: true }));
    const server = await createGscMcpServer(
      {
        GSC_ACCESS_MODE: 'readonly',
        TOOL_RATE_LIMITER: { idFromName: (name: string) => name, get: () => ({ take }) },
      } as unknown as Env,
      { google_id: 'digest-retry-user', email: 'digest-retry@example.test' },
      { getAccessToken: async () => 'test-token' } as unknown as GoogleAccessTokenLifecycle,
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
    })._registeredTools['reports.weekly_digest'].handler;
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    try {
      globalThis.fetch = async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? new Response('transient', { status: 503, headers: { 'retry-after': '0' } })
          : response({ rows: [] });
      };
      await handler({ site_url: 'sc-domain:example.com', end_date: '2026-09-17' });
      expect(providerCalls).toBe(6);
      expect(take.mock.calls.map((call) => [call[1].category, call[2]])).toEqual([
        ['weekly-digest', 1],
        ['search-analytics', 5],
        ['search-analytics', 1],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('defaults the weekly digest to the latest usually-complete Search Console date', async () => {
    await saveUser(
      workerEnv,
      'digest-default-user',
      'digest-default@example.test',
      'digest-default-refresh-token',
    );
    const server = await createGscMcpServer(
      workerEnv,
      {
        google_id: 'digest-default-user',
        email: 'digest-default@example.test',
      },
      new GoogleAccessTokenLifecycle(workerEnv),
    );
    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    })._registeredTools;
    const originalFetch = globalThis.fetch;
    const analyticsRequests: Array<Record<string, unknown>> = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T06:30:00Z'));

    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url === GOOGLE_TOKEN_URL) {
          return response({ access_token: 'digest-default-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query') {
          analyticsRequests.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return response({ rows: [] });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };

      await tools['reports.weekly_digest'].handler({
        site_url: 'https://example.com/',
      });

      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.map((request) => request.startDate)).toEqual([
        '2026-09-10',
        '2026-09-03',
        '2026-09-10',
        '2026-09-03',
        '2026-09-10',
      ]);
      expect(analyticsRequests.map((request) => request.endDate)).toEqual([
        '2026-09-16',
        '2026-09-09',
        '2026-09-16',
        '2026-09-09',
        '2026-09-16',
      ]);
      expect(analyticsRequests.every((request) => request.type === undefined)).toBe(true);
      expect(analyticsRequests.every((request) => request.dimensionFilterGroups === undefined)).toBe(true);

      analyticsRequests.length = 0;
      const imageDigest = await tools['reports.weekly_digest'].handler({
        site_url: 'https://example.com/',
        search_type: 'image',
        page_contains: '/de/',
        device: 'mobile',
        query_contains: 'technical seo',
        country: 'deu',
      }) as { content: Array<{ text: string }> };
      expect(analyticsRequests).toHaveLength(5);
      expect(analyticsRequests.every((request) => request.type === 'image')).toBe(true);
      expect(analyticsRequests.every((request) => JSON.stringify(request.dimensionFilterGroups) === JSON.stringify([{
        groupType: 'and',
        filters: [
          { dimension: 'page', operator: 'contains', expression: '/de/' },
          { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
          { dimension: 'query', operator: 'contains', expression: 'technical seo' },
          { dimension: 'country', operator: 'equals', expression: 'DEU' },
        ],
      }]))).toBe(true);
      expect(imageDigest.content[0]?.text).toContain('**Search type:** Image search');
      expect(imageDigest.content[0]?.text).toContain('Page URL filter');
      expect(imageDigest.content[0]?.text).toContain('**Device filter:** Mobile');
      expect(imageDigest.content[0]?.text).toContain('**Query topic filter:** technical seo');
      expect(imageDigest.content[0]?.text).toContain('**Country filter:** DEU');
      expect(imageDigest.content[0]?.text).toContain('not property-wide totals');
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });
});
