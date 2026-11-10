// Bundles the site into one self-contained HTML file (CSS and JS inlined,
// no dependencies) so it can be dropped into any other repo or web host.
//
//   node build.mjs                 -> dist/playoff-race.html
//   node build.mjs path/to/out.html
//
// Each ES module is wrapped in its own function scope so their top-level
// names can't collide; imports between them are rewired to those scopes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] || join(root, 'dist', 'playoff-race.html'));
const read = p => readFileSync(join(root, p), 'utf8');

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w-]+)\.js['"];?\s*$/gm;
const EXPORT_RE = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/gm;

const modules = new Map(); // name -> bundled source, in dependency order

function bundle(name) {
  if (modules.has(name)) return;
  modules.set(name, null); // reserve slot; guards against import cycles
  let src = read(`js/${name}.js`);
  const deps = [];
  src = src.replace(IMPORT_RE, (_, names, dep) => {
    deps.push(dep);
    const binds = names.split(',').map(s => s.trim()).filter(Boolean)
      .map(s => s.replace(/\s+as\s+/, ': '));
    return `const { ${binds.join(', ')} } = __mod_${dep};`;
  });
  if (/^\s*(import|export)\b/m.test(src.replace(EXPORT_RE, ''))) {
    throw new Error(`js/${name}.js uses an import/export form build.mjs doesn't handle`);
  }
  const exported = [...src.matchAll(EXPORT_RE)].map(m => m[1]);
  src = src.replace(/^export\s+/gm, '');
  deps.forEach(bundle);
  modules.delete(name); // re-insert after its deps
  modules.set(name, `const __mod_${name} = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();`);
}

bundle('app');
const js = [...modules.values()].join('\n\n').replace(/<\/script/gi, '<\\/script');
const css = read('css/style.css').replace(/<\/style/gi, '<\\/style');

let html = read('index.html');
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html no longer contains: ${from}`);
  html = html.replace(from, () => to);
};
swap('<link rel="stylesheet" href="css/style.css">', `<style>\n${css}\n</style>`);
swap('<script type="module" src="js/app.js"></script>', `<script type="module">\n${js}\n</script>`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`Wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
