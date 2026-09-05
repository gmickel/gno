// Synthetic QA harness; filesystem structure/path APIs have no Bun equivalent.
import { mkdir, rename, unlink } from 'node:fs/promises';
import { Database } from 'bun:sqlite';
const root=import.meta.dir;
const source=process.env.QA_SOURCE!;
const {createGnoClient}=await import(`${source}/src/sdk/client.ts`);
const config=await Bun.file(`${root}/evidence/config.json`).json();
const dbPath=`${root}/data/index-default.sqlite`;
const query='cobalt observatory dawn';
const hash=(x:string|Uint8Array)=>new Bun.CryptoHasher('sha256').update(x).digest('hex');
const receipts:any[]=[];
let client:any;
async function open(path=dbPath){return createGnoClient({config,dbPath:path,downloadPolicy:{offline:true,allowDownload:false}});}
function snapshot(path=dbPath){
 const db=new Database(path,{readonly:true});
 try {
 const owners=db.query(`SELECT d.rel_path,d.collection,d.source_hash,d.mirror_hash,d.title,c.seq,c.text,o.partition_id,v.input_hash,v.embedding FROM documents d JOIN content_chunks c ON c.mirror_hash=d.mirror_hash LEFT JOIN vector_owners o ON o.document_id=d.id AND o.seq=c.seq LEFT JOIN vector_variants v ON v.variant_id=o.variant_id WHERE d.active=1 ORDER BY d.collection,d.rel_path,c.seq`).all().map((r:any)=>({...r,embedding:r.embedding?hash(r.embedding):null}));
 const partitions=db.query('SELECT * FROM vector_partitions ORDER BY partition_id').all();
 const events=db.query('SELECT change_kind,new_rel_path,old_active,new_active,old_source_hash,new_source_hash,old_mirror_hash,new_mirror_hash FROM document_changes ORDER BY sequence').all();
 return {owners,partitions,events};
 }finally{db.close();}
}
async function result(operation:()=>Promise<unknown>){try{return {ok:true,value:await operation()}}catch(e){return {ok:false,error:String(e)}}}
async function checkpoint(name:string, options:any={}){
 const before=snapshot();
 const embed=await result(()=>client.embed(options));
 const keyword=await result(()=>client.search(query,{limit:10}));
 const semantic=await result(()=>client.vsearch(query,{limit:10}));
 const changes=await result(()=>client.changes({limit:100}));
 const current=snapshot();
 await client.close();
 const cleanPath=`${root}/data/clean-${name}.sqlite`;
 const clean=await open(cleanPath);
 const cleanUpdate=await clean.update();
 const cleanEmbed=await result(()=>clean.embed());
 const cleanKeyword=await result(()=>clean.search(query,{limit:10}));
 const cleanSemantic=await result(()=>clean.vsearch(query,{limit:10}));
 const rebuilt=snapshot(cleanPath);
 await clean.close();
 const receipt={name,before,embed,keyword,semantic,changes,current,cleanUpdate,cleanEmbed,cleanKeyword,cleanSemantic,rebuilt,ownerExactEquality:JSON.stringify(current.owners)===JSON.stringify(rebuilt.owners),keywordResultsEquality:keyword.ok&&cleanKeyword.ok&&JSON.stringify((keyword as any).value.results)===JSON.stringify((cleanKeyword as any).value.results),semanticResultsEquality:semantic.ok&&cleanSemantic.ok&&JSON.stringify((semantic as any).value.results)===JSON.stringify((cleanSemantic as any).value.results)};
 receipts.push(receipt);await Bun.write(`${root}/evidence/matrix-${name}.json`,JSON.stringify(receipt,null,2));
 console.log(JSON.stringify({name,embed,ownerExactEquality:receipt.ownerExactEquality,semanticResultsEquality:receipt.semanticResultsEquality}));
 client=await open();
}
try {
 client=await open();
 await checkpoint('initial');
 await Bun.write(`${root}/corpus/Alpha.md`,'The cobalt observatory opens at dawn.  \r\n\r\n');
 await client.update();await checkpoint('whitespace');
 await client.update();await checkpoint('unchanged');
 for(let cycle=1;cycle<=2;cycle++){
  await unlink(`${root}/corpus/Alpha.md`);await client.update();
  await checkpoint(`absent-${cycle}`);
  await client.update();
  await Bun.write(`${root}/corpus/Alpha.md`,'The cobalt observatory opens at dawn.  \r\n\r\n');
  await client.update();await checkpoint(`restored-${cycle}`);
 }
 await mkdir(`${root}/corpus/copy`,{recursive:true});
 await Bun.write(`${root}/corpus/copy/Alpha.md`,'The cobalt observatory opens at dawn.\n');
 await client.update();await checkpoint('same-title-duplicate');
 await rename(`${root}/corpus/copy/Alpha.md`,`${root}/corpus/copy/Beta.md`);
 await client.update();await checkpoint('title-rename');
 await checkpoint('force',{force:true});
 await client.close();
 const db=new Database(dbPath);const partition=db.query('SELECT partition_id FROM vector_partitions LIMIT 1').get() as any;
 const sqliteVec=await import(`${source}/node_modules/sqlite-vec/index.mjs`).catch(()=>import('sqlite-vec'));
 sqliteVec.load(db);db.exec(`DROP TABLE vec_v1_${partition.partition_id}`);db.close();
 client=await open();await checkpoint('materialization-repair');
 await Bun.write(`${root}/corpus/Scope.md`,'The cobalt observatory telescope uses a quartz lens.\n');
 await Bun.write(`${root}/other/Scope.md`,'The copper laboratory uses an argon chamber.\n');
 await client.update();
 const scopeBefore=snapshot();const scopeEmbed=await client.embed({collection:'identity'});const scopeAfter=snapshot();
 await Bun.write(`${root}/evidence/collection-scope.json`,JSON.stringify({scopeBefore,scopeEmbed,scopeAfter},null,2));
 await checkpoint('collection-global-catchup');
} finally {await client?.close();await Bun.write(`${root}/evidence/matrix-summary.json`,JSON.stringify(receipts.map(({name,ownerExactEquality,keywordResultsEquality,semanticResultsEquality})=>({name,ownerExactEquality,keywordResultsEquality,semanticResultsEquality})),null,2));}
