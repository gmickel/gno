import {compareAcceptance} from '../../../../evals/acceptance/compare.ts';
const baseline=import.meta.dir;
const candidate=`${import.meta.dir}/raw`;
const bm=await Bun.file(`${baseline}/original-baseline-manifest.json`).json();
const cm=await Bun.file(`${candidate}/manifest.json`).json();
const b=JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await Bun.file(`${baseline}/original-baseline.json.gz`).arrayBuffer())));
const glob=new Bun.Glob('protocol/session-*/2.reply.json.gz');
const files=Array.from(glob.scanSync({cwd:candidate}));
if(files.length!==1)throw Error('Expected exact one Ask receipt');
const c=JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await Bun.file(`${candidate}/${files[0]}`).arrayBuffer()))).response.result;
let result:unknown;
try{result=compareAcceptance(bm,cm,[b.record],[c.record]);}catch(error){result={passed:false,error:String(error)}}
await Bun.write(`${import.meta.dir}/comparison.reproduced.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
