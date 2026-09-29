// TEMPORARY (fn-201 R1): loop the Windows concurrency test until it hangs.
// Removed before the branch merges.
const runs = Number(process.argv[2] ?? "40");
const file = process.argv[3] ?? "test/cli/concurrency.test.ts";
let failures = 0;
for (let run = 1; run <= runs; run += 1) {
  const started = performance.now();
  const proc = Bun.spawn({
    cmd: ["bun", "test", "--max-concurrency=1", "--timeout", "20000", file],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "true" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ms = Math.round(performance.now() - started);
  console.log(`run ${run}: exit ${code} in ${ms} ms`);
  if (code === 0 && (run === 1 || err.includes("FN201_SLOW"))) {
    console.log(`FN201_TRACE run ${run}\n${err}`);
  }
  if (code !== 0) {
    failures += 1;
    console.log(`::group::run ${run} output`);
    console.log(out);
    console.log(err);
    console.log("::endgroup::");
    console.log(`FN201_FAILURE run ${run}\n${err}`);
  }
}
console.log(`fn201 loop: ${failures} failure(s) in ${runs} runs`);

export {};
