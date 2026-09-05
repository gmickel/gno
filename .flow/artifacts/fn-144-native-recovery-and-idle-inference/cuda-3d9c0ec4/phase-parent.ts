const source = process.env.QA_SOURCE!;
const entry = `${source}/src/llm/native-worker/entry.ts`;
const spawn = Bun.spawn;
Bun.spawn = function(options: any, ...other: any[]) {
  if (options && !Array.isArray(options) && options.cmd?.includes(entry)) {
    const child = spawn({ ...options, cmd: [options.cmd[0], '--preload', `${import.meta.dir}/phase-child.ts`, ...options.cmd.slice(1)], env: { ...options.env, QA_PHASE_SOURCE: source, QA_PHASE_DIRECTORY: `${import.meta.dir}/evidence/phases` } });
    return child;
  }
  return Reflect.apply(spawn, Bun, [options, ...other]);
} as typeof Bun.spawn;
