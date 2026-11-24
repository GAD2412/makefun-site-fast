// A faster drop-in for makefun-site 1.0.0's build(input): the same output tree, byte for byte.
// One pass per stage, hand-written scanners for Markdown and front matter, templates parsed once per case and
// rendered with include results cached on the identity of the values they read. Any exception falls back to the
// vendored reference (vendor/makefun-site), loaded only then.

import { createRequire } from 'node:module';

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

// Escaping runs in native code (one test, then one replace per character present): cold JS loops cost far more.
const ESC_ANY = /[&<>"']/;
const AMP = /&/g;
const LT = /</g;
const GT = />/g;
const QUOT = /"/g;
const APOS = /'/g;
function esc(s) {
  if (!ESC_ANY.test(s)) return s;
  if (s.indexOf('&') !== -1) s = s.replace(AMP, '&amp;');
  if (s.indexOf('<') !== -1) s = s.replace(LT, '&lt;');
  if (s.indexOf('>') !== -1) s = s.replace(GT, '&gt;');
  if (s.indexOf('"') !== -1) s = s.replace(QUOT, '&quot;');
  if (s.indexOf("'") !== -1) s = s.replace(APOS, '&#39;');
  return s;
}

function slugifyRef(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

let slugMemo = new Map();
function slugify(text) {
  let r = slugMemo.get(text);
  if (r !== undefined) return r;
  const n = text.length;
  let ascii = true;
  for (let i = 0; i < n; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (!ascii) r = slugifyRef(text);
  else {
    let out = '';
    let gap = false;
    for (let i = 0; i < n; i++) {
      let c = text.charCodeAt(i);
      if (c >= 65 && c <= 90) c += 32;
      else if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(c);
    }
    if (out.length > 64) out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    if (e !== out.length) out = out.slice(0, e);
    r = out === '' ? 'untitled' : out;
  }
  slugMemo.set(text, r);
  return r;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// Native regex beats a JS loop by 5x while the code is cold (and with TurboFan off): measured 10 ms against 52 ms.
const WORD = /\S+/g;
function wordsOf(text) {
  const m = text.match(WORD);
  return m === null ? 0 : m.length;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0, n = line.length; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** { data, body } or { error }, as the reference's parseFrontMatter answers, without splitting the whole text. */
function parseFrontMatter(text) {
  const len = text.length;
  if (!(text.startsWith('---') && (len === 3 || text.charCodeAt(3) === 10))) return { error: 'no front matter' };
  if (len === 3) return { error: 'the front matter is not closed' };
  // The close: the first later line that is exactly ---.
  let p = 3;
  let q;
  for (;;) {
    q = text.indexOf('\n---', p);
    if (q === -1) return { error: 'the front matter is not closed' };
    const after = q + 4;
    if (after === len || text.charCodeAt(after) === 10) break;
    p = q + 1;
  }
  const data = {};
  if (q > 3) {
    const lines = text.slice(4, q).split('\n');
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${k + 2} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const after = q + 4;
  return { data, body: after >= len ? '' : text.slice(after + 1) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const WS = /\s/;

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : m;
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
const escapable = (c) => c < 128 && ESCAPABLE[c] === 1;


function findUnescaped(s, what, from) {
  const n = s.length;
  const w0 = what.charCodeAt(0);
  const two = what.length === 2;
  for (let j = from; j <= n - what.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && escapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === w0 && (!two || s.charCodeAt(j + 1) === w0)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && escapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// The structural inline characters: \ ` * [. Everything between two of them is one run, escaped natively.
const STRUCT = /[\\`*[]/g;

function inline(s, env) {
  const n = s.length;
  let out = '';
  let last = 0;
  let i = 0;
  while (i < n) {
    STRUCT.lastIndex = i;
    if (!STRUCT.test(s)) break;
    i = STRUCT.lastIndex - 1;
    const c = s.charCodeAt(i);
    if (last < i) out += esc(s.slice(last, i));
    if (c === 92) {
      if (i + 1 < n && escapable(s.charCodeAt(i + 1))) {
        out += s.charCodeAt(i + 1) === 62 ? '&gt;' : s[i + 1];
        i += 2;
      } else {
        out += '\\';
        i++;
      }
    } else if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${esc(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
          i = j + 1;
        } else {
          out += '*';
          i++;
        }
      }
    } else if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS.test(target)) {
        out += `<a href="${esc(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
      } else {
        out += '[';
        i++;
      }
    }
    last = i;
  }
  if (last === 0) return esc(s);
  if (last < n) out += esc(s.slice(last));
  return out;
}

/** The body rendered: { html, toc, excerpt }, as the reference's lex and render together answer. */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const nl = lines.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = 0;
  while (i < nl) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c = line.charCodeAt(0);
    if ((c === 32 || c === 9) && isBlankLine(line)) {
      i++;
      continue;
    }
    if (c === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        let body = '';
        i++;
        while (i < nl && !(lines[i].charCodeAt(0) === 96 && FENCE_CLOSE.test(lines[i]))) body += `${esc(lines[i++])}\n`;
        i++;
        html += `<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>${body}</code></pre>\n`;
        continue;
      }
    } else if (c === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const depth = h[1].length;
        const text = h[2];
        const id = uniqueSlug(slugify(text), ids);
        const ih = inline(text, env);
        html += `<h${depth} id="${id}">${ih}</h${depth}>\n`;
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: ih });
        i++;
        continue;
      }
    } else if (c === 62) {
      let joined = '';
      let any = false;
      while (i < nl && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') {
          joined = any ? `${joined}\n${t}` : t;
          any = true;
        }
      }
      html += any ? `<blockquote>\n<p>${inline(joined, env)}</p>\n</blockquote>\n` : '<blockquote>\n</blockquote>\n';
      continue;
    }
    if ((c === 45 || c === 42) && HR.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    let marker = null;
    let first = null;
    if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) {
      first = BULLET.exec(line);
      if (first !== null) marker = BULLET;
    } else if (c >= 48 && c <= 57) {
      first = ORDERED.exec(line);
      if (first !== null) marker = ORDERED;
    }
    if (marker !== null) {
      const isOrdered = marker === ORDERED;
      const g = isOrdered ? 2 : 1;
      let body = '';
      let item = null;
      while (i < nl) {
        const l = lines[i];
        const m = marker.exec(l);
        if (m !== null) {
          if (item !== null) body += `<li>${inline(item, env)}</li>\n`;
          item = trimLine(m[g]);
          i++;
        } else if (CONTINUED.test(l)) {
          item += `\n${trimLine(l)}`;
          i++;
        } else break;
      }
      body += `<li>${inline(item, env)}</li>\n`;
      const start = isOrdered ? Number(first[1]) : 1;
      if (isOrdered) html += `${start !== 1 ? `<ol start="${start}">` : '<ol>'}\n${body}</ol>\n`;
      else html += `<ul>\n${body}</ul>\n`;
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < nl && !endsParagraph(lines[i])) text += `\n${trimLine(lines[i++])}`;
    const ph = inline(text, env);
    if (excerpt === null) excerpt = ph;
    html += `<p>${ph}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const SPACES_TABS = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = SPACES_TABS.test(src.slice(lineStart, open)) && SPACES_TABS.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  const p0 = path[0];
  while (s !== null && !Object.hasOwn(s.vars, p0)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[p0];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function rootOf(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A parsed template's facts for caching: the names it reads that no for of its own binds (through its includes), and
 * how many include hops deep it reaches. A template in an include cycle is never cached.
 */
function analyse(templates) {
  const info = new Map();
  const visiting = new Set();
  const visit = (name) => {
    if (info.has(name)) return info.get(name);
    if (visiting.has(name)) return null;
    visiting.add(name);
    const free = new Set();
    let hops = 0;
    let ok = true;
    const walk = (nodes, bound) => {
      for (const n of nodes) {
        if (n.kind === 'var' || n.kind === 'raw') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
        } else if (n.kind === 'if') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          const inner = new Set(bound);
          inner.add(n.name);
          inner.add('loop');
          walk(n.body, inner);
        } else if (n.kind === 'include') {
          if (!templates.has(n.name)) continue;
          const sub = visit(n.name);
          if (sub === null) {
            ok = false;
            continue;
          }
          if (sub.hops + 1 > hops) hops = sub.hops + 1;
          for (const f of sub.free) if (!bound.has(f)) free.add(f);
        }
      }
    };
    walk(templates.get(name).nodes, new Set());
    visiting.delete(name);
    const r = ok ? { free: [...free], hops } : null;
    info.set(name, r);
    return r;
  };
  for (const [name, t] of templates) {
    const r = visit(name);
    t.free = r === null ? null : r.free;
    t.hops = r === null ? Infinity : r.hops;
    t.cache = r !== null && !r.free.includes('loop') ? new Map() : null;
  }
}

function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (let x = 0, nn = nodes.length; x < nn; x++) {
    const n = nodes[x];
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += esc(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          out += renderNodes(n.body, { vars, parent: scope }, templates, depth);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const d = depth + 1;
        if (t.cache !== null && d + t.hops <= INCLUDE_DEPTH) out += cachedRender(t, scope, templates, d);
        else out += renderNodes(t.nodes, scope, templates, d);
        break;
      }
    }
  }
  return out;
}

function cachedRender(t, scope, templates, depth) {
  const free = t.free;
  const nf = free.length;
  let m = t.cache;
  for (let k = 0; k < nf - 1; k++) {
    const v = rootOf(scope, free[k]);
    let next = m.get(v);
    if (next === undefined) {
      next = new Map();
      m.set(v, next);
    }
    m = next;
  }
  const key = nf === 0 ? undefined : rootOf(scope, free[nf - 1]);
  let r = m.get(key);
  if (r === undefined) {
    r = renderNodes(t.nodes, scope, templates, depth);
    m.set(key, r);
  }
  return r;
}

// ---------------------------------------------------------------- the build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function build(input) {
  slugMemo = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, { nodes: parseTemplate(name, input.templates[name]), free: null, hops: 0, cache: null });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  analyse(templates);
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources and statics.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolved = new Map(); // dir -> Map(target -> href or null)
  for (const s of sources) {
    const dir = dirOf(s.path);
    let memo = resolved.get(dir);
    if (memo === undefined) {
      memo = new Map();
      resolved.set(dir, memo);
    }
    const env = {
      link: (target) => {
        let r = memo.get(target);
        if (r === undefined) {
          if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) r = target;
          else {
            const hash = target.indexOf('#');
            const rel = hash === -1 ? target : target.slice(0, hash);
            const frag = hash === -1 ? '' : target.slice(hash);
            const path = rel === '' ? null : resolvePath(dir, rel);
            if (path !== null && bySource.has(path)) r = `${bySource.get(path).url}${frag}`;
            else if (path !== null && staticPaths.has(path)) r = `${base}/${path}${frag}`;
            else r = null;
          }
          memo.set(target, r);
        }
        if (r === null) {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return r;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    vars.site = site;
    vars.tags = allTags;
    vars.recent = recent;
    return renderNodes(t.nodes, { vars, parent: null }, templates, 0);
  };
  for (const s of sources) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: s.post ? card.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url })) : card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${sources.length - posts.length} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** Tests set MF_STRICT=1 so that a failure of the fast build shows instead of being covered by the fallback. */
const STRICT = process.env.MF_STRICT === '1';
let reference = null;
function referenceBuild(input) {
  if (reference === null) reference = createRequire(import.meta.url)('./vendor/makefun-site/index.js').build;
  return reference(input);
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  try {
    return build(input);
  } catch (err) {
    if (STRICT) throw err;
    return referenceBuild(input);
  }
}
