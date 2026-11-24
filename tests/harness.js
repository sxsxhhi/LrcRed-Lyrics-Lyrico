'use strict';
/*
 * Offline harness for Lyrico plugin sources.
 * Mimics the host surface declared by the Lyrico plugin docs:
 *   Platform.http.get / Platform.cache.get|set / Platform.xml.findElements / Platform.log
 * Plus a controllable clock, because every budget check reads Date.now().
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'source.js');
const BASELINE = path.join(ROOT, 'tests', 'baseline-0.1.1', 'source.js');

/* ---------- minimal XML parser ---------- */

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([A-Za-z0-9_:.\-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(str || ''))) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

function computeText(node) {
  let t = node.ownText;
  for (const c of node.children) t += computeText(c);
  node.text = t;
  return t;
}

function parseXml(xml) {
  const root = { tag: '#root', attrs: {}, ownText: '', children: [] };
  const stack = [root];
  const tagRe = /<(\/?)([A-Za-z0-9_:.\-]+)((?:\s+[^<>]*?)?)(\/?)>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(xml))) {
    const between = xml.slice(last, m.index);
    if (between) stack[stack.length - 1].ownText += decodeEntities(between);
    last = tagRe.lastIndex;
    const closing = m[1];
    const tag = m[2];
    const attrs = m[3] || '';
    const selfClose = m[4];
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { tag, attrs: parseAttrs(attrs), ownText: '', children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  computeText(root);
  return root;
}

function findElementsWith(xml, q, shallow) {
  const want = q && q.tag ? String(q.tag) : null;
  const root = parseXml(String(xml));
  if (shallow) {
    (function strip(n) {
      n.text = n.ownText;
      for (const c of n.children) strip(c);
    })(root);
  }
  const out = [];
  (function walk(n) {
    for (const c of n.children) {
      if (!want || c.tag === want) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

function findElements(xml, q) {
  return findElementsWith(xml, q, false);
}

/* ---------- sandbox ---------- */

function createSandbox(opts) {
  opts = opts || {};
  let now = opts.startTime || 1730000000000;
  const clock = {
    now: () => now,
    advance: (ms) => { now += ms; }
  };
  const latency = opts.latency === undefined ? 300 : opts.latency;
  const cacheStore = new Map();
  const logs = [];
  const calls = [];
  const handler = opts.http || (() => ({ code: 404, body: '' }));

  const Platform = {
    http: {
      get(url, o) {
        calls.push({ url, opts: o || {} });
        const nth = calls.filter((c) => c.url === url).length;
        const res = handler(url, nth, calls) || { code: 404, body: '' };
        if (res.latency) clock.advance(res.latency);
        else clock.advance(latency);
        if (res.throw) throw new Error(res.throw);
        return {
          code: res.code === undefined ? 200 : res.code,
          headers: res.headers || {},
          body: res.body === undefined ? '' : String(res.body)
        };
      }
    },
    cache: {
      get(k) {
        const e = cacheStore.get(k);
        if (!e) return '';
        if (e.exp && e.exp <= now) { cacheStore.delete(k); return ''; }
        return e.v;
      },
      set(k, v, ttl) {
        cacheStore.set(k, { v: String(v), exp: ttl ? now + ttl : 0 });
      }
    },
    xml: { findElements: (x, q) => findElementsWith(x, q, !!opts.shallowText) },
    log: {
      debug: (t, m) => logs.push({ level: 'debug', t, m: String(m) }),
      info: (t, m) => logs.push({ level: 'info', t, m: String(m) }),
      warn: (t, m) => logs.push({ level: 'warn', t, m: String(m) }),
      error: (t, m) => logs.push({ level: 'error', t, m: String(m) })
    }
  };

  const sandbox = {
    Platform,
    console,
    Date: { now: () => now }
  };
  vm.createContext(sandbox);
  const file = opts.baseline ? BASELINE : SRC;
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });

  return { sandbox, ctx: sandbox, calls, logs, clock, cacheStore, Platform };
}

/* ---------- assertion helpers ---------- */

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg ? msg + ': ' : '') + 'expected ' + e + ', got ' + a);
}
function hasLog(logs, needle) {
  return logs.some((l) => l.m.indexOf(needle) >= 0);
}

/* ---------- tiny runner ---------- */

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err && err.message ? err.message : String(err) });
  }
}
function report() {
  let pass = 0;
  for (const r of results) {
    if (r.ok) {
      pass++;
      console.log('PASS  ' + r.name);
    } else {
      console.log('FAIL  ' + r.name + '\n        ' + r.err);
    }
  }
  console.log('\n' + pass + ' PASS / ' + (results.length - pass) + ' FAIL  (total ' + results.length + ')');
  return pass === results.length;
}

module.exports = {
  ROOT, SRC, BASELINE,
  parseXml, findElements,
  createSandbox, assert, eq, hasLog,
  test, report, results
};
