// Checks the rule from the README's "Version numbers": every file that
// loads a module uses the same address for it, ?v= included. Two different
// addresses load the module twice, and a returning visitor's browser can
// then pair new code with an old cached copy that lacks what it asks for.
// (That happened once: an import that ran over several lines was missed
// when the others got their ?v=.)
//
// It reads every import in flight-console/js, and the module addresses
// index.html and launch.html name themselves (script tags and the head
// script's preload list).
// Run with: node --test "flight-console/test/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(FC, p).split(sep).join('/');

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// The module addresses a file names. An import list may run over several
// lines, so the search runs from "import" or "export" to its "from".
export function specifiersIn(file, text) {
  const found = [];
  if (file.endsWith('.html')) {
    for (const m of text.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) found.push(m[1]);
    for (const m of text.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) found.push(m[1]);
    // The head script's own list of modules to preload.
    for (const m of text.matchAll(/['"](js\/[\w./-]+\.js(?:\?[^'"]*)?)['"]/g)) found.push(m[1]);
  } else {
    for (const m of text.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
    for (const m of text.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
    for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  }
  return found;
}

function allReferences() {
  const files = [...jsFiles(join(FC, 'js')), join(FC, 'index.html'), join(FC, 'launch.html')].filter(existsSync);
  const byModule = new Map(); // module file -> Map(query -> [who])
  let count = 0;
  for (const file of files) {
    for (const spec of specifiersIn(file, readFileSync(file, 'utf8'))) {
      if (/^(https?:)?\/\//.test(spec)) continue;
      const [path, query = ''] = spec.split('?');
      const target = resolve(dirname(file), path);
      if (!existsSync(target)) continue; // config.local.js is optional
      count++;
      if (!byModule.has(target)) byModule.set(target, new Map());
      const queries = byModule.get(target);
      if (!queries.has(query)) queries.set(query, []);
      queries.get(query).push(rel(file));
    }
  }
  return { byModule, count };
}

test('an import list that runs over several lines is still found', () => {
  const text = "import { a } from './one.js?v=2';\nimport {\n  b, c,\n  d,\n} from '../two.js';\nexport { e } from './three.js?v=7';\nconst later = await import('./four.js');\n";
  assert.deepEqual(specifiersIn('x.js', text), ['./one.js?v=2', '../two.js', './three.js?v=7', './four.js']);
});

test('every module is loaded under one address, ?v= included', () => {
  const { byModule, count } = allReferences();
  assert.ok(count > 150, `only ${count} imports were found, so the search is broken`);
  const mixed = [];
  for (const [target, queries] of byModule) {
    if (queries.size < 2) continue;
    const who = [...queries].map(([q, files]) => `"${q || 'no ?v='}" in ${files.join(', ')}`).join(' and ');
    mixed.push(`${rel(target)} is loaded as ${who}`);
  }
  assert.deepEqual(mixed, []);
});
