import {Marked} from "/markdown-dependencies/marked.js";
import DOMPurify from "/markdown-dependencies/purify.js";
import highlight from "/markdown-dependencies/highlight.js";

const markdown=new Marked({gfm:true});
markdown.use({renderer:{
  html({text}){
    return text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
}});
const allowed={
  RETURN_DOM_FRAGMENT:true,
  ALLOWED_TAGS:["a","b","blockquote","br","code","del","em","h1","h2","h3","h4","h5","h6","hr",
    "li","ol","p","pre","s","span","strong","table","tbody","td","th","thead","tr","ul"],
  ALLOWED_ATTR:["href","title","start","class","align"],
  ALLOW_DATA_ATTR:false,
  ALLOW_ARIA_ATTR:false,
  ALLOWED_URI_REGEXP:/^https?:\/\//i
};
async function copy(text){
  try{await navigator.clipboard.writeText(text);return true}catch{}
  const previous=document.activeElement;
  const field=document.createElement("textarea");
  field.value=text;
  field.className="markdown-copy-field";
  document.body.append(field);
  field.select();
  try{return document.execCommand("copy")}
  finally{field.remove();previous?.focus({preventScroll:true})}
}
export function highlightedLine(value,language){
  if(!language||value.length>440||!highlight.getLanguage(language))return null;
  const syntax=highlight.highlight(value,{language,ignoreIllegals:true}).value;
  return DOMPurify.sanitize(syntax,{ALLOWED_TAGS:["span"],ALLOWED_ATTR:["class"]});
}

export function renderMarkdown(element,text,{streaming=false,onFile}={}){
  const source=String(text??"");
  if(!source){element.replaceChildren();return}
  const localFile=/^(?:\.\/)?[a-z0-9_][a-z0-9_./% -]{0,800}\.[a-z0-9]{1,12}$/i;
  const fragment=DOMPurify.sanitize(markdown.parse(source),onFile?
    {...allowed,ALLOWED_URI_REGEXP:/^(?:https?:\/\/|(?:\.\/)?[a-z0-9_][a-z0-9_./% -]{0,800}\.[a-z0-9]{1,12}$)/i}:allowed);
  for(const link of fragment.querySelectorAll("a[href]")){
    const href=link.getAttribute("href");
    if(onFile&&localFile.test(href)){
      let selected;
      try{selected=decodeURIComponent(href);}catch{selected=null;}
      if(selected&&localFile.test(selected)&&!selected.split("/").includes("..")){
        const button=document.createElement("button");
        button.type="button";button.className="inline-file";button.textContent=link.textContent;
        button.onclick=()=>onFile(selected);link.replaceWith(button);continue;
      }
    }
    const url=URL.parse(href);
    if(!url||url.username||url.password){link.removeAttribute("href");continue}
    link.target="_blank";
    link.rel="noopener noreferrer";
  }
  for(const table of fragment.querySelectorAll("table")){
    const wrapper=document.createElement("div");
    wrapper.className="markdown-table";
    wrapper.tabIndex=0;
    wrapper.setAttribute("role","region");
    wrapper.setAttribute("aria-label","Markdown table");
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  for(const block of fragment.querySelectorAll("pre")){
    const code=block.querySelector("code");
    if(!code)continue;
    const language=[...code.classList].find(value=>value.startsWith("language-"))?.slice(9).toLowerCase();
    code.removeAttribute("class");
    const value=code.textContent;
    if(!streaming&&language&&value.length<=24000&&highlight.getLanguage(language)){
      const syntax=highlight.highlight(value,{language,ignoreIllegals:true}).value;
      code.replaceChildren(DOMPurify.sanitize(syntax,{...allowed,ALLOWED_TAGS:["span"],ALLOWED_ATTR:["class"]}));
    }
    const wrapper=document.createElement("div");
    wrapper.className="markdown-code";
    const bar=document.createElement("div");
    bar.className="markdown-code-bar";
    const label=document.createElement("span");
    label.textContent=language||"Code";
    const button=document.createElement("button");
    button.type="button";
    button.className="btn btn-small";
    button.textContent="Copy code";
    button.onclick=async()=>{
      let copied=false;
      try{copied=await copy(value)}catch{}
      button.textContent=copied?"Copied":"Copy failed";
      setTimeout(()=>{button.textContent="Copy code"},1700);
    };
    bar.append(label,button);
    block.replaceWith(wrapper);
    wrapper.append(bar,block);
  }
  element.replaceChildren(fragment);
}
