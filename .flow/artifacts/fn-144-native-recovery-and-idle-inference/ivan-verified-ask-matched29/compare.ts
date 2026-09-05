import {join} from 'node:path';
const root=process.argv[2]??new URL('./raw',import.meta.url).pathname;
const cs=await Bun.file(join(root,'candidate/setup.json')).json();
const {compareAcceptance}=await import(new URL('../../../../evals/acceptance/compare.ts',import.meta.url).pathname);
const {canonicalJson}=await import(new URL('../../../../evals/agentic/canonical.ts',import.meta.url).pathname);
const rows=[];
for(const role of ['baseline','candidate']){
 const manifest=await Bun.file(join(root,role,'manifest.json')).json();
 const files=Array.from(new Bun.Glob('protocol/session-*/2.reply.json.gz').scanSync({cwd:join(root,role)}));
 if(files.length!==1)throw Error('Exactly one retained Ask required');
 const result=JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await Bun.file(join(root,role,files[0])).bytes()))).response.result;
 rows.push({manifest,result});
}
const verdict=compareAcceptance(rows[0].manifest,rows[1].manifest,[rows[0].result.record],[rows[1].result.record]);
const evidence={verdict,coverage:rows.map(r=>r.result.coverage),semantic:rows.map(r=>r.result.raw.verification.semantic),nativeModelOutputsEqual:canonicalJson(rows[0].result.receipt.modelOutputs)===canonicalJson(rows[1].result.receipt.modelOutputs)};

console.log(JSON.stringify(evidence));
