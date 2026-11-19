import assert from "node:assert/strict";
import {Readable} from "node:stream";
import test from "node:test";
import {createAgentWeb,createPublicReader,publicUrl,searchEndpoint} from "../agent-web.mjs";

const publicIP={address:"8.8.8.8",family:4};
const localIP={address:"127.0.0.1",family:4};
function response(statusCode,headers={},chunks=[]){
  return Object.assign(Readable.from(chunks),{statusCode,headers});
}

test("public web tools validate schemes, addresses, credentials and provider URLs",()=>{
  for(const value of ["file:///C:/Windows","http://127.1","http://169.254.169.254","http://[::1]","http://[::ffff:8.8.8.8]",
    "http://192.168.1.2","http://100.65.0.1","http://[fc00::100]","http://[64:ff9b::a00:1]","http://localhost.",
    "https://name:password@nodejs.org","https://nodejs.org:444/","https://nodejs.org/?access_token=dummy"]){
    assert.throws(()=>publicUrl(value),undefined,value);
  }
  assert.equal(publicUrl("https://nodejs.org:443/api/url.html#section").href,"https://nodejs.org/api/url.html");
  assert.throws(()=>searchEndpoint("http://www.nodejs.org/search"),/HTTPS/);
});

test("DNS answers are pinned, mixed private answers and redirect targets are blocked before connection",async()=>{
  const requests=[];
  const read=createPublicReader({
    resolve:async host=>host==="mixed.example.com"?[publicIP,localIP]:[publicIP],
    send:async (url,address)=>{
      requests.push([url.hostname,address]);
      return response(302,{location:"http://169.254.169.254/latest"});
    }
  });
  await assert.rejects(read("https://mixed.example.com/"),/resolves to.*private/);
  assert.deepEqual(requests,[]);
  await assert.rejects(read("https://nodejs.org/"),/reserved addresses/);
  assert.deepEqual(requests,[["nodejs.org",publicIP]]);
});

test("web tools limit response size and preserve source URLs and useful errors",async()=>{
  const limited=createPublicReader({resolve:async()=>[publicIP],send:async()=>response(200,
    {"content-type":"text/plain"},[Buffer.alloc(1024*1024),Buffer.alloc(1)])});
  await assert.rejects(limited("https://nodejs.org/"),/1 MiB/);
  const missing=createPublicReader({resolve:async()=>[publicIP],send:async()=>response(404)});
  await assert.rejects(missing("https://nodejs.org/"),/HTTP 404/);
  const web=createAgentWeb({read:async url=>url.includes("search/issues")?
    {text:JSON.stringify({items:[{title:"URL parser",html_url:"https://github.com/nodejs/node/issues/1"}]})}:
    {url,type:"text/html",text:"<main><h1>URL API</h1><script>skip this</script><p>Documentation.</p></main>"}});
  assert.match(await web.openPage("https://nodejs.org/api/url.html"),/^Source: https:\/\/nodejs\.org\/api\/url\.html[\s\S]*Documentation\./);
  assert.doesNotMatch(await web.openPage("https://nodejs.org/"),/skip this/);
  assert.match(await web.searchWeb("URL parser","auto"),/https:\/\/github\.com\/nodejs\/node\/issues\/1/);
  await assert.rejects(web.searchWeb("URL parser","web"),/Configure a public SearXNG/);
  const broad=createAgentWeb({endpoint:searchEndpoint("https://search.example.com/search"),read:async url=>{
    const request=new URL(url);
    assert.equal(request.searchParams.get("format"),"json");
    assert.equal(request.searchParams.get("q"),"URL parser");
    return {text:JSON.stringify({results:[{title:"Node URL API",url:"https://nodejs.org/api/url.html"}]})};
  }});
  assert.match(await broad.searchWeb("URL parser","auto"),/https:\/\/nodejs\.org\/api\/url\.html/);
});
