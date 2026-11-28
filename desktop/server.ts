import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { refreshAccessToken, listSites, getSite, querySearchAnalytics, inspectUrl, listSitemaps, getSitemap } from '../src/google';
import { SEARCH_CONSOLE_DATE_SCHEMA, getSearchConsoleCalendarDate } from '../src/date-validation';
import { takeBoundedItems } from '../src/result-bounds';

const baseFetch = globalThis.fetch.bind(globalThis);
let requests: number[] = [];
// Dedicated process: bound every upstream attempt to Google's read-only API surface.
globalThis.fetch = async (input, init) => {
  if (typeof input !== 'string' && !(input instanceof URL)) throw new Error('Unsupported request');
  const u = new URL(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const sites = '/webmasters/v3/sites';
  const readSites = u.origin === 'https://www.googleapis.com' && (
    (method === 'GET' && (u.pathname === sites ||
      /^\/webmasters\/v3\/sites\/[^/]+(?:\/sitemaps(?:\/[^/]+)?)?$/.test(u.pathname))) ||
    (method === 'POST' && /^\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/.test(u.pathname)));
  const tokenEndpoint = u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/token' && method === 'POST';
  const inspection = u.origin === 'https://searchconsole.googleapis.com' && u.pathname === '/v1/urlInspection/index:inspect' && method === 'POST';
  if (u.username || u.password || u.hash || u.search || !(readSites || tokenEndpoint || inspection)) throw new Error('Blocked outbound request');
  const now = Date.now();
  requests = requests.filter(t => now - t < 60_000);
  if (requests.length >= 30) throw new Error('Local request budget reached');
  requests.push(now);
  const timeout = AbortSignal.timeout(12_000);
  return baseFetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
};
const envNames = ['GSC_GOOGLE_CLIENT_ID', 'GSC_GOOGLE_CLIENT_SECRET', 'GSC_GOOGLE_REFRESH_TOKEN'] as const;
let cached: { value: string; expires: number } | undefined;
let inflight: Promise<string> | undefined;
function configured() { return envNames.every(k => !!process.env[k]?.trim()); }
async function token(): Promise<string> {
  if (!configured()) throw new Error('Not configured');
  if (cached && Date.now() < cached.expires) return cached.value;
  if (!inflight) inflight = (async () => {
    const [id, secret, refresh] = envNames.map(k => process.env[k]!.trim());
    const data = await refreshAccessToken(refresh, id, secret);
    cached = { value: data.access_token, expires: Date.now() + Math.max(0, Math.min(data.expires_in, 3600) - 60) * 1000 };
    return data.access_token;
  })().finally(() => { inflight = undefined; });
  return inflight;
}
const url = z.string().max(4096).refine(s => {
  try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash; } catch { return false; }
}, 'Use an HTTP(S) URL without credentials or fragments');
const property = z.string().max(4096).refine(s => /^sc-domain:[a-z0-9.-]+$/i.test(s) || url.safeParse(s).success,
  'Use an authorized Search Console property identifier');
const offset = z.number().int().min(0).max(100_000).default(0);
const limit = z.number().int().min(1).max(100).default(50);
const server = new McpServer({name:'digestseo-gsc-desktop', version:'0.1.0'}, {instructions:
  'Local read-only Search Console adapter. Only query properties authorized by Google. URL Inspection describes Google index data, not a live crawl. Configure credentials out of band, never in tool arguments. No indexing, mutation, or browsing tools.'});
function result(data: unknown, isError = false) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, 'utf8') > 48000) return {content:[{type:'text' as const,text:'Result exceeds local response limit; narrow the request.'}],isError:true};
  return {content:[{type:'text' as const,text}], ...(isError ? {isError:true}: {})};
}
function page<T>(items: readonly T[], start: number, count: number) {
  const bounded = takeBoundedItems(items.slice(start), count, 36_000);
  const next = start + bounded.items.length;
  return {items:bounded.items, start, total:items.length, has_more:next<items.length,
    byte_limit_reached:bounded.byteLimitReached, next_start:next<items.length && next>start ? next : null};
}
function register(name:string, title:string, description:string, inputSchema:any, handler:(a:any)=>Promise<unknown>) {
  server.registerTool(name,{title,description,inputSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:name!=='server.capabilities'}},async a=>{
    try { return result(await handler(a)); }
    catch { return result({error:configured()?'Read failed. Check Google authorization, property, query constraints, quotas, or network availability.':'Configure the three Google OAuth fields in the extension settings. Never paste credentials into chat.'},true); }
  });
}
register('server.capabilities','Desktop capabilities','Inspect local read-only adapter configuration without making a network request.',z.object({}),async()=>({access_mode:'readonly',configured:configured(),provider:'Google Search Console',write_tools:[],max_rows:100}));
register('sites.list','List properties','List authorized Search Console properties with bounded pagination.',z.object({start:offset,limit}),async a=>page(await listSites(await token()),a.start,a.limit));
register('sites.get','Get property','Read metadata for an authorized Search Console property.',z.object({site_url:property}),async a=>getSite(await token(),a.site_url));
register('analytics.query','Search performance','Read clicks, impressions, CTR and recorded position for a bounded Search Console date range. Google may omit some rows.',z.object({
  site_url:property,start_date:SEARCH_CONSOLE_DATE_SCHEMA,end_date:SEARCH_CONSOLE_DATE_SCHEMA,
  dimensions:z.array(z.enum(['query','page','country','device','date','searchAppearance'])).max(5).default(['date']),
  search_type:z.enum(['web','image','video','news','discover','googleNews']).default('web'),
  start_row:offset,row_limit:limit
}),async a=>{
  const days=(Date.parse(a.end_date)-Date.parse(a.start_date))/86400000;
  if(days<0||days>365||a.end_date>getSearchConsoleCalendarDate()||new Set(a.dimensions).size!==a.dimensions.length) throw new Error('Invalid range or dimensions');
  const data=await querySearchAnalytics(await token(),a.site_url,{startDate:a.start_date,endDate:a.end_date,dimensions:a.dimensions,rowLimit:a.row_limit,startRow:a.start_row,type:a.search_type,dataState:'final'});
  const b=takeBoundedItems(data.rows,a.row_limit,36_000);
  const more=b.byteLimitReached||data.rows.length===a.row_limit;
  return {rows:b.items,metadata:data.metadata,aggregation_type:data.responseAggregationType,has_more:more,byte_limit_reached:b.byteLimitReached,next_start_row:more&&b.items.length>0?a.start_row+b.items.length:null};
});
register('urls.inspect','Inspect URL','Read Google URL Inspection index data for an authorized property; not a live crawl or indexing request.',z.object({site_url:property,inspection_url:url}),async a=>inspectUrl(await token(),a.site_url,a.inspection_url));
register('sitemaps.list','List sitemaps','List sitemaps reported for an authorized property.',z.object({site_url:property,start:offset,limit}),async a=>page(await listSitemaps(await token(),a.site_url),a.start,a.limit));
register('sitemaps.get','Get sitemap','Read a specific sitemap record; does not fetch or submit the URL.',z.object({site_url:property,feedpath:url}),async a=>getSitemap(await token(),a.site_url,a.feedpath));
await serveStdio(() => server);
