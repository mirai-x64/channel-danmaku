/* 実際にブラウザで動かして確かめる。
   sim.mjs は番組の定義だけを Node で回すので、「番組の難度」は測れるが
   「ページが開くか」「弾が描かれるか」「回すと本当に盤面が入れ替わるか」は
   一切見ていない。ここはそちらを見る。

   使い方:
     node tools/play.mjs smoke     # 開いて、エラーとチャンネル毎の画を撮る
     node tools/play.mjs play [n]  # 人間相当の操作で n 回遊んで生存秒数を出す

   CDP のポートとプロファイルは実行ごとに変える。固定すると前回の残骸に
   繋がって、直したはずの不具合が残って見えたりする。 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = 'file://' + join(here, '..', 'index.html');
const PORT = 9500 + (process.pid % 400);
const PROFILE = mkdtempSync(join(tmpdir(), 'cdmk-'));
mkdirSync(join(here, '..', '.shots'), { recursive: true });

const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-sandbox', '--disable-gpu', '--window-size=1000,760',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 80; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
    catch { await sleep(150); }
  }
  throw new Error('Chrome に繋がらない');
}

let ws, id = 0;
const waiting = new Map(), events = [];
async function connect() {
  const t = (await targets()).find(t => t.type === 'page');
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
    else if (d.method) events.push(d);
  };
}
function send(method, params = {}) {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise(r => waiting.set(n, r));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
/* ページ側のフックを入れる。ゲームは内部状態を公開していないので、
   評価に必要な分だけ window に生やす。ゲーム本体は変えない。 */
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(here, '..', '.shots', name), Buffer.from(r.result.data, 'base64'));
}

const cmd = process.argv[2] || 'smoke';

await connect();
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
await send('Page.navigate', { url: PAGE });
await sleep(1200);

const errs = events.filter(e =>
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  e.method === 'Runtime.exceptionThrown');
if (errs.length) {
  console.log('コンソールエラー:');
  for (const e of errs) console.log('  ' + JSON.stringify(e.params).slice(0, 400));
} else console.log('コンソールエラー: なし');

/* 画が実際に出ているか。真っ黒なら描画が死んでいる。 */
const ink = await evaluate(`(() => {
  const c = document.querySelector('canvas');
  if (!c) return 'canvas が無い';
  const g = c.getContext('2d');
  const d = g.getImageData(0,0,c.width,c.height).data;
  let lit = 0;
  for (let i=0;i<d.length;i+=4*17) if (d[i]+d[i+1]+d[i+2] > 150) lit++;
  return { w:c.width, h:c.height, litRatio: +(lit/(d.length/(4*17))).toFixed(4) };
})()`);
console.log('canvas:', JSON.stringify(ink));

/* 評価用のフック。CH / cur / P / alive / tRun / turnKnob はモジュールスコープなので
   外からは触れない。index.html の末尾で window.__dbg に出している。 */
const hasDbg = await evaluate('typeof window.__dbg');
console.log('__dbg:', hasDbg);

if (cmd === 'smoke') {
  /* 死ぬと番組がほぼ止まる(k=0.0001)ので、撮る前に必ず生き返らせる。
     そうしないと2枚目以降は死んだ瞬間の静止画になる。 */
  const names = ['01-shopping', '02-weather', '03-sandstorm'];
  for (let n = 0; n < 3; n++) {
    await evaluate(`__dbg.reset(); __dbg.setChannel(${n}); __dbg.aim(180, 120)`);
    await sleep(2500);
    console.log(' ', names[n], await evaluate('JSON.stringify(__dbg.state())'));
    await shot(names[n] + '.png');
  }
  const st = await evaluate('JSON.stringify(__dbg.state())');
  console.log('state:', st);
  console.log('画像は .shots/ に出した');
}

if (cmd === 'play') {
  const N = Number(process.argv[3] || 5);
  const times = [];
  for (let run = 0; run < N; run++) {
    await evaluate('__dbg.reset()');
    /* 操作はページ内で回す。CDP 経由で毎フレーム mousemove を投げると
       往復の遅延がフレームを跨いで、操作の遅さを難度と読み違える。 */
    const r = await evaluate(`__dbg.autoplay(${25000})`);
    times.push(r);
    console.log(`  #${run + 1}  ${r.t.toFixed(2)}s  回した回数 ${r.turns}  回した直後の死 ${r.knobDeaths}`);
  }
  const ts = times.map(x => x.t);
  console.log('生存秒数:', ts.map(t => t.toFixed(1)).join(', '),
    ' 平均', (ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(2) + 's');
  console.log('回した回数の合計', times.reduce((a, b) => a + b.turns, 0),
    ' うち回した直後(0.4s以内)に死んだ', times.reduce((a, b) => a + b.knobDeaths, 0));
  await shot('play-last.png');
}

ws.close(); chrome.kill();
try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
process.exit(0);
