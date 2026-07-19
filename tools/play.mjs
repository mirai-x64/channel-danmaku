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
    /* reset はチャンネルも進みもランダムに引くようになったので、
       欲しい番組が出るまで引き直す。setChannel で上書きすると、
       その番組にとっては安全が保証されていない場所から始まって即死する。 */
    await evaluate(`(() => { for (let i=0;i<200;i++){ __dbg.reset(); if (__dbg.cur === ${n}) return true; } return false; })()`);
    /* aim で動かさない。reset が保証しているのは開始位置の安全だけで、
       そこから別の場所へ動かすと、掃いた線の上の弾に当たって即死する。
       (これは不具合ではなく、線分で当たりを取っているのが正しく効いている) */
    await sleep(2000);
    console.log(' ', names[n], await evaluate('JSON.stringify(__dbg.state())'));
    await shot(names[n] + '.png');
  }
  const st = await evaluate('JSON.stringify(__dbg.state())');
  console.log('state:', st);
  console.log('画像は .shots/ に出した');
}

/* 実際のゲームループの上で遊ぶ操作者。
   sim.mjs と違って本物の当たり判定・クールダウン・チャンネル切替の上を走るので、
   組み上がった状態で壊れていないかはこれでしか分からない。

   弾の速度は前フレームとの差から見る(砂嵐は vx/vy を持たず毎フレーム
   置き直しているので、番組の中身を知っていると嘘をつく)。
   逃げ場が尽きかけていて、かつクールダウンが明けていたら回す —— これが
   「回すか避けきるか」で指が止まる瞬間そのものなので、回数を数える。 */
const DRIVER = `window.__drive = function(maxMs, panic){
  return new Promise(resolve => {
    const d = window.__dbg, W = 900, H = 600;
    const DIRS = []; for (let i=0;i<24;i++) DIRS.push([Math.cos(i*Math.PI/12), Math.sin(i*Math.PI/12)]);
    DIRS.push([0,0]);
    let prev = null, turns = 0, pinch = 0, lastTurn = -9, fatalTurn = 0;
    const t0 = performance.now();
    d.onFrame = function(dt){
      if (!d.alive) { finish(); return; }
      if (performance.now() - t0 > maxMs) { finish(); return; }
      /* 速度はプールの番号で対応させる。生きている弾だけを並べた順で
         対応させると、1発湧いたり消えたりしただけで全部の対応がずれ、
         でたらめな速度になる。番号ならその弾をずっと指し続ける。
         最初これを間違えて、操作者は毎フレームほぼ目隠しで走っていた。 */
      const pool = d.CH[d.cur].bullets, bs = [];
      if (!prev || prev.ch !== d.cur) prev = {ch: d.cur, x: [], y: [], live: []};
      for (let i=0;i<pool.length;i++){
        const b = pool[i];
        if (!b.live) { prev.live[i] = 0; continue; }
        let vx = 0, vy = 0;
        if (prev.live[i]) { vx = (b.x-prev.x[i])/dt; vy = (b.y-prev.y[i])/dt; }
        prev.x[i] = b.x; prev.y[i] = b.y; prev.live[i] = 1;
        bs.push({x:b.x, y:b.y, r:b.r, vx, vy});
      }

      const P = d.P, SPD = 620, HOR = 0.55, ST = 0.055;
      let best = -1e9, bx = 0, by = 0;
      for (const [dx,dy] of DIRS){
        let sc = 1e9;
        for (let t=ST; t<=HOR; t+=ST){
          const px = P.x+dx*SPD*t, py = P.y+dy*SPD*t;
          if (px<8||px>W-8||py<8||py>H-8) { sc = Math.min(sc, 0); continue; }
          for (const b of bs){
            const q = Math.hypot(px-(b.x+(b.vx||0)*t), py-(b.y+(b.vy||0)*t)) - b.r - d.DOT;
            if (q < sc) sc = q;
          }
        }
        if (sc > best){ best = sc; bx = dx; by = dy; }
      }
      /* best = どの方向へ逃げてもこれ以上は寄られる、という余裕。
         これが細くなった時が「逃げ場が無くなった」瞬間。 */
      if (best < panic){
        pinch++;
        if (d.cool <= 0){ d.turn(); turns++; lastTurn = d.t; }
      }
      d.aim(P.x + bx*SPD*0.09, P.y + by*SPD*0.09);
    };
    function finish(){
      // 死因が「回した直後」だったか。回した回数ではなく走行ごとに1回数える
      if (!d.alive && d.t - lastTurn < 0.4) fatalTurn = 1;
      d.onFrame = null;
      resolve({t: d.t, turns, fatalTurn, pinch});
    }
  });
};`;

if (cmd === 'play') {
  const N = Number(process.argv[3] || 5);
  await evaluate(DRIVER);
  const times = [];
  for (let run = 0; run < N; run++) {
    await evaluate('__dbg.reset()');
    /* 操作はページ内で回す。CDP 経由で毎フレーム mousemove を投げると
       往復の遅延がフレームを跨いで、操作の遅さを難度と読み違える。 */
    const r = await evaluate(`__drive(${20000}, 26)`);
    times.push(r);
    console.log(`  #${run+1}  ${r.t.toFixed(2)}s  回した ${r.turns}回  逃げ場が細った ${r.pinch}フレーム  回した直後に死んだ ${r.fatalTurn ? 'はい' : 'いいえ'}`);
  }
  const ts = times.map(x => x.t);
  console.log('生存秒数:', ts.map(t => t.toFixed(1)).join(', '),
    ' 平均', (ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(2) + 's');
  console.log('回した回数の合計', times.reduce((a, b) => a + b.turns, 0),
    ' うち回した直後(0.4s以内)に死んだ', times.reduce((a, b) => a + b.fatalTurn, 0));
  await shot('play-last.png');
}

ws.close(); chrome.kill();
try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
process.exit(0);
