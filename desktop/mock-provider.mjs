import assert from 'node:assert/strict';
const site='https://example.test/';
const feed=site+'sitemap.xml';
let refreshCount=0;
globalThis.fetch=async (input, init={})=>{
  const u=new URL(input), method=init.method??'GET';
  assert.equal(init.redirect,'error'); assert.ok(init.signal);
  const reply=v=>new Response(JSON.stringify(v),{status:200,headers:{'content-type':'application/json'}});
  if(u.href==='https://oauth2.googleapis.com/token'&&method==='POST'){
    assert.equal(++refreshCount,1); assert.equal(init.body.get('grant_type'),'refresh_token');
    return reply({access_token:'test-access',expires_in:3600});
  }
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer test-access');
  const p=decodeURIComponent(u.pathname);
  if(u.origin==='https://www.googleapis.com'&&method==='GET'){
    if(p==='/webmasters/v3/sites')return reply({siteEntry:[{siteUrl:site,permissionLevel:'siteOwner'}]});
    if(p==='/webmasters/v3/sites/'+site)return reply({siteUrl:site,permissionLevel:'siteOwner'});
    if(p==='/webmasters/v3/sites/'+site+'/sitemaps')return reply({sitemap:[{path:feed,type:'sitemap',errors:'0',warnings:'0'}]});
    if(p==='/webmasters/v3/sites/'+site+'/sitemaps/'+feed)return reply({path:feed,type:'sitemap',errors:'0',warnings:'0'});
  }
  if(u.origin==='https://www.googleapis.com'&&method==='POST'&&p==='/webmasters/v3/sites/'+site+'/searchAnalytics/query'){
    const body=JSON.parse(init.body);assert.equal(body.dataState,'final');assert.equal(body.rowLimit,1);
    return reply({rows:[{keys:['2026-01-01'],clicks:1,impressions:10,ctr:.1,position:3}],responseAggregationType:'byProperty'});
  }
  if(u.href==='https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'&&method==='POST'){
    assert.equal(JSON.parse(init.body).siteUrl,site);
    return reply({inspectionResult:{indexStatusResult:{verdict:'PASS',coverageState:'Submitted and indexed'}}});
  }
  throw Error('Unexpected mock route: '+method+' '+u.origin+u.pathname);
};
