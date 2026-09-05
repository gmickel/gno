const events: unknown[] = [];
let job = 0;
let release: (() => void) | undefined;
Bun.serve({ hostname: '127.0.0.1', port: 43953, async fetch(req) {
 const url = new URL(req.url);
 if(url.pathname === '/qa/events') return Response.json(events);
 if(url.pathname === '/qa/release') { release?.(); release = undefined; return new Response('released'); }
 if(url.pathname === '/api/sync') return Response.json({jobId: `qa-${++job}`});
 if(url.pathname.startsWith('/api/jobs/')) {
   const id = url.pathname.split('/').at(-1)!;
   events.push({event:'request', id, at: Date.now()});
   if(id === 'qa-1') await new Promise<void>(resolve => { release = resolve; });
   events.push({event:'response', id, at: Date.now()});
   return Response.json({id, type:'sync', status:'running', createdAt: Date.now()});
 }
 const upstream = await fetch('http://127.0.0.1:43952'+url.pathname+url.search, {method:req.method, headers:req.headers, body: req.method === 'GET'||req.method==='HEAD' ? undefined : await req.arrayBuffer()});
 const headers = new Headers(upstream.headers);
 headers.delete('content-encoding'); headers.delete('content-length');
 return new Response(await upstream.arrayBuffer(), {status:upstream.status,headers});
}});
