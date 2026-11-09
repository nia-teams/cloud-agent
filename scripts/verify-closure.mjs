import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const ai = read('packages/ai/package.json');
const core = read('packages/agent-core/package.json');
assert.deepEqual(Object.keys(ai.dependencies).sort(), ['@anthropic-ai/sdk', 'openai', 'undici'].sort());
assert.deepEqual(Object.keys(core.dependencies).sort(), ['@nia-teams/ai', 'cron-parser', 'nanoid'].sort());
for (const pkg of [ai, core]) {
 assert.equal(pkg.version, '0.1.1'); assert.equal(pkg.license, 'MIT'); assert.equal(pkg.type, 'module'); assert.equal(pkg.engines.node, '>=20');
 for (const entry of ['dist', 'skills', 'README.md', 'README_CN.md', 'LICENSE']) assert(pkg.files.includes(entry));
}
const lock = read('package-lock.json');
const driverNames = ['mongo' + 'db', 'io' + 'redis', 'fast' + 'ify'];
for (const [name, pkg] of Object.entries(lock.packages)) {
 assert(pkg.dev === true || !driverNames.some(driver => name.endsWith('/' + driver)), `Unexpected driver: ${name}`);
 if (pkg.resolved && !pkg.link) assert(new URL(pkg.resolved).hostname === 'registry.npmjs.org', `Non-public dependency: ${name}`);
}
const blocked = [
 ['baich','uan'], ['bc-','inner'], ['internal.','nia-teams'], ['cli','proxy'], ['token','hub'], ['xiaomi','mimo'], ['jev-','1.13'], ['GPT52','Client'], ['createLlm','Gateway'], ['gateway','Provider'], ['iOS ','WKWebView'], ['S','LS'],
].map(parts => parts.join('').toLowerCase());
let scanned = 0;
function scan(dir) {
 for(const ent of fs.readdirSync(dir, {withFileTypes:true})) {
  if (['node_modules','.git'].includes(ent.name)) continue;
  const file = path.join(dir,ent.name);
  if(ent.isDirectory()) scan(file);
  else if(ent.isFile() && /\.(?:ts|js|mjs|md|json)$/.test(file)) {
   // Integrity digests are random binary-derived data, not source text or endpoints.
   const text = file.endsWith('package-lock.json') ? JSON.stringify(JSON.parse(fs.readFileSync(file,'utf8')), (key, value) => key === 'integrity' ? undefined : value) : fs.readFileSync(file,'utf8');
   assert(!blocked.some(word => text.toLowerCase().includes(word)), `Forbidden source reference: ${path.relative(root,file)}`);
   scanned++;
  }
 }
}
scan(root);
// A real ESM loader rejects SDK and driver imports while importing every SDK-free public entry.
const loader = `export async function resolve(s,c,n){ if(['openai','@anthropic-ai/sdk',${driverNames.map(x=>JSON.stringify(x)).join(',')}].some(p=>s===p||s.startsWith(p+'/')))throw new Error('Unexpected runtime dependency '+s); return n(s,c); }`;
const entries = ['@nia-teams/ai/protocol','@nia-teams/ai/adapters', ...Object.keys(core.exports).map(s=>core.name+(s==='.'?'':s.slice(1)))];
const program = `import {register} from 'node:module'; register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(loader))}, import.meta.url); for(const name of ${JSON.stringify(entries)})await import(name);`;
execFileSync(process.execPath, ['--input-type=module','-e',program], {cwd:root,stdio:'pipe'});
for(const name of ['ai','agent-core']) {
 const output = execFileSync('npm',['pack','--dry-run','--json'],{cwd:path.join(root,'packages',name),encoding:'utf8'});
 const files = JSON.parse(output)[0].files.map(file=>file.path);
 for (const file of ['LICENSE', 'README.md', 'README_CN.md']) assert(files.includes(file), `Missing packed file: ${file}`); assert(files.some(file=>file.startsWith('skills/')&&file.endsWith('SKILL.md')));
 assert(!files.some(file=>file.includes('__tests__')));
}
console.log(`closure: PASS (${scanned} project files; public dependency graph; all SDK-free entries; package contents)`);
