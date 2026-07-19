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

/* 乱数は必ず種から出す。
   種を固定しないと、番組に無関係な定数を振っただけで結果が動く。
   実際それで「腕の本数は 4本=60s / 5本=4.9s の崖」という
   ありもしない結論を一度出している。差が出たらまず種を疑うこと。 */
let _s = 1;
function seed(n) { _s = (n >>> 0) || 1; }
Math.random = function () {                    // 番組側は Math.random を直接も呼ぶ
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rnd = (a, b) => a + Math.random() * (b - a);
const { CH } = new Function('W','H','CX','CY','TAU','rnd',
  src + '\nreturn {CH};')(W, H, CX, CY, TAU, rnd);

/* ---- 人間並みの回避 ----
   ・反応遅れ: DELAY 秒前の盤面で判断する(完璧AIは死なないので難度を測れない)
   ・速度上限: マウスでも瞬間移動はできない
   ・弾速は前スナップショットとの最近傍対応から推定する(番組ごとの知識は使わない) */
const DELAY = Number(process.env.DELAY ?? 0.15), SPEED = Number(process.env.SPEED || 700), DOT = 3;
const LOOK = Number(process.env.LOOK ?? 0.5), LSTEP = 0.05;
const DIRS = [];
for (let i = 0; i < 16; i++) DIRS.push([Math.cos(i * TAU / 16), Math.sin(i * TAU / 16)]);
DIRS.push([0, 0]);

/* 弾はプールの番号で見分ける。番号は番組が使い回す間ずっと同じ弾を指すので、
   前のスナップショットとの対応が一意に決まる。
   番組ごとの知識は要らないまま、対応だけが正しくなる。 */
const snap = (ch) => ch.bullets.map((b, i) => b.live ? { i, x: b.x, y: b.y, r: b.r } : null)
                               .filter(Boolean);

/* 最近傍で対応させると、湧いたばかりの弾が近くの別の弾と結ばれて
   出鱈目な速度になる。気象通報のように毎フレーム湧き続ける番組では
   これが常時起きていて、AI は嘘の速度を信じて壁に歩き込んでいた。
   盤面には常に 200px 以上空いた点があったのに 3s で死んでいたのはそのため。
   壊れていたのは番組ではなく測定器の方だった。 */
const MAXV = 2000;
function withVel(now, prev) {
  const by = new Map();
  for (const p of prev) by.set(p.i, p);
  return now.map(b => {
    const p = by.get(b.i);
    if (!p) return { ...b, vx: 0, vy: 0 };            // 今湧いた弾。速度はまだ分からない
    const vx = (b.x - p.x) / LSTEP, vy = (b.y - p.y) / LSTEP;
    // 番号が使い回された直後は座標が飛ぶ。別の弾なので速度は名乗らない
    return Math.hypot(vx, vy) > MAXV ? { ...b, vx: 0, vy: 0 } : { ...b, vx, vy };
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
  seed(seedShift + 1);
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
  seed(seedShift + 1);
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
      seed(n * 37 + i * 101 + 1);
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

/* 回した「先」の測定 — ここが賭けの本体で、固定時の難度とは別の話。
   回した瞬間の自機は動かない。出た先の弾がどこにあるかは選べない。

   見るのは2つの裾:
     即死率  — 回した直後 GRACE 秒以内に死ぬ割合。高いと回すのが罰になり、
               「回さない」が最適解になってひねりが死ぬ。
     生還率  — 回した先で SAFE 秒以上もつ割合。高いと回すのがボムになり、
               「詰まったら回す」だけの作業になってやはり賭けでなくなる。
   どちらの裾も薄すぎず、厚すぎないのが賭けの成立条件。 */
const GRACE = 0.3, SAFE = 3.0;
function turnTest(from, to, seedShift) {
  seed(seedShift + 1);
  for (const c of CH) c.reset();
  for (let i = 0; i < seedShift; i++) for (const c of CH) c.step(1 / 120, 1);

  const dt = 1 / 120;
  let x = CX, y = H - 110, t = 0;
  let hist = [], prevSnap = [], field = [], acc = 0;

  // 回すまでは from を普通に避ける(死んだ状態から回すことはできない)
  const WARM = 2.5;
  let cur = from, switched = -1;

  while (t < WARM + 8) {
    for (const c of CH) c.step(dt, 1);
    t += dt;

    if (switched < 0 && t >= WARM) {           // ここで回す
      cur = to; switched = t;
      hist = []; prevSnap = []; field = [];
      // 出た瞬間、その場に弾があれば猶予はゼロ
      for (const b of CH[cur].bullets) {
        if (b.live && Math.hypot(b.x - x, b.y - y) < b.r + DOT) return { dt: 0, margin: 0 };
      }
    }

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
    const nx = Math.max(4, Math.min(W - 4, x + bx * SPEED * dt));
    const ny = Math.max(4, Math.min(H - 4, y + by * SPEED * dt));
    for (const b of CH[cur].bullets) {
      if (!b.live) continue;
      if (segDist(b.x, b.y, x, y, nx, ny) < b.r + DOT) {
        if (switched < 0) return null;         // 回す前に死んだ = この試行は無効
        return { dt: t - switched };
      }
    }
    x = nx; y = ny;
    if (hist.length > 200) hist.shift();
  }
  return switched < 0 ? null : { dt: t - switched };
}

/* 番組ごとの「湧いた先の危なさ」。turn は組み合わせごとで遅いので、
   自機を盤面じゅうに置き直して GRACE 秒だけ避けさせる。
   出た先は自分で選べないので、盤面の危険な面積そのものが即死率になる。 */
if (process.argv[2] === 'cover') {
  const dt = 1 / 120;
  console.log(`湧いた先が即死になる割合 (${GRACE}s以内)\n`);
  for (let i = 0; i < CH.length; i++) {
    let dead = 0, total = 0;
    for (let inst = 0; inst < 14; inst++) {
      seed(inst * 61 + i * 7 + 1);
      for (const c of CH) c.reset();
      for (let s = 0; s < 240 + inst * 47; s++) CH[i].step(dt, 1);   // 適当な進行中の瞬間
      const frozen = CH[i].bullets.filter(b => b.live).map(b => ({ ...b }));
      for (let gx = 70; gx < W - 70; gx += 95) for (let gy = 70; gy < H - 70; gy += 95) {
        // その瞬間の盤面から始めて、番組を進めながら GRACE 秒避ける
        seed(inst * 61 + i * 7 + 1);   // frozen と同じ経過を再現する
        for (const c of CH) c.reset();
        for (let s = 0; s < 240 + inst * 47; s++) CH[i].step(dt, 1);
        const ch = CH[i];
        let x = gx, y = gy, t = 0, acc = 0, hist = [], prevSnap = [], field = [];
        let died = false;
        for (const b of frozen) if (Math.hypot(b.x - x, b.y - y) < b.r + DOT) died = true;
        while (!died && t < GRACE) {
          ch.step(dt, 1); t += dt;
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
            if (b.live && segDist(b.x, b.y, x, y, nx, ny) < b.r + DOT) { died = true; break; }
          }
          x = nx; y = ny;
        }
        total++; if (died) dead++;
      }
    }
    console.log(`${CH[i].name.padEnd(6)} ${(dead / total * 100).toFixed(0).padStart(3)}%  (n=${total})`);
  }
  process.exit(0);
}

if (process.argv[2] === 'turn') {
  const N = Number(process.argv[3] || 40);
  console.log(`回した先で何が起きるか / 各組 ${N} 回\n`);
  let gAll = [];
  for (let from = 0; from < CH.length; from++) {
    for (let to = 0; to < CH.length; to++) {
      if (from === to) continue;               // 直前と同じ番組は引かない
      const rs = [];
      for (let n = 0; n < N; n++) {
        const r = turnTest(from, to, n * 41 + from * 7 + to * 13);
        if (r) rs.push(r.dt);
      }
      if (!rs.length) continue;
      gAll = gAll.concat(rs);
      const die = rs.filter(v => v <= GRACE).length / rs.length * 100;
      const safe = rs.filter(v => v >= SAFE).length / rs.length * 100;
      rs.sort((a, b) => a - b);
      console.log(`${CH[from].name} → ${CH[to].name.padEnd(6)} ` +
        `即死(${GRACE}s以内) ${die.toFixed(0).padStart(3)}%  ` +
        `生還(${SAFE}s以上) ${safe.toFixed(0).padStart(3)}%  ` +
        `中央 ${rs[rs.length >> 1].toFixed(1)}s`);
    }
  }
  const die = gAll.filter(v => v <= GRACE).length / gAll.length * 100;
  const safe = gAll.filter(v => v >= SAFE).length / gAll.length * 100;
  console.log(`\n全体  即死 ${die.toFixed(0)}%  生還 ${safe.toFixed(0)}%  (n=${gAll.length})`);
  if (die < 5)  console.log('→ 即死がほぼ無い。回すことが安全策になっていて賭けになっていない');
  if (safe > 80) console.log('→ ほぼ必ず生還する。回すのがボムに退化している');
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
