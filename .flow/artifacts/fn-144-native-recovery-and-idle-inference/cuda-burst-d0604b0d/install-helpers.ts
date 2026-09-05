const root = import.meta.dir;
const {installSessionHarness} = await import(`${root}/helper-source/evals/acceptance/session-driver.ts`);
await installSessionHarness(`${root}/baseline-capture-source`);
await installSessionHarness(`${root}/packed/package`);
console.log("Pinned development helpers installed; product files untouched");
