const root=import.meta.dir;
const source=process.env.QA_SOURCE!;
const {Client}=await import(`${source}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const {StdioClientTransport}=await import(`${source}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`);
const query='cobalt observatory dawn';
const mcp=new Client({name:'fn147-synthetic-qa',version:'1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[`${source}/src/index.ts`,'mcp','serve'],cwd:source,env:process.env as Record<string,string>,stderr:'pipe'});
let stderr='';
transport.stderr?.on('data',(x:any)=>{stderr+=String(x)});
try {
 await mcp.connect(transport);
 for(const [name,args] of [['gno_search',{query,limit:10}],['gno_vsearch',{query,limit:10}],['gno_changes',{limit:100}]] as const){
  let response;try{response=await mcp.callTool({name,arguments:args});}catch(e){response={error:String(e)}}
  await Bun.write(`${root}/evidence/mcp-${name}.json`,JSON.stringify(response,null,2));
 }
}finally{await mcp.close();await Bun.write(`${root}/evidence/mcp.stderr`,stderr);}
const holder=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=holder.port;holder.stop(true);
const proc=Bun.spawn([process.execPath,`${source}/src/index.ts`,'serve','--host','127.0.0.1','--port',String(port)],{cwd:source,env:process.env,stdout:Bun.file(`${root}/evidence/api.stdout`),stderr:Bun.file(`${root}/evidence/api.stderr`)});
const base=`http://127.0.0.1:${port}`;
try {
 let ready=false;for(let n=0;n<100;n++){try{const r=await fetch(`${base}/api/status`);if(r.ok){ready=true;await Bun.write(`${root}/evidence/api-status.json`,await r.text());break}}catch{}await Bun.sleep(200)}
 if(!ready)throw Error('API not ready');
 for(const [name,path,body] of [['search','/api/search',{query,limit:10}],['query','/api/query',{query,limit:10,noExpand:true,noRerank:true}],['changes','/api/changes?limit=100',null]] as const){
  const response=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  await Bun.write(`${root}/evidence/api-${name}.json`,JSON.stringify({status:response.status,body:await response.json()},null,2));
 }
} finally {proc.kill('SIGTERM');await proc.exited;await Bun.write(`${root}/evidence/api-receipt.json`,JSON.stringify({port,pid:proc.pid,exitCode:proc.exitCode}));}
