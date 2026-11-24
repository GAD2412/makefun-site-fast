// Differential test: solve.js against makefun-site 1.0.0 (the kit's vendored reference), byte for byte.
//
//   node test/diff.mjs <kit dir> [generated sites] [fuzz sites] [first seed]
//
// 1. Sites drawn by the kit's own generator (program/generator/subject/sites.mjs) from seeds of our own.
// 2. Fuzzed sites: generated sites whose sources, front matter, templates and paths are mutated with the characters
//    and constructs the reference treats specially, plus hand-written nasty files.
// Every site is built twice by solve.js (fresh input copies); both builds must equal the reference's.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const kit = process.argv[2];
const nGen = Number(process.argv[3] ?? 300);
const nFuzz = Number(process.argv[4] ?? 300);
const first = Number(process.argv[5] ?? 0);
const { generate } = await import(pathToFileURL(`${kit}/program/generator/subject/sites.mjs`).href);
const { Rng } = await import(pathToFileURL(`${kit}/program/generator/rng.ts`).href);
const { build } = await import(pathToFileURL(`${kit}/baselines/makefun-site/vendor/makefun-site/index.js`).href);
const { run } = await import(new URL('../solve.js', import.meta.url).href);

const rngOf = (label) => new Rng(createHash('sha256').update(`diff-test\n${label}`).digest());
const copy = (x) => JSON.parse(JSON.stringify(x));

