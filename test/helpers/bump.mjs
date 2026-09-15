// Child process for the lock stress test: increments `count` N times, using
// the sync or async API as told, then reports how many increments succeeded.
//   node bump.mjs <file> <iterations> <sync|async>
import { createContext } from "../../dist/index.js";

const [file, iterations, mode] = process.argv.slice(2);
const ctx = createContext(file, { defaults: { count: 0 } });
let done = 0;

for (let i = 0; i < Number(iterations); i++) {
  const result =
    mode === "sync"
      ? ctx.update("count", (n) => n + 1)
      : await ctx.updateAsync("count", (n) => n + 1);
  if (!result.ok) {
    console.error(result.error.message);
    process.exit(1);
  }
  done++;
}

process.stdout.write(String(done));
