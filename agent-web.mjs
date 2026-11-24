import {lookup} from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import {convert} from "html-to-text";
import {redactSecrets} from "./security-policy.mjs";

const MAX_BYTES = 1024 * 1024;
const credentials = /^(?:access_?token|api_?key|key|token|secret|password|pass|auth|authorization|signature|sig|session|credential|x-amz-.*)$/i;
const forbiddenNames = /(?:^|\.)(?:localhost|local|internal|home\.arpa|onion|test|example|invalid)$/i;

export function publicUrl(value) {
  let url;
  try {
    if (typeof value !== "string" || value.length > 2048 || /[\s\\\x00-\x1f]/.test(value)) throw new Error();
    url = new URL(value);
  } catch { throw new Error("Enter a valid public HTTP or HTTPS URL."); }
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error("Only public HTTP and HTTPS URLs on standard ports are allowed.");
  }
  const host = url.hostname.replace(/^\[|\]$/g,"").replace(/\.$/,"");
  if (ipaddr.isValid(host) ? !isPublicAddress(host) : !host.includes(".") || forbiddenNames.test(host)) {
    throw new Error("Local, private and reserved addresses are blocked.");
  }
  if ([...url.searchParams.keys()].some(name=>credentials.test(name))) {
    throw new Error("URLs containing credential parameters are blocked.");
  }
  const entries=[url.pathname,...url.searchParams.values()];
  if(entries.some(part=>{
    let text=part;
    try{text=decodeURIComponent(part)}catch{}
    return redactSecrets(text)!==text || /\b[A-Za-z]:[\\/](?:Users|Documents|Windows)[\\/]/i.test(text);
  }))throw new Error("URLs containing recognizable credentials or local paths are blocked.");
  url.hash = "";
  return url;
}

export function searchEndpoint(value) {
  if (value === "") return "";
  if(typeof value==="string"&&/^http:\/\/127\.0\.0\.1:\d{1,5}\/search$/.test(value))return new URL(value).href;
  const url = publicUrl(value);
  if (url.protocol !== "https:" || url.search || value.includes("#")) {
    throw new Error("Use a public HTTPS SearXNG URL or 127.0.0.1 with an explicit port and /search.");
  }
  return url.href;
}

export function isPublicAddress(value) {
  if (!ipaddr.isValid(value)) return false;
  const addr=ipaddr.parse(value);
  if (addr.range() !== "unicast") return false;
  if (addr.kind() === "ipv4") return !addr.match(ipaddr.parse("192.0.0.0"),24);
  return addr.match(ipaddr.parse("2000::"),3) &&
    !addr.match(ipaddr.parse("2001::"),23) && !addr.match(ipaddr.parse("3fff::"),20);
}

const agents={
  "http:":new http.Agent({keepAlive:false}),
  "https:":new https.Agent({keepAlive:false})
};
async function deadline(promise,signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      abort=()=>reject(signal.reason);
      signal.addEventListener("abort",abort,{once:true});
    })]);
  } finally {signal.removeEventListener("abort",abort)}
}

function request(url, address, signal) {
  return new Promise((resolve,reject)=>{
    const transport = url.protocol === "https:" ? https : http;
    const req=transport.get(url,{
      agent:agents[url.protocol], signal, maxHeaderSize:16384,
      lookup:(_host,options,callback)=>options.all ? callback(null,[address]) : callback(null,address.address,address.family),
      headers:{"User-Agent":"WiskHarness/0.7.4-beta.1 (https://github.com/itsfyze/WiskHarness)",
        Accept:"text/html, text/plain, text/markdown, application/json", "Accept-Encoding":"identity"}
    },resolve);
    req.once("error",reject);
  });
}

export function createPublicReader({resolve=lookup,send=request}={}) {
  return async function readPublic(value,{json=false,signal:callerSignal}={}) {
    const timeout=AbortSignal.timeout(12000);
    const signal=callerSignal?AbortSignal.any([callerSignal,timeout]):timeout;
    try {
      let url=publicUrl(value);
      for (let redirects=0; redirects<=4; redirects++) {
        const host=url.hostname.replace(/^\[|\]$/g,"");
        const addresses=await deadline(resolve(host,{all:true,verbatim:true}),signal);
        if (!addresses.length || addresses.some(({address})=>!isPublicAddress(address))) {
          throw new Error("The website resolves to a local, private or reserved address.");
        }
        // Pin the validated DNS answer through connection and retain the original TLS hostname.
        const res=await send(url,addresses[0],signal);
        try {
          if ([301,302,303,307,308].includes(res.statusCode)) {
            if (!res.headers.location || redirects===4) throw new Error("The website redirected too many times.");
            const next = publicUrl(new URL(res.headers.location,url).href);
            if (url.protocol==="https:" && next.protocol==="http:") throw new Error("An insecure website redirect was blocked.");
            url=next;
            continue;
          }
          if (res.statusCode!==200) throw new Error("The website returned HTTP "+res.statusCode+".");
          if (res.headers["content-encoding"] && res.headers["content-encoding"]!=="identity") {
            throw new Error("The website sent an unsupported compressed response.");
          }
          const type=(res.headers["content-type"]||"").split(";")[0].trim().toLowerCase();
          if (json ? type!=="application/json" : !["text/html","text/plain","text/markdown","application/xhtml+xml","application/json"].includes(type)) {
            throw new Error("The website response is not supported text.");
          }
          if(Number(res.headers["content-length"])>MAX_BYTES)throw new Error("The website response exceeds the 1 MiB limit.");
          const chunks=[];
          let bytes=0;
          for await(const chunk of res){
            bytes+=chunk.length;
            if(bytes>MAX_BYTES)throw new Error("The website response exceeds the 1 MiB limit.");
            chunks.push(chunk);
          }
          const text=Buffer.concat(chunks).toString("utf8");
          return {url:url.href,type,text};
        } finally {res.destroy()}
      }
    } catch(error) {
      if (timeout.aborted) throw new Error("The website did not respond within 12 seconds.");
      if (callerSignal?.aborted) throw new Error("The web request was cancelled.");
      if (error.code==="ENOTFOUND"||error.code==="EAI_AGAIN") throw new Error("The website hostname could not be resolved.");
      if (error.code) throw new Error("The website connection failed ("+error.code+").");
      throw error;
    }
  };
}

