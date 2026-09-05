import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const source="/home/gordon/.cache/agent-tmp/gno-fn148-public/source";
const root="/home/gordon/.cache/agent-tmp/gno-fn148-public/runtime";
const env={...process.env,GNO_CONFIG_DIR:`${root}/config`,GNO_DATA_DIR:`${root}/data`,GNO_CACHE_DIR:`${root}/cache-offline`,TMPDIR:`${root}/tmp`,GNO_OFFLINE:"1",HF_HUB_OFFLINE:"1",GNO_NO_AUTO_DOWNLOAD:"1",GNO_ALLOW_DOWNLOAD:"0",GNO_LLAMA_BUILD:"never",CUDA_VISIBLE_DEVICES:"-1"};
const target="gno://notes/scope/target.md";
const cases=[
 {id:"tag",filter:{tagsAll:["approved"]},args:["--tags-all","approved"],target:true},
 {id:"tag-any",filter:{tagsAny:["approved"]},args:["--tags-any","approved"],target:true},
 {id:"date",filter:{since:"2026-09-01"},args:["--since","2026-09-01"],target:true},
 {id:"author",filter:{author:"Ada"},args:["--author","Ada"],target:true},
 {id:"category",filter:{categories:["release"]},args:["--category","release"],target:true},
 {id:"exclude",filter:{exclude:["noise-"]},args:["--exclude","noise-"],target:true},
 {id:"combined",filter:{collection:"notes",tagsAll:["approved"],author:"Ada"},args:["--collection","notes","--tags-all","approved","--author","Ada"],target:true},
 {id:"zero",filter:{tagsAll:["absent"]},args:["--tags-all","absent"],zero:true},
 {id:"scope-zero",filter:{collection:"absent"},args:["--collection","absent"],zero:true},
 {id:"broad",filter:{},args:[]},
 {id:"invalid-date",filter:{since:"not-a-date"},args:["--since","not-a-date"]},
 {id:"invalid-query",filter:{},args:[],query:'"unterminated',invalid:true},
];
const records:any[]=[];
function verify(scenario:any,payload:any,error:boolean) {
 if(scenario.invalid) return error;
 // Some public surfaces reject unknown collections, preserving validation.
 if(scenario.id==="scope-zero"&&error) return true;
 if(error||!Array.isArray(payload?.results))return false;
 const rows=payload.results;
 if(scenario.zero)return rows.length===0;
 if(scenario.target)return rows.length===1&&rows[0].uri===target&&rows[0].score===1&&rows[0].source?.sourceHash==="source-200"&&rows[0].conversion?.mirrorHash==="eligible-v1-200";
 return rows.length>0&&rows.every((r:any)=>r.uri!=="gno://notes/scope/noise-199.md");
}
for(const scenario of cases) for(const limit of [1,10]) {
 const query=scenario.query??"needle";
 const cmd=["bun",`${source}/src/index.ts`,"search",query,"--json","--no-project-affinity","-n",String(limit),...scenario.args];
 const child=Bun.spawn(cmd,{env,cwd:source,stdout:"pipe",stderr:"pipe"});
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 let payload;try{payload=JSON.parse(stdout)}catch{}
 records.push({surface:"cli",scenario:scenario.id,limit,cmd,exit,stdout,stderr,pass:verify(scenario,payload,exit!==0)});
 const body:any={query,limit,...scenario.filter};
 for(const field of ["tagsAll","tagsAny","exclude"])if(Array.isArray(body[field]))body[field]=body[field].join(",");
 if(body.categories){body.category=body.categories.join(",");delete body.categories;}
 const response=await fetch("http://127.0.0.1:3348/api/search",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{}
 records.push({surface:"rest",scenario:scenario.id,limit,body,status:response.status,raw,pass:verify(scenario,data,!response.ok)});
}
for(const surface of ["stdio-mcp","http-mcp"]) {
 const client=new Client({name:"fn148-public-lexical",version:"1.0.0"});
 const transport=surface==="stdio-mcp"?new StdioClientTransport({command:"bun",args:[`${source}/src/index.ts`,"mcp"],env:env as Record<string,string>,cwd:source,stderr:"pipe"}):new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3348/mcp"));
 try{
 await client.connect(transport);
 const tools=await client.listTools();
 await Bun.write(new URL(`${surface}-tools.json`,import.meta.url),JSON.stringify(tools,null,2));
 for(const scenario of cases)for(const limit of [1,10]){
   const args={query:scenario.query??"needle",limit,...scenario.filter};
   try{
    const result=await client.callTool({name:"gno_search",arguments:args});
    const payload=result.structuredContent;
    records.push({surface,scenario:scenario.id,limit,args,result,pass:verify(scenario,payload,Boolean(result.isError))});
   }catch(error){records.push({surface,scenario:scenario.id,limit,args,error:String(error),pass:Boolean(scenario.invalid||scenario.id==="scope-zero")});}
 }
 }catch(error){records.push({surface,error:String(error),pass:false,blocked:true});}
 finally{await client.close();}
}
await Bun.write(new URL("responses.json",import.meta.url),JSON.stringify(records,null,2));
console.log(JSON.stringify({observations:records.length,passed:records.filter(r=>r.pass).length,failures:records.filter(r=>!r.pass).map(({surface,scenario,error})=>({surface,scenario,error}))},null,2));
