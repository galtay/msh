// Guards against code that would break on Martin and Shirley's older iPad
// (Safari 10.3+), plus a syntax check of the Apps Script.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Source with comments removed, so explanations that name an API don't count.
function code(f) {
  const src = read(f);
  const comments = [];
  acorn.parse(src, { ecmaVersion: 2017, onComment: (block, text, start, end) => comments.push([start, end]) });
  return comments.reverse().reduce((s, [a, b]) => s.slice(0, a) + s.slice(b), src);
}

test('browser scripts parse as ES2017 (no ?., ??, object spread, optional catch)', () => {
  for (const f of ['app.js', 'config.js']) {
    assert.doesNotThrow(() => acorn.parse(read(f), { ecmaVersion: 2017 }), f);
  }
});

test('browser scripts avoid APIs old Safari lacks', () => {
  const src = code('app.js');
  for (const api of ['AbortController', 'randomUUID', 'showModal', 'replaceAll', 'structuredClone',
    '.at(', 'flatMap', 'Object.fromEntries', 'matchAll', 'Promise.allSettled', '.finally(']) {
    assert.ok(!src.includes(api), `app.js uses ${api}`);
  }
  assert.ok(!/<dialog/i.test(read('index.html').replace(/<!--[\s\S]*?-->/g, '')), 'index.html uses <dialog>');
});

test('styles avoid CSS old Safari lacks (flex gap, min/max/clamp, inset, :is/:where)', () => {
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/(^|[\s;{])gap\s*:/.test(css), 'flexbox gap (use margins; grid-gap is fine)');
  assert.ok(!/\b(min|max|clamp)\(/.test(css), 'min()/max()/clamp()');
  assert.ok(!/(^|[\s;{])inset\s*:/.test(css), 'inset shorthand');
  assert.ok(!/:(is|where|has)\(/.test(css), ':is/:where/:has');
  // env() must follow a plain fallback for the same property (or its shorthand,
  // e.g. padding before padding-top).
  css.split(/[;{}]/).forEach((decl, i, all) => {
    const m = decl.match(/^\s*([\w-]+)\s*:.*env\(/);
    if (!m) return;
    const prev = ((all[i - 1] || '').match(/^\s*([\w-]+)\s*:/) || [])[1] || '';
    assert.ok(prev && m[1].indexOf(prev) === 0 && !/env\(/.test(all[i - 1]), `${m[1]} with env() has no fallback`);
  });
});

test('Code.gs parses', () => {
  assert.doesNotThrow(() => acorn.parse(read('apps-script/Code.gs'), { ecmaVersion: 2019 }));
});

test('version placeholders are in place for the deploy workflow to stamp', () => {
  assert.match(read('index.html'), /app\.js\?v=__VERSION__/);
  assert.match(read('app.js'), /APP_VERSION = '__VERSION__'/);
  assert.match(read('version.json'), /__VERSION__/);
});

test('the app and the script agree on the API version and field order', () => {
  const app = read('app.js');
  const gs = read('apps-script/Code.gs');
  const minApi = Number(app.match(/MIN_API_VERSION = (\d+)/)[1]);
  const version = Number(gs.match(/var VERSION = (\d+)/)[1]);
  assert.ok(version >= minApi, `Code.gs VERSION ${version} < app MIN_API_VERSION ${minApi}`);
  const fields = (src) => eval(src.match(/var FIELDS = (\[[\s\S]*?\]);/)[1]);
  const shown = fields(app);
  const stored = fields(gs);
  shown.forEach((f) => assert.ok(stored.includes(f), `app field ${f} is not stored by Code.gs`));
});