const cleanText=(html,limit)=>convert(html,{
  wordwrap:false,
  selectors:[
    {selector:"a",options:{ignoreHref:true}},
    ...["img","script","style","noscript","nav","header","footer","aside","form","svg"].map(selector=>({selector,format:"skip"}))
  ]
}).trim().slice(0,limit);

export function createAgentWeb({read=createPublicReader(),endpoint="",braveKey,fetcher=fetch}={}) {
  async function openPage(url,signal) {
    const page=await read(url,{signal});
    const text=page.type.includes("html")?cleanText(page.text,16000):page.text.trim().slice(0,16000);
    if (!text) throw new Error("This page did not contain readable text.");
    return "Source: "+page.url+"\n\n"+text;
  }
  async function searchWeb(query,source,signal) {
    if (/[\r\n\x00-\x1f]/.test(query) || !query.trim()) throw new Error("Enter a short public search query.");
    if(redactSecrets(query)!==query || /\b[A-Za-z]:[\\/]/.test(query)){
      throw new Error("Use public search terms without credentials or local file paths.");
    }
    const provider=source==="auto"?(endpoint||braveKey?"web":"technical"):source;
    if(provider==="web"&&braveKey)return searchBrave(query.trim(),braveKey,fetcher,signal);
    if(provider==="web"&&!endpoint) throw new Error("Configure a public SearXNG endpoint or Brave Search in Settings for broad web search. GitHub and Wikipedia search are available without setup.");
    const url=new URL(provider==="web"?endpoint:provider==="technical"?
      "https://api.github.com/search/issues":"https://en.wikipedia.org/w/rest.php/v1/search/page");
    url.searchParams.set("q",query.trim());
    url.searchParams.set(provider==="technical"?"per_page":provider==="web"?"format":"limit",provider==="web"?"json":"6");
    const response=provider==="web"&&url.hostname==="127.0.0.1"?{
      text:await fetchSearchJson(fetcher,url,{},signal,"Local SearXNG")
    }:await read(url.href,{json:true,signal});
    let data;
    try {data=JSON.parse(response.text)}
    catch {throw new Error("The search service returned invalid JSON.");}
    const results=provider==="web"?data.results:provider==="technical"?data.items:data.pages;
    if (!Array.isArray(results)) throw new Error("The search service did not return a result list.");
    const rendered=[];
    for (const item of results.slice(0,12)) {
      try{
        const link=publicUrl(provider==="web"?item.url:provider==="technical"?item.html_url:
          "https://en.wikipedia.org/wiki/"+encodeURIComponent(item.key)).href;
        rendered.push(String(item.title||"Result").slice(0,160)+"\n"+link+"\n"+
          cleanText(String(item.content||item.excerpt||item.body||"").slice(0,5000),250));
      }catch{}
      if(rendered.length===6)break;
    }
    return rendered.length?rendered.join("\n\n"):"No public results for this search.";
  }
  return {openPage,searchWeb};
}

async function searchBrave(query, getKey, fetcher, signal) {
  const url=new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q",query);url.searchParams.set("count","6");
  const text=await fetchSearchJson(fetcher,url,{"x-subscription-token":await getKey()},signal,"Brave Search");
  const hits=JSON.parse(text).web?.results;
  if(!Array.isArray(hits))return "No public results for this search.";
  return hits.slice(0,6).flatMap(item=>{
    try{return [String(item.title||"Result").slice(0,160)+"\n"+publicUrl(item.url).href+"\n"+
      cleanText(String(item.description||"").slice(0,5000),250)+(item.age?" · "+String(item.age).slice(0,40):"")];}
    catch{return [];}
  }).join("\n\n")||"No public results for this search.";
}

async function fetchSearchJson(fetcher,url,headers,signal,label){
  const timeout=AbortSignal.timeout(12000);
  const response=await fetcher(url,{headers:{accept:"application/json",...headers},
    redirect:"error",signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if(!response.ok||!response.body)throw new Error(label+" HTTP "+response.status);
  let text="",bytes=0;
  const decoder=new TextDecoder();
  for await(const chunk of response.body){
    bytes+=chunk.byteLength;
    if(bytes>MAX_BYTES)throw new Error(label+" response exceeds 1 MiB");
    text+=decoder.decode(chunk,{stream:true});
  }
  return text+decoder.decode();
}
