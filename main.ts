// Reads every case from /input/cases.json, answers each alone with run() from solve.js and writes
// /output/answers.json. MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output outside a container.
import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking');
import { run } from './solve.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(`${inDir}/cases.json`, 'utf8'));
const answers = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(`${outDir}/answers.json`, JSON.stringify(answers));
// The file is written (synchronously): leave without tearing the heap down.
process.reallyExit(0);
