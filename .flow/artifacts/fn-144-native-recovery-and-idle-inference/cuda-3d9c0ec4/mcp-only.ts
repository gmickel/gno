const root=import.meta.dir;
const source=process.env.QA_SOURCE!;
const {Client}=await import(`${source}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const {StdioClientTransport}=await import(`${source}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`);
const query='cobalt observatory dawn';
const mcp=new Client({name:'fn147-synthetic-qa',version:'1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:['--preload',`${root}/phase-parent.ts`,'--preload',`${source}/evals/acceptance/parent-capture.ts`,`${source}/src/index.ts`,'mcp','serve'],cwd:source,env:{...process.env,GNO_ACCEPTANCE_CAPTURE:`${root}/evidence/mcp-child.capture.json`} as Record<string,string>,stderr:'pipe'});
let stderr='';
transport.stderr?.on('data',(x:any)=>{stderr+=String(x)});
try {
 await mcp.connect(transport);
 for(const [name,args] of [['gno_search',{query,limit:10}],['gno_vsearch',{query,limit:10}],['gno_changes',{limit:100}]] as const){
  let response;try{response=await mcp.callTool({name,arguments:args});}catch(e){response={error:String(e)}}
  await Bun.write(`${root}/evidence/mcp-${name}.json`,JSON.stringify(response,null,2));
 }
}finally{await mcp.close();await Bun.write(`${root}/evidence/mcp.stderr`,stderr);}
