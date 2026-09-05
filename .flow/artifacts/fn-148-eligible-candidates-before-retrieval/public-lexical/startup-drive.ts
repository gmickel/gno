import { Client,StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const client=new Client({name:"fn148-lazy-startup",version:"1"});
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3349/mcp")));
const calls=[];
for(const name of ["gno_search","gno_vsearch"]){
 try{calls.push({name,result:await client.callTool({name,arguments:{query:"needle",limit:1,tagsAll:["approved"]}})});}
 catch(error){calls.push({name,error:String(error)});}
}
await client.close();
await Bun.write(new URL("startup-mcp.json",import.meta.url),JSON.stringify(calls,null,2));
console.log(JSON.stringify(calls.map(c=>({name:c.name,isError:c.result?.isError,error:c.error}))));
