/* 難度の実測。index.html から番組の定義をそのまま抜き出して Node で回す。
   目的はただ一つ: 「1つの番組に固定したら、人間並みの回避で何秒もつか」。
   固定して何十秒も生きられるなら、逃げ場が尽きないということで、
   チャンネルを回す動機が生まれない = ひねりが死んでいる。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(process.env.TARGET || join(here, '..', 'index.html'), 'utf8');

const START = 'function mkBullet()';
const END   = 'const CH = [shopping, weather, sandstorm];';
const i0 = html.indexOf(START), i1 = html.indexOf(END);
if (i0 < 0 || i1 < 0) throw new Error('番組定義の切り出しに失敗。index.html の目印が変わった');
const src = html.slice(i0, i1 + END.length);

const W = 900, H = 600, CX = W / 2, CY = H / 2;
const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const { CH } = new Function('W','H','CX','CY','TAU','rnd',
  src + '\nreturn {CH};')(W, H, CX, CY, TAU, rnd);

/* ---- 人間並みの回避 ----
   ・反応遅れ: DELAY 秒前の盤面で判断する(完璧AIは死なないので難度を測れない)
   ・速度上限: マウスでも瞬間移動はできない
   ・弾速は前スナップショットとの最近傍対応から推定する(番組ごとの知識は使わない) */
const DELAY = 0.15, SPEED = Number(process.env.SPEED || 700), DOT = 3;
const LOOK = 0.5, LSTEP = 0.05;
const DIRS = [];
for (let i = 0; i < 16; i++) DIRS.push([Math.cos(i * TAU / 16), Math.sin(i * TAU / 16)]);
DIRS.push([0, 0]);

const snap = (ch) => ch.bullets.filter(b => b.live).map(b => ({ x: b.x, y: b.y, r: b.r }));

function withVel(now, prev) {
  return now.map(b => {
    let bd = 900, bp = null;
    for (const p of prev) {
      const d = (p.x - b.x) ** 2 + (p.y - b.y) ** 2;
      if (d < bd) { bd = d; bp = p; }
    }
    return bp ? { ...b, vx: (b.x - bp.x) / LSTEP, vy: (b.y - bp.y) / LSTEP }
              : { ...b, vx: 0, vy: 0 };
  });
}

function score(px, py, dx, dy, field) {
  let worst = 1e9;
  for (let t = LSTEP; t <= LOOK; t += LSTEP) {
    const x = Math.max(4, Math.min(W - 4, px + dx * SPEED * t));
    const y = Math.max(4, Math.min(H - 4, py + dy * SPEED * t));
    for (const b of field) {
      const d = Math.hypot(x - (b.x + b.vx * t), y - (b.y + b.vy * t)) - b.r - DOT;
      if (d < worst) worst = d;
    }
  }
  return worst;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}


/* 事前ステップ後、いま最も安全な点から始める(実際の切替も生きた自機で起きる) */
function safeStart(ch) {
  let bx = CX, by = H - 110, bd = -1;
  for (let gx = 60; gx < W - 60; gx += 45)
    for (let gy = 60; gy < H - 60; gy += 45) {
      let d = 1e9;
      for (const b of ch.bullets) if (b.live) d = Math.min(d, Math.hypot(gx - b.x, gy - b.y) - b.r);
      if (d > bd) { bd = d; bx = gx; by = gy; }
    }
  return [bx, by];
}

/* 1番組に固定して、死ぬまでの秒数を返す */
function run(idx, cap = 60, seedShift = 0) {
  for (const c of CH) c.reset();
  for (let i = 0; i < seedShift; i++) CH[idx].step(1 / 120, 1);

  const ch = CH[idx];
  const [sx, sy] = safeStart(ch);
  let x = sx, y = sy, t = 0;
  const dt = 1 / 120;
  const hist = [];
  let prevSnap = [], field = [], acc = 0;

  while (t < cap) {
    const k = 1 + Math.min(t / 90, 0.4);
    ch.step(dt, k);
    t += dt;

    hist.push(snap(ch));
    const want = Math.round(DELAY / dt);
    const seen = hist.length > want ? hist[hist.length - 1 - want] : hist[0];

    acc += dt;
    if (acc >= LSTEP) { acc = 0; field = withVel(seen, prevSnap); prevSnap = seen; }

    let best = -1e9, bx = 0, by = 0;
    for (const [dx, dy] of DIRS) {
      const s = score(x, y, dx, dy, field);
      if (s > best) { best = s; bx = dx; by = dy; }
    }
    const nx = Math.max(4, Math.min(W - 4, x + bx * SPEED * dt));
    const ny = Math.max(4, Math.min(H - 4, y + by * SPEED * dt));

    for (const b of ch.bullets) {
      if (!b.live) continue;
      if (segDist(b.x, b.y, x, y, nx, ny) < b.r + DOT) return t;
    }
    x = nx; y = ny;
    if (hist.length > 200) hist.shift();
  }
  return cap;
}

/* 実際の遊び方 — 3番組すべてを裏で進めつつ、追い詰められたら回す。
   固定より伸びなければ、回す意味が無い = ひねりが機能していない。
   「追い詰められた瞬間」= どの方向へ逃げても余裕が PINCH px を切る。
   これが指の止まる瞬間にあたる。 */
