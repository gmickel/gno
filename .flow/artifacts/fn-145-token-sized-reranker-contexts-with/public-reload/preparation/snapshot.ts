import {join} from 'node:path';
const [source,dbPath]=process.argv.slice(2);
const {SqliteAdapter}=await import(join(source!,'src/store/sqlite/adapter.ts'));
const {captureContextEvidenceSnapshot}=await import(join(source!,'src/core/context-evidence.ts'));
const store=new SqliteAdapter();
try{const opened=store.openReadOnly(dbPath);if(!opened.ok)throw Error(JSON.stringify(opened.error));console.log(JSON.stringify(await captureContextEvidenceSnapshot(store,'default',['probe'])));}finally{await store.close();}
