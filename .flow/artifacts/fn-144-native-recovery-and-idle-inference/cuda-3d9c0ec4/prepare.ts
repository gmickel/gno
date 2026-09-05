import { mkdir } from 'node:fs/promises';
const root=import.meta.dir;
for(const name of ['home','config','data','cache','state','corpus','other','evidence']) await mkdir(`${root}/${name}`,{recursive:true});
const model='file:/home/gordon/.cache/gno/models/hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf';
const config={version:'1.0',ftsTokenizer:'unicode61',busyTimeoutMs:60000,collections:[{name:'identity',path:`${root}/corpus`,pattern:'**/*.md',include:[],exclude:[]},{name:'other',path:`${root}/other`,pattern:'**/*.md',include:[],exclude:[]}],contexts:[],projectAffinity:{enabled:false,contribution:0.03},models:{activePreset:'synthetic',presets:[{id:'synthetic',name:'Synthetic embedding only',embed:model,rerank:model,gen:model}],warmModelTtl:300000}};
await Bun.write(`${root}/config/index.yml`,Bun.YAML.stringify(config));
await Bun.write(`${root}/corpus/Alpha.md`,'The cobalt observatory opens at dawn.\n');
await Bun.write(`${root}/other/Delta.md`,'The copper laboratory closes at midnight.\n');
await Bun.write(`${root}/evidence/config.json`,JSON.stringify(config,null,2));
