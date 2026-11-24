# Notes

## The field (read from the public leaderboards, 24 Nov 2026 ~14:00Z)

- This bounty's practice board: over 200 entries. 23 read 0 µs, 12 read 10 ms and the rest are spread from 20 to
  410 ms (net of the null entry, 10 ms ticks). Nearly every top-30 title is native: C or Rust N-API addons,
  "zero-libc", SSE2/AVX2 scanning, SYS_exit_group, a CommonJS entry that skips the ESM loader, a card cache shared
  across pages. A plain-JS entry will not reach the 30 contenders; the aim here is an exact, clearly faster drop-in.
- markdown-render-speed-02 (marked-derived Markdown, the closest analogue): the top JS entries ran 3.2-3.6x faster than
  the baseline using hand scanners, no token tree, first-character dispatch, and marked kept as a fallback.
- csv-reader-speed-01: every top entry is WASM SIMD behind a tiny CJS entry, with V8 background threads avoided and an
  immediate exit.
- sokoban-solver-01: its top entries load the program from an entry secret; nothing to reuse for speed here.

## What the cost is made of (this Mac, Node 22.22, CPU = user + sys of all threads, wait4 rusage)

- `node empty.js` 20 ms, `node empty.ts` 38 ms: type-stripping a .ts entry costs about 18 ms, but the null entry is a
  do-nothing program in the same runtime, so most of it is netted out.
- Baseline main.ts: 361 ms (about 323 net of an empty .ts).
- First solve.js: 222 ms (about 184 net), 1.75x on net CPU.
- Cold start dominates: the first case takes 67 ms, and the same case warm takes 10 ms. With `--single-threaded`, `run`
  takes 140 ms of wall time too, so most of the work is the interpreter, the JIT (on helper threads by default) and the GC.
- JSON.stringify of the 7.4 MB answer: about 17 ms. JSON.parse of the 2.9 MB input: about 6 ms.
- V8 flags set at run time (`setFlagsFromString`): --no-opt, --max-lazy, semi-space sizes: no measurable gain (semi-space
  sizes only act on the command line, where 64 MB saved about 26 ms). `process.reallyExit(0)` after the write: about
  -10 ms (no heap teardown).

## Correctness

- test/diff.mjs: the kit's generator on our own seeds, plus fuzzed sites (mutated sources, front matter, templates,
  paths, include cycles and depth-limit chains, odd base_url / per_page / recent), each built twice against the vendored
  reference. 600/600 identical for v1.

## Measured changes

| change | net CPU (ms) | note |
|---|---|---|
| baseline | 323 | |
| v1: own scanners + include cache | 184 | 1.75x |
| escaping and inline scanning on native regex (test/replace), not JS char loops | 150 | cold JS loops are the cost |
| `--no-opt --single-threaded-gc` via setFlagsFromString | 131 | TurboFan compiles cost more than they save in a 100 ms run |
| word count back on `match(/\S+/g)` | 96 | with TurboFan off the JS loop took 52 ms, native 10 ms |

Tried and dropped (no gain at 95%, so not worth the code):
- Building the answer as JSON text directly (pieces escaped once, no JSON.stringify pass): 134.2 vs 135.7 ms total.
- JSON.stringify per case right after it is built, to let its ropes die young: no change.
- --max-lazy, --no-lazy-feedback-allocation, --no-flush-bytecode, --no-maglev on top of --no-opt: no change.

Correctness for v2: test/diff.mjs runs strict (MF_STRICT=1: a throw in the fast build fails instead of falling back),
600 more seeds plus 12 hand-written sites (huge page, empty files, CRLF and lone CR, unicode slugs, list-like
lines, entities and raw HTML, missing index/tag/tags/layout templates, broken templates, no posts, statics shadowed by
pages, deep relative links).