const PINCH = 7, COOL = 1.5;
function play(cap = 90, seedShift = 0) {
  for (const c of CH) c.reset();
  for (let i = 0; i < seedShift; i++) for (const c of CH) c.step(1 / 120, 1);

  let x = CX, y = H - 110, t = 0, cur = 0, cool = 0, turns = 0, pinches = 0;
  const dt = 1 / 120;
  let hist = [], prevSnap = [], field = [], acc = 0;

  while (t < cap) {
    const k = 1 + Math.min(t / 90, 0.4);
    for (const c of CH) c.step(dt, k);      // 映っていない番組も進む
    t += dt; cool = Math.max(0, cool - dt);

    hist.push(snap(CH[cur]));
    const want = Math.round(DELAY / dt);
    const seen = hist.length > want ? hist[hist.length - 1 - want] : hist[0];
    acc += dt;
    if (acc >= LSTEP) { acc = 0; field = withVel(seen, prevSnap); prevSnap = seen; }

    let best = -1e9, bx = 0, by = 0;
    for (const [dx, dy] of DIRS) {
      const s = score(x, y, dx, dy, field);
      if (s > best) { best = s; bx = dx; by = dy; }
    }
    if (best < PINCH) {
      pinches++;
      if (cool === 0) {                      // 賭ける。回した先が何かは分からない
        let n; do { n = (Math.random() * CH.length) | 0; } while (n === cur);
        cur = n; cool = COOL; turns++; hist = []; prevSnap = []; field = [];
        continue;
      }
    }
    const nx = Math.max(4, Math.min(W - 4, x + bx * SPEED * dt));
    const ny = Math.max(4, Math.min(H - 4, y + by * SPEED * dt));
    for (const b of CH[cur].bullets) {
      if (!b.live) continue;
      if (segDist(b.x, b.y, x, y, nx, ny) < b.r + DOT) return { t, turns, pinches };
    }
    x = nx; y = ny;
    if (hist.length > 200) hist.shift();
  }
  return { t: cap, turns, pinches };
}

if (process.argv[2] === 'play') {
  console.log('回しながら遊ぶ (5回)\n');
  for (let n = 0; n < 5; n++) {
    const r = play(90, n * 53);
    console.log(`${n + 1}回目  生存 ${r.t.toFixed(1)}s  回した回数 ${r.turns}  ` +
      `逃げ場が消えたフレーム ${r.pinches}`);
  }
  process.exit(0);
}

/* 「逃げ場の余裕」の分布。指が止まるのは余裕がゼロになる瞬間ではなく、
   細く見える瞬間なので、閾値で数えず分布そのものを見る。 */
if (process.argv[2] === 'margin') {
  const cap = 45;
  console.log(`逃げ場の余裕(px)の分布 / 自機速度 ${SPEED}px/s\n`);
  for (let i = 0; i < CH.length; i++) {
    const all = [];
    for (let n = 0; n < 6; n++) {
      for (const c of CH) c.reset();
      for (let s = 0; s < n * 37; s++) CH[i].step(1 / 120, 1);
      const ch = CH[i];
      const [sx, sy] = safeStart(ch);
      let x = sx, y = sy, t = 0, acc = 0;
      const dt = 1 / 120; let hist = [], prevSnap = [], field = [];
      while (t < cap) {
        ch.step(dt, 1 + Math.min(t / 90, 0.4)); t += dt;
        hist.push(snap(ch));
        const want = Math.round(DELAY / dt);
        const seen = hist.length > want ? hist[hist.length - 1 - want] : hist[0];
        acc += dt;
        if (acc >= LSTEP) { acc = 0; field = withVel(seen, prevSnap); prevSnap = seen; }
        let best = -1e9, bx = 0, by = 0;
        for (const [dx, dy] of DIRS) {
          const s = score(x, y, dx, dy, field);
          if (s > best) { best = s; bx = dx; by = dy; }
        }
        if (field.length) all.push(best);
        const nx = Math.max(4, Math.min(W - 4, x + bx * SPEED * dt));
        const ny = Math.max(4, Math.min(H - 4, y + by * SPEED * dt));
        let hit = false;
        for (const b of ch.bullets) {
          if (b.live && segDist(b.x, b.y, x, y, nx, ny) < b.r + DOT) { hit = true; break; }
        }
        if (hit) break;
        x = nx; y = ny;
        if (hist.length > 200) hist.shift();
      }
    }
    all.sort((a, b) => a - b);
    const q = (p) => all[Math.floor(all.length * p)] ?? NaN;
    const frac = (th) => (all.filter(v => v < th).length / all.length * 100).toFixed(1);
    console.log(`${CH[i].name.padEnd(6)} 下位5% ${q(0.05).toFixed(0).padStart(4)}px  ` +
      `中央 ${q(0.5).toFixed(0).padStart(4)}px  |  ` +
      `40px未満 ${frac(40).padStart(5)}%  25px未満 ${frac(25).padStart(5)}%  ` +
      `15px未満 ${frac(15).padStart(5)}%`);
  }
  process.exit(0);
}

const TRIALS = Number(process.argv[2] || 5);
const CAP = Number(process.argv[3] || 60);
console.log(`反応遅れ ${DELAY * 1000}ms / 速度上限 ${SPEED}px/s / 各${TRIALS}回 (上限${CAP}s)\n`);
for (let i = 0; i < CH.length; i++) {
  const r = [];
  for (let n = 0; n < TRIALS; n++) r.push(run(i, CAP, n * 37));
  const avg = r.reduce((a, b) => a + b, 0) / r.length;
  console.log(`${CH[i].name.padEnd(6)} 平均 ${avg.toFixed(1)}s  ` +
    `[${r.map(v => v.toFixed(1)).join(', ')}]${avg >= CAP * 0.9 ? '  ← 逃げ場が尽きない' : ''}`);
}
