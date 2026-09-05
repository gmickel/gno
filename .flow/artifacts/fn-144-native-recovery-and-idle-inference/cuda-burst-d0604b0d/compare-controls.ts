const root=import.meta.dir;
const {compareAcceptance}=await import(`${root}/helper-source/evals/acceptance/compare.ts`);
const comparisons=[];
for(const workload of ["warm30","original143"]){
 const baseline=await Bun.file(`${root}/observations/capture-${workload}-baseline-complete-helpers/result.json`).json();
 const candidate=await Bun.file(`${root}/observations/capture-${workload}-candidate-complete-helpers/result.json`).json();
 for(let index=0;index<2;index++){
  const a=baseline.results[index],b=candidate.results[index];
  const comparison=compareAcceptance(baseline.plan.manifest,candidate.plan.manifest,[a.record],[b.record]);
  const negative=structuredClone(b.record);negative.deterministic.results[0].score+=0.01;
  const rejection=compareAcceptance(baseline.plan.manifest,candidate.plan.manifest,[a.record],[negative]);
  comparisons.push({workload,phase:a.phase,coverage:[a.coverage,b.coverage],comparison,fullResultArrayExact:JSON.stringify(a.raw.results)===JSON.stringify(b.raw.results),negativeRejected:!rejection.passed});
 }
}
await Bun.write(`${root}/control-comparisons.json`,JSON.stringify(comparisons,null,2));
console.log(JSON.stringify(comparisons));
