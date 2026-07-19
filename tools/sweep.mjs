/* 定数を振って「固定時の生存」と「湧いた先の即死率」を同時に見る。
   この2つは引っ張り合う — 密にすれば湧いた先は危なくなるが、追う側も死ぬ。
   欲しいのは、追えている側の生存を落とさずに即死率だけ上がる点。

   node tools/sweep.mjs WEA_REST 0.6 0.9 1.2
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, '..', 'index.html');
const html = readFileSync(base, 'utf8');

const name = process.argv[2];
const vals = process.argv.slice(3);
if (!name || !vals.length) { console.error('使い方: sweep.mjs <定数名> <値...>'); process.exit(1); }

const re = new RegExp(`(${name}\\s*=\\s*)([-0-9.]+)`);
if (!re.test(html)) { console.error(`${name} が index.html に見つからない`); process.exit(1); }
console.log(`${name} を振る  (現在 ${html.match(re)[2]})\n`);

for (const v of vals) {
  const out = join('/tmp', `sweep-${name}-${v}.html`);
  writeFileSync(out, html.replace(re, `$1${v}`));
  const env = { ...process.env, TARGET: out };
  const cov = execFileSync('node', [join(here, 'sim.mjs'), 'cover'], { env, encoding: 'utf8' });
  const fix = execFileSync('node', [join(here, 'sim.mjs'), '10', '40'], { env, encoding: 'utf8' });
  const pick = (txt, re2) => (txt.match(re2) || [, '?'])[1].trim();
  const row = (n) => `${n} 即死 ${pick(cov, new RegExp(n + '\\s+(\\d+)%'))}% / 固定 ${pick(fix, new RegExp(n + '\\s+平均 ([0-9.]+)s'))}s`;
  console.log(`${name}=${String(v).padEnd(6)}  ${row('深夜通販')}  |  ${row('気象通報')}  |  ${row('砂嵐')}`);
}