let failures = 0;
function check(label, input) {
  const text = JSON.stringify(input);
  let want;
  try {
    want = JSON.stringify(build(JSON.parse(text)));
  } catch (e) {
    want = `THROWS ${e && e.constructor && e.constructor.name}`;
  }
  for (let k = 0; k < 2; k++) {
    let got;
    try {
      got = JSON.stringify(run(JSON.parse(text)));
    } catch (e) {
      got = `THROWS ${e && e.constructor && e.constructor.name}`;
    }
    if (got !== want) {
      failures++;
      if (failures <= 5) {
        const a = got.startsWith('THROWS') ? {} : JSON.parse(got);
        const b = want.startsWith('THROWS') ? {} : JSON.parse(want);
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        console.log(`DIFF ${label} (run ${k + 1})`, got.startsWith('THROWS') ? got : '', want.startsWith('THROWS') ? want : '');
        for (const key of keys) {
          if (a[key] === b[key]) continue;
          const s = String(a[key]);
          const t = String(b[key]);
          let j = 0;
          while (j < s.length && s[j] === t[j]) j++;
          console.log(`  ${key}\n    mine: ${JSON.stringify(s.slice(Math.max(0, j - 100), j + 100))}\n    ref:  ${JSON.stringify(t.slice(Math.max(0, j - 100), j + 100))}`);
          break;
        }
        if (process.env.DUMP) {
          import('node:fs').then((fs) => fs.writeFileSync(`/tmp/claude-501/fail-${failures}.json`, text));
        }
      }
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- fuzzing

const ATOMS = [
  '*', '**', '***', '_', '`', '``', '\\', '\\*', '\\\\', '[', ']', '(', ')', '](', '[a](b)', '[x](#y)', '[t](../a.md)',
  '[t](a b)', '[t]()', '[*a*](c)', '#', '## ', '###### ', '####### ', '>', '> ', '- ', '* ', '1. ', '07. ', '1234567890. ',
  '---', '***', '```', '```js', '``` ', '  ', '\t', ' ', '\n', '\n\n', '\n  ', '&', '<', '>', '"', "'", '&amp;',
  '<b>', '{', '}', '{{', '}}', '{%', '%}', 'é', 'é', 'ﬁ', 'Ｗ', '東京', ' ', ' ', '﻿', '́',
  '😀', 'word', 'Word', 'a', 'z', '9', '.', '!', '+', '-', '=', '===', '\r', '\r\n', ':', 'x',
];
const pick = (rng, xs) => xs[rng.int(0, xs.length - 1)];
const fuzzText = (rng, n) => Array.from({ length: n }, () => pick(rng, ATOMS)).join(rng.chance(0.5) ? '' : ' ');

const FM_LINES = [
  'title: ', 'title: "q\\"x"', 'title: "a\\b"', 'title: "unclosed', 'title: [x]', 'title:', 'title:x', 'title:  two',
  'date: 2024-02-29', 'date: 2023-02-29', 'date: 1969-12-31', 'date: 2099-12-31', 'date: 2026-1-01', 'tags: []',
  'tags: [ ]', 'tags: [a,,b]', 'tags: [Café, cafe, CAFE]', 'tags: [a, "b"]', 'tags: [Q&A, C++, C#]', 'draft: true',
  'draft: false', 'draft: TRUE', 'layout: wide', 'layout: post', 'layout: index', 'layout: Nope', 'slug: a-b',
  'slug: a--b', 'slug: -a', 'slug: index', 'slug: posts', 'slug: tags', 'summary: s <b> & "q"', 'summary: "x"',
  '# comment', '', '   ', '\t', ' title: x', 'TITLE: x', 'title : x', 'unknown_key: v', 'title: trailing  \t',
];

function fuzzSource(rng, base) {
  const lines = ['---'];
  const n = rng.int(0, 5);
  for (let k = 0; k < n; k++) {
    const l = pick(rng, FM_LINES);
    lines.push(l === 'title: ' ? `title: ${fuzzText(rng, rng.int(1, 4)).replace(/\n|\r/g, ' ')}` : l);
  }
  if (rng.chance(0.8)) lines.push(`title: ${pick(rng, ['T', 'Same Title', 'café', '東京', '***', 'x'.repeat(80), 'A-B C'])}`);
  if (rng.chance(0.85)) lines.push('---');
  let body = '';
  const blocks = rng.int(0, 12);
  for (let k = 0; k < blocks; k++) body += fuzzText(rng, rng.int(1, 14)) + pick(rng, ['\n', '\n\n', '\n  ', '\n> ', '\n- ', '\n1. ', '']);
  let text = `${lines.join('\n')}\n${body}`;
  if (rng.chance(0.05)) text = text.replace(/\n/g, '\r\n');
  if (rng.chance(0.03)) text = '';
  if (rng.chance(0.03)) text = '---';
  if (rng.chance(0.03)) text = '---\ntitle: x\n---';
  return text + (base ?? '');
}

const TPL_ATOMS = [
  '{{ page.title }}', '{{page.title}}', '{{{ page.content }}}', '{{ page }}', '{{ page.tags }}', '{{ tags }}',
  '{{ site.title }}', '{{ loop.index }}', '{{ x }}', '{{ x.name }}', '{{ x.length }}', '{{ posts.length }}', '{{ 1x }}',
  '{{ a..b }}', '{{', '}}', '{', '}', '{%', '%}', '{% if page %}', '{% if not page.newer %}', '{% if recent %}',
  '{% else %}', '{% endif %}', '{% for x in tags %}', '{% for x in recent %}', '{% for loop in tags %}',
  '{% for x in page.toc %}', '{% endfor %}', '{% include "card" %}', '{% include "self" %}', '{% include "nope" %}',
  '{% include "a" %}', '{% bogus %}', '{%if page%}', '\n', '\n  ', '  ', '\t', 'text', '<p>', '"', '&', 'é', '\n{% if page %}\n',
  '\n{% endif %}\n', '  {% for x in tags %}  \n', '\n{% endfor %}', '{{ page.reading_minutes }}', '{{ page.is_post }}',
  '{{ pager.number }}', '{{ tag.count }}', '{{ x.posts }}', '{{{ x.excerpt }}}',
];
const tplText = (rng, n) => Array.from({ length: n }, () => pick(rng, TPL_ATOMS)).join('');

function fuzzSite(rng, k) {
  const site = generate(rng, k % 3);
  // Mutate a share of the sources.
  for (const f of site.files) {
    if (!f.path.endsWith('.md')) continue;
    const r = rng.int(0, 9);
    if (r === 0) f.content = fuzzSource(rng);
    else if (r === 1) f.content += fuzzText(rng, rng.int(5, 40));
    else if (r === 2) {
      const at = rng.int(0, f.content.length);
      f.content = f.content.slice(0, at) + fuzzText(rng, rng.int(1, 8)) + f.content.slice(at);
    }
  }
  for (let j = rng.int(0, 15); j > 0; j--) {
    const dir = pick(rng, ['', 'posts/', 'posts/2020/', 'docs/', 'tags/', 'page/', 'docs/a/', 'assets/', 'x/y/z/']);
    const name = pick(rng, ['index', 'a', 'b', 'Café', 'posts', 'tags', 'page', 'same', '东', 'x y']);
    const ext = pick(rng, ['.md', '.md', '.md', '.txt', '.MD', '', '/index.html']);
    site.files.push({ path: `${dir}${name}${ext}`, content: ext === '.md' ? fuzzSource(rng) : fuzzText(rng, 5) });
  }
  if (rng.chance(0.1)) site.files.push(copy(pick(rng, site.files)));
  // Mutate templates.
  const names = Object.keys(site.templates);
  for (let j = rng.int(0, 4); j > 0; j--) {
    const name = pick(rng, [...names, 'self', 'a', 'card', 'index', 'tag', 'tags', 'post', 'page']);
    if (name === 'self') site.templates.self = `x{% include "self" %}y`;
    else if (name === 'a') site.templates.a = `{% include "b" %}`, (site.templates.b = `{% include "a" %}{{ page.title }}`);
    else if (rng.chance(0.3)) delete site.templates[name];
    else {
      const t = site.templates[name] ?? '';
      const at = rng.int(0, t.length);
      site.templates[name] = t.slice(0, at) + tplText(rng, rng.int(1, 6)) + t.slice(at);
    }
  }
  if (rng.chance(0.1)) {
    // A deep include chain around the depth limit.
    for (let d = 0; d < 11; d++) site.templates[`d${d}`] = `<${d}>{% include "d${d + 1}" %}{{ page.title }}`;
    site.templates.page = `{% include "d0" %}${site.templates.page ?? ''}`;
    site.templates.post = `{% include "d3" %}${site.templates.post ?? ''}`;
  }
  if (rng.chance(0.1)) site.site.base_url = pick(rng, ['', '/', 'https://x.example///', 'https://a.b/c/']);
  if (rng.chance(0.1)) site.site.per_page = pick(rng, [1, 2, 1000]);
  if (rng.chance(0.1)) site.site.recent = pick(rng, [0, 1, 100]);
  if (rng.chance(0.05)) site.site.title = '<T & "Q">';
  return site;
}

// ---------------------------------------------------------------- run

let ok = 0;
const t0 = Date.now();
for (let k = first; k < first + nGen; k++) if (check(`gen ${k}`, generate(rngOf(`gen ${k}`), k % 3))) ok++;
console.log(`generated: ${ok}/${nGen} identical`);
let okF = 0;
for (let k = first; k < first + nFuzz; k++) if (check(`fuzz ${k}`, fuzzSite(rngOf(`fuzz ${k}`), k))) okF++;
console.log(`fuzzed: ${okF}/${nFuzz} identical`);
console.log(`${failures === 0 ? 'PASS' : 'FAIL'}: ${ok + okF}/${nGen + nFuzz} sites identical, each built twice (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exitCode = failures === 0 ? 0 : 1;
