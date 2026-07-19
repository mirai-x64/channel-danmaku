/* 盤面が閉じているかを、腕前と無関係に決める。

   AI を走らせて生存秒数を測ると、「難しい」と「そもそも通れない」が
   同じ数字に見える。実際それで何度も難度調整に時間を溶かした。
   気象通報は完全知覚で速度を倍にしても人間相当と同じ 4.1s だった —
   これは難しかったのではなく、避ける手が存在しなかったということ。

   ここでは前方到達可能集合をそのまま計算する。
     R(0) = 空いている場所すべて
     R(t+dt) = (R(t) を速度ぶん膨らませたもの) ∩ (t+dt で空いている場所)
   R が空になった瞬間が、どんな腕前でも避けられなくなった瞬間。
   空にならない限り、そこには必ず生き延びる道がある。

     node tools/reach.mjs [秒数] [速度]
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(process.env.TARGET || join(here, '..', 'index.html'), 'utf8');
const S = 'function mkBullet()', E = 'const CH = [shopping, weather, sandstorm];';
const src = html.slice(html.indexOf(S), html.indexOf(E) + E.length);

const W = 900, H = 600, CX = W / 2, CY = H / 2, TAU = Math.PI * 2;
let _s = 1;
const seed = n => { _s = (n >>> 0) || 1; };
Math.random = function () {
  _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rnd = (a, b) => a + Math.random() * (b - a);
const { CH } = new Function('W', 'H', 'CX', 'CY', 'TAU', 'rnd', src + '\nreturn {CH};')(W, H, CX, CY, TAU, rnd);

const CAP = Number(process.argv[2] || 30);
const SPEED = Number(process.argv[3] || 700);
const DOT = 3, CELL = 5;
const GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL);
const dt = 1 / 60;
const REACH = Math.max(1, Math.round(SPEED * dt / CELL));   // 1ステップで動ける格子数

const free = new Uint8Array(GW * GH);
let cur = new Uint8Array(GW * GH), nxt = new Uint8Array(GW * GH);

function markFree(ch) {
  free.fill(1);
  for (const b of ch.bullets) {
    if (!b.live) continue;
    const rr = b.r + DOT;
    const x0 = Math.max(0, Math.floor((b.x - rr) / CELL)), x1 = Math.min(GW - 1, Math.ceil((b.x + rr) / CELL));
    const y0 = Math.max(0, Math.floor((b.y - rr) / CELL)), y1 = Math.min(GH - 1, Math.ceil((b.y + rr) / CELL));
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const dx = (gx + 0.5) * CELL - b.x, dy = (gy + 0.5) * CELL - b.y;
      if (dx * dx + dy * dy < rr * rr) free[gy * GW + gx] = 0;
    }
  }
}
/* 膨張は縦横に分けてやる(分離可能)。まとめてやると REACH² になる。 */
function dilate(src2, dst) {
  const tmp = new Uint8Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    let run = -1;
    for (let gx = 0; gx < GW; gx++) {
      if (src2[gy * GW + gx]) run = gx;
      if (run >= 0 && gx - run <= REACH) tmp[gy * GW + gx] = 1;
    }
    run = -1;
    for (let gx = GW - 1; gx >= 0; gx--) {
      if (src2[gy * GW + gx]) run = gx;
      if (run >= 0 && run - gx <= REACH) tmp[gy * GW + gx] = 1;
    }
  }
  dst.fill(0);
  for (let gx = 0; gx < GW; gx++) {
    let run = -1;
    for (let gy = 0; gy < GH; gy++) {
      if (tmp[gy * GW + gx]) run = gy;
      if (run >= 0 && gy - run <= REACH) dst[gy * GW + gx] = 1;
    }
    run = -1;
    for (let gy = GH - 1; gy >= 0; gy--) {
      if (tmp[gy * GW + gx]) run = gy;
      if (run >= 0 && run - gy <= REACH) dst[gy * GW + gx] = 1;
    }
  }
}

console.log(`盤面が閉じるまで / 自機速度 ${SPEED}px/s / 上限 ${CAP}s`);
console.log('「閉じる」= どこに居ても、どう動いても当たる状態\n');

/* 一点から始めた場合。全体としては道が残っていても、
   「いま自分が居るここ」から辿れる先が尽きることはある。
   チャンネルを回した直後はまさにこれで、湧いた場所は選べない。
   ONE=1 で、空いている場所を1つだけ選んで始める。 */
const ONE = process.argv[4] === 'one';

for (let i = 0; i < CH.length; i++) {
  const outs = [];
  for (let n = 0; n < 5; n++) {
    seed(n * 31 + i * 17 + 1);
    for (const c of CH) c.reset();
    const ch = CH[i];
    for (let s = 0; s < n * 41; s++) ch.step(dt, 1);      // 位相をずらして始める
    markFree(ch);
    cur.set(free);
    if (ONE) {
      const idx = [];
      for (let j = 0; j < free.length; j++) if (free[j]) idx.push(j);
      cur.fill(0);
      cur[idx[(Math.random() * idx.length) | 0]] = 1;
    }
    let t = 0, closed = -1, minArea = 1;
    while (t < CAP) {
      ch.step(dt, 1 + Math.min(t / 90, 0.4)); t += dt;
      markFree(ch);
      dilate(cur, nxt);
      let alive = 0;
      for (let j = 0; j < nxt.length; j++) { nxt[j] &= free[j]; alive += nxt[j]; }
      const tmp = cur; cur = nxt; nxt = tmp;
      minArea = Math.min(minArea, alive / (GW * GH));
      if (alive === 0) { closed = t; break; }
    }
    outs.push(closed < 0 ? `${CAP}s+` : closed.toFixed(1) + 's');
  }
  console.log(`${CH[i].name.padEnd(6)} 閉じるまで  ${outs.join(', ')}`);
}
