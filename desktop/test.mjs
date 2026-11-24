import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const env={...process.env,GSC_GOOGLE_CLIENT_ID:'synthetic-client',GSC_GOOGLE_CLIENT_SECRET:'synthetic-secret',GSC_GOOGLE_REFRESH_TOKEN:'synthetic-refresh'};
const expected=['server.capabilities','sites.list','sites.get','analytics.query','urls.inspect','sitemaps.list','sitemaps.get'];
async function withClient(configured, callback){
  const e={...env}; if(!configured)for(const k of Object.keys(e))if(k.startsWith('GSC_GOOGLE_'))delete e[k];
  const child=spawn(process.execPath,['--import','./mock-provider.mjs','./dist/server.mjs'],{env:e,stdio:['pipe','pipe','pipe']});
  let id=0,errors='';const waiting=new Map();
  child.stderr.on('data',b=>errors+=b);
  createInterface({input:child.stdout}).on('line',s=>{const m=JSON.parse(s);const f=waiting.get(m.id);if(f){waiting.delete(m.id);f(m);}});
  function rpc(method,params={}){
    const n=++id;return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waiting.delete(n);reject(Error('Timeout '+method+': '+errors));},10000);
      waiting.set(n,m=>{clearTimeout(timer);resolve(m);});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');
    });
  }
  const call=async(name,args={})=>rpc('tools/call',{name,arguments:args});
  try{
    const i=await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}});
    assert.equal(i.result.serverInfo.name,'digestseo-gsc-desktop');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const t=(await rpc('tools/list')).result.tools;
    assert.deepEqual(t.map(x=>x.name).sort(),[...expected].sort());
    assert.ok(t.every(x=>x.annotations?.readOnlyHint===true&&x.annotations?.destructiveHint===false));
    await callback(call,t);
  }finally{
    child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>child.kill(),2000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
}
const value=r=>{assert.ok(!r.error,JSON.stringify(r));assert.ok(!r.result.isError,JSON.stringify(r));return JSON.parse(r.result.content[0].text);};
test('no credentials: safe discovery and fail closed',async()=>withClient(false,async call=>{
  assert.equal(value(await call('server.capabilities')).configured,false);
  assert.equal((await call('sites.list')).result.isError,true);
}));
test('seven read-only tools: mocked OAuth and Google results',async()=>withClient(true,async(call,tools)=>{
  const site='https://example.test/',feed=site+'sitemap.xml';
  assert.equal(value(await call('server.capabilities')).configured,true);
  assert.equal(value(await call('sites.list')).items[0].siteUrl,site);
  assert.equal(value(await call('sites.get',{site_url:site})).siteUrl,site);
  assert.equal(value(await call('analytics.query',{site_url:site,start_date:'2026-01-01',end_date:'2026-01-02',row_limit:1})).rows[0].clicks,1);
  assert.equal(value(await call('urls.inspect',{site_url:site,inspection_url:site})).indexStatusResult.verdict,'PASS');
  assert.equal(value(await call('sitemaps.list',{site_url:site})).items[0].path,feed);
  assert.equal(value(await call('sitemaps.get',{site_url:site,feedpath:feed})).path,feed);
  for(const args of [{site_url:'file:///C:/private'},{site_url:'https://user:secret@example.test/'}]){
    const r=await call('sites.get',args);assert.ok(r.error||r.result.isError);
  }
  const bad=await call('analytics.query',{site_url:site,start_date:'2026-02-30',end_date:'2026-03-02'});assert.ok(bad.error||bad.result.isError);
  const mutation=await call('indexing.request',{url:site});assert.ok(mutation.error||mutation.result.isError);
  const m=JSON.parse(readFileSync('./manifest.json','utf8'));
  assert.deepEqual(m.tools.map(t=>t.name).sort(),tools.map(t=>t.name).sort());
}));
