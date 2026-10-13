'use strict';
(() => {
  const P = window.Pool;
  const { R, HL, HW, CW, FRAME, DT, RAILS, POCKETS } = P;
  const $ = s => document.querySelector(s);

  const BASE = ['#f6f2e6', '#f2c21b', '#1d4fc4', '#d42a2a', '#5d2b8f', '#f0731a', '#178a45', '#8a1c22', '#111111'];
  const colorOf = n => BASE[n > 8 ? n - 8 : n];
  const pathColorOf = n => (n === 0 ? '#ffffff' : n === 8 ? '#cfcfcf' : colorOf(n));
  const nameOf = n => (n === 0 ? 'blanca' : `#${n}`);
  const DETAIL = { short: 2, medium: 4, full: Infinity };

  const S = {
    balls: [],
    aim: 0,
    power: 35,
    spinX: 0,
    spinY: 0,
    mode: 'aim',
    ballInHand: false,
    animating: false,
    pred: null,
    predDirty: true,
    dirty: true,
    undo: [],
    opts: { detail: 'full', objPaths: true, finals: true, squirt: true },
  };

  const store = {
    load() {
      try {
        const o = JSON.parse(localStorage.getItem('poolaim') || '{}');
        if (o.opts) Object.assign(S.opts, o.opts);
        if (typeof o.power === 'number') S.power = o.power;
      } catch (e) { /* sin almacenamiento */ }
    },
    save() {
      try { localStorage.setItem('poolaim', JSON.stringify({ opts: S.opts, power: S.power })); } catch (e) { /* ignorar */ }
    },
  };

  const speed = () => Math.max(0.08, P.MAX_SPEED * Math.pow(S.power / 100, 1.3));

  // ---------------------------------------------------------------- mesa / bolas
  function rack(kind) {
    const balls = [];
    for (let n = 0; n <= 15; n++) balls.push(P.makeBall(n, 0, 0, false));
    const put = (n, x, y) => { Object.assign(balls[n], { x, y, on: true }); };
    put(0, -HL / 2, 0);
    const dx = Math.sqrt(3) * R + 0.0003, dy = 2 * R + 0.0003;
    let rows = null;
    if (kind === '8') rows = [[1], [9, 2], [10, 8, 3], [11, 7, 14, 4], [5, 13, 15, 6, 12]];
    if (kind === '9') rows = [[1], [2, 3], [4, 9, 5], [6, 7], [8]];
    if (rows) rows.forEach((row, i) => row.forEach((n, j) => put(n, HL / 2 + i * dx, (j - (row.length - 1) / 2) * dy)));
    if (kind === 'practice') put(1, HL / 2, 0.18);
    S.balls = balls;
    S.aim = kind === 'practice' ? Math.atan2(0.18, HL) : 0;
    S.ballInHand = kind !== 'practice';
    S.animating = false;
    changed();
  }

  function overlaps(x, y, skip) {
    return S.balls.some(b => b.on && b !== skip && Math.hypot(b.x - x, b.y - y) < 2 * R + 0.0005);
  }

  const clampX = x => Math.max(-HL + R, Math.min(HL - R, x));
  const clampY = y => Math.max(-HW + R, Math.min(HW - R, y));

  function findFree(x, y, skip) {
    x = clampX(x); y = clampY(y);
    if (!overlaps(x, y, skip)) return [x, y];
    for (let r = R * 0.5; r < 1.5; r += R * 0.5) {
      const steps = Math.max(8, Math.round((2 * Math.PI * r) / (R * 0.5)));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const px = clampX(x + Math.cos(a) * r), py = clampY(y + Math.sin(a) * r);
        if (!overlaps(px, py, skip)) return [px, py];
      }
    }
    return [x, y];
  }

  function pushUndo() {
    S.undo.push({ balls: P.cloneBalls(S.balls), aim: S.aim, hand: S.ballInHand });
    if (S.undo.length > 40) S.undo.shift();
  }

  function undo() {
    const u = S.undo.pop();
    if (!u) return;
    S.balls = u.balls;
    S.aim = u.aim;
    S.ballInHand = u.hand;
    S.animating = false;
    changed();
  }

  function changed() {
    S.predDirty = true;
    S.dirty = true;
    updateUI();
  }

  // ---------------------------------------------------------------- vista
  const stage = $('#stage'), cv = $('#table'), ctx = cv.getContext('2d');
  const V = { w: 1, h: 1, dpr: 1, s: 1, cx: 0, cy: 0, portrait: false };

  function resize() {
    const r = stage.getBoundingClientRect();
    V.w = Math.max(1, r.width);
    V.h = Math.max(1, r.height);
    V.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    cv.width = Math.round(V.w * V.dpr);
    cv.height = Math.round(V.h * V.dpr);
    V.portrait = V.h > V.w * 1.05;
    const TL = 2 * (HL + CW + FRAME), TW = 2 * (HW + CW + FRAME);
    const small = Math.min(V.w, V.h) < 500;
    const m = small ? 4 : 14;
    // franjas reservadas para el resumen (arriba) y el aviso (abajo), así no tapan las troneras
    const mt = small ? 30 : 42, mb = small ? 24 : 34;
    const aw = V.w - 2 * m, ah = V.h - mt - mb;
    V.s = V.portrait ? Math.min(aw / TW, ah / TL) : Math.min(aw / TL, ah / TW);
    V.cx = V.w / 2;
    V.cy = mt + ah / 2;
    S.dirty = true;
  }

  // En vertical la mesa se gira 90°: la cabecera (donde sale la blanca) queda abajo.
  const toScreen = (x, y) => (V.portrait ? [V.cx - y * V.s, V.cy - x * V.s] : [V.cx + x * V.s, V.cy - y * V.s]);
  const toWorld = (sx, sy) => (V.portrait ? [-(sy - V.cy) / V.s, -(sx - V.cx) / V.s] : [(sx - V.cx) / V.s, -(sy - V.cy) / V.s]);
  function worldTransform() {
    const k = V.s * V.dpr;
    if (V.portrait) ctx.setTransform(0, -k, -k, 0, V.cx * V.dpr, V.cy * V.dpr);
    else ctx.setTransform(k, 0, 0, -k, V.cx * V.dpr, V.cy * V.dpr);
  }
  const screenTransform = () => ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);

  // ---------------------------------------------------------------- dibujo
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawTable() {
    const px = 1 / V.s;
    const OX = HL + CW + FRAME, OY = HW + CW + FRAME;

    // marco de madera
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    roundRect(-OX + 0.01, -OY - 0.02, 2 * OX, 2 * OY, 0.07);
    ctx.fill();
    const wood = ctx.createLinearGradient(0, -OY, 0, OY);
    wood.addColorStop(0, '#6b3d1f');
    wood.addColorStop(0.5, '#8a5129');
    wood.addColorStop(1, '#5a3218');
    ctx.fillStyle = wood;
    roundRect(-OX, -OY, 2 * OX, 2 * OY, 0.07);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,170,.18)';
    ctx.lineWidth = 2 * px;
    roundRect(-OX + 0.012, -OY + 0.012, 2 * OX - 0.024, 2 * OY - 0.024, 0.06);
    ctx.stroke();

    // paño
    const cloth = ctx.createRadialGradient(0, 0, 0.1, 0, 0, HL * 1.1);
    cloth.addColorStop(0, '#13895c');
    cloth.addColorStop(1, '#0b6343');
    ctx.fillStyle = cloth;
    ctx.fillRect(-HL - CW, -HW - CW, 2 * (HL + CW), 2 * (HW + CW));

    // troneras
    for (const p of POCKETS) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.draw + 0.008, 0, Math.PI * 2);
      ctx.fillStyle = '#2a1a10';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.draw, 0, Math.PI * 2);
      ctx.fillStyle = '#050505';
      ctx.fill();
    }

    // bandas
    for (const poly of RAILS) {
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = '#0a5a3d';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(poly[1][0], poly[1][1]);
      ctx.lineTo(poly[2][0], poly[2][1]);
      ctx.strokeStyle = 'rgba(160,255,200,.22)';
      ctx.lineWidth = 1.5 * px;
      ctx.stroke();
    }

    // diamantes
    ctx.fillStyle = '#efe3c2';
    const dm = Math.max(0.008, 2.2 * px);
    const diamond = (x, y) => {
      ctx.beginPath();
      ctx.moveTo(x - dm, y); ctx.lineTo(x, y + dm); ctx.lineTo(x + dm, y); ctx.lineTo(x, y - dm);
      ctx.closePath();
      ctx.fill();
    };
    const fy = HW + CW + FRAME * 0.5, fx = HL + CW + FRAME * 0.5;
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      const x = -HL + (i * 2 * HL) / 8;
      diamond(x, fy);
      diamond(x, -fy);
    }
    for (let j = 1; j < 4; j++) {
      const y = -HW + (j * 2 * HW) / 4;
      diamond(fx, y);
      diamond(-fx, y);
    }

    // línea de cabecera y puntos
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = 1 * px;
    ctx.setLineDash([6 * px, 6 * px]);
    ctx.beginPath();
    ctx.moveTo(-HL / 2, -HW);
    ctx.lineTo(-HL / 2, HW);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,.3)';
    for (const x of [-HL / 2, HL / 2]) {
      ctx.beginPath();
      ctx.arc(x, 0, 0.006, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawBall(b, alpha = 1) {
    const [x, y] = toScreen(b.x, b.y);
    const r = R * V.s;
    ctx.save();
    ctx.globalAlpha = alpha;

    ctx.beginPath();
    ctx.arc(x + r * 0.18, y + r * 0.22, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (b.num > 8) {
      ctx.fillStyle = '#f6f2e6';
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = colorOf(b.num);
      ctx.fillRect(x - r, y - r * 0.56, 2 * r, r * 1.12);
      ctx.restore();
    } else {
      ctx.fillStyle = colorOf(b.num);
      ctx.fill();
    }

    if (b.num > 0 && r > 4.5) {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.46, 0, Math.PI * 2);
      ctx.fillStyle = '#fbf8f0';
      ctx.fill();
      if (r > 6.5) {
        ctx.fillStyle = '#111';
        ctx.font = `700 ${Math.round(r * (b.num > 9 ? 0.52 : 0.62))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(b.num), x, y + r * 0.04);
      }
    }

    const shade = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r);
    shade.addColorStop(0, 'rgba(255,255,255,.6)');
    shade.addColorStop(0.35, 'rgba(255,255,255,.06)');
    shade.addColorStop(1, 'rgba(0,0,0,.38)');
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = shade;
    ctx.fill();
    ctx.restore();
  }

  function drawPrediction(alpha) {
    const pr = S.pred;
    if (!pr) return;
    const px = 1 / V.s;
    const lim = DETAIL[S.opts.detail];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const order = [];
    for (let n = 1; n <= 15; n++) if (S.opts.objPaths) order.push(n);
    order.push(0);
    const ends = [];
    for (const n of order) {
      const p = pr.paths[n];
      if (!p || !p.moved) continue;
      let end = p.pts.length / 2;
      if (p.ev.length > lim) end = p.ev[lim - 1] + 1;
      ends[n] = end;
      ctx.beginPath();
      ctx.moveTo(p.pts[0], p.pts[1]);
      for (let i = 1; i < end; i++) ctx.lineTo(p.pts[2 * i], p.pts[2 * i + 1]);
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = (n === 0 ? 4.5 : 4) * px;
      ctx.stroke();
      ctx.strokeStyle = pathColorOf(n);
      ctx.lineWidth = (n === 0 ? 2 : 2.2) * px;
      if (n === 0) ctx.setLineDash([]);
      ctx.stroke();

      // marcas en cada choque
      ctx.fillStyle = pathColorOf(n);
      for (const ei of p.ev) {
        if (ei >= end) break;
        ctx.beginPath();
        ctx.arc(p.pts[2 * ei], p.pts[2 * ei + 1], 2.6 * px, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // bola fantasma en el primer contacto
    if (pr.first) {
      ctx.beginPath();
      ctx.arc(pr.first.x, pr.first.y, R, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.14)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 1.5 * px;
      ctx.stroke();
    }

    // posiciones finales (solo si la trayectoria se muestra hasta el final)
    if (S.opts.finals) {
      ctx.setLineDash([3 * px, 3 * px]);
      ctx.lineWidth = 1.6 * px;
      for (const b of pr.balls) {
        const p = pr.paths[b.num];
        if (!b.on || !p.moved) continue;
        if (b.num !== 0 && !S.opts.objPaths) continue;
        if (ends[b.num] !== p.pts.length / 2) continue;
        ctx.beginPath();
        ctx.arc(b.x, b.y, R, 0, Math.PI * 2);
        ctx.strokeStyle = pathColorOf(b.num);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // troneras donde entra alguna bola
    for (const { num, pocket } of pr.pocketed) {
      const pk = POCKETS[pocket];
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, pk.draw + 0.004, 0, Math.PI * 2);
      ctx.strokeStyle = num === 0 ? '#e0574f' : '#57d18a';
      ctx.lineWidth = 3.5 * px;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCue() {
    const c = S.balls[0];
    const dx = Math.cos(S.aim), dy = Math.sin(S.aim), nx = -dy, ny = dx;
    const gap = R + 0.012 + (S.power / 100) * 0.16;
    const tx = c.x - dx * gap, ty = c.y - dy * gap;
    const len = 1.45, bx = tx - dx * len, by = ty - dy * len;
    const tw = 0.0062, bw = 0.0145;
    const poly = () => {
      ctx.beginPath();
      ctx.moveTo(tx + nx * tw, ty + ny * tw);
      ctx.lineTo(bx + nx * bw, by + ny * bw);
      ctx.lineTo(bx - nx * bw, by - ny * bw);
      ctx.lineTo(tx - nx * tw, ty - ny * tw);
      ctx.closePath();
    };
    ctx.save();
    ctx.translate(0.008, -0.012);
    poly();
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.fill();
    ctx.restore();
    const g = ctx.createLinearGradient(tx, ty, bx, by);
    g.addColorStop(0, '#3f78cf');
    g.addColorStop(0.006, '#3f78cf');
    g.addColorStop(0.007, '#f5f2ea');
    g.addColorStop(0.03, '#f5f2ea');
    g.addColorStop(0.031, '#e7d09c');
    g.addColorStop(0.6, '#cfa86a');
    g.addColorStop(0.62, '#2b1a10');
    g.addColorStop(0.7, '#5a2e17');
    g.addColorStop(0.72, '#2b1a10');
    g.addColorStop(1, '#170d07');
    poly();
    ctx.fillStyle = g;
    ctx.fill();
  }

  function draw() {
    screenTransform();
    ctx.clearRect(0, 0, V.w, V.h);
    worldTransform();
    drawTable();
    if (S.pred && S.balls[0]) drawPrediction(S.animating ? 0.3 : 1);
    screenTransform();
    for (const b of S.balls) {
      if (!b.on) continue;
      drawBall(b, drag && drag.ball === b && drag.out ? 0.35 : 1);
    }
    if (!S.animating && S.balls[0].on && S.mode === 'aim') {
      worldTransform();
      drawCue();
    }
  }

  // ---------------------------------------------------------------- predicción / tiro
  function computePrediction() {
    if (!S.balls[0].on) { S.pred = null; return; }
    const copy = P.cloneBalls(S.balls);
    P.strike(copy[0], S.aim, speed(), S.spinX, S.spinY, S.opts.squirt);
    S.pred = P.simulate(copy);
  }

  function summaryHTML() {
    const pr = S.pred;
    if (!pr) return '';
    const parts = [];
    if (pr.first) {
      parts.push(`Golpea ${nameOf(pr.first.num)}${pr.railsBeforeFirst ? ` tras ${pr.railsBeforeFirst} banda${pr.railsBeforeFirst > 1 ? 's' : ''}` : ''}`);
    } else {
      parts.push('<span class="bad">No toca ninguna bola</span>');
    }
    const inn = pr.pocketed.filter(p => p.num !== 0);
    if (inn.length) {
      parts.push(`<span class="ok">Entra${inn.length > 1 ? 'n' : ''} ${inn.map(p => `${nameOf(p.num)} (${POCKETS[p.pocket].kind})`).join(', ')}</span>`);
    } else if (pr.first) {
      parts.push('No entra ninguna');
    }
    if (pr.pocketed.some(p => p.num === 0)) parts.push('<span class="bad">¡La blanca entra!</span>');
    return parts.join(' · ');
  }

  function shoot() {
    if (S.animating) return skip();
    if (!S.balls[0].on) return;
    if (S.predDirty) computePrediction();
    S.predDirty = false;
    pushUndo();
    P.strike(S.balls[0], S.aim, speed(), S.spinX, S.spinY, S.opts.squirt);
    S.animating = true;
    S.ballInHand = false;
    S.mode = 'aim';
    acc = 0;
    updateUI();
  }

  function skip() {
    const max = Math.ceil(40 / DT);
    for (let i = 0; i < max; i++) if (!P.step(S.balls, null)) break;
    endShot();
  }

  function endShot() {
    S.animating = false;
    const cue = S.balls[0];
    if (!cue.on) {
      const [x, y] = findFree(-HL / 2, 0, cue);
      Object.assign(cue, { x, y, on: true, pocket: -1, moving: false });
      S.ballInHand = true;
    }
    changed();
  }

  // ---------------------------------------------------------------- bucle
  let acc = 0, last = 0;
  function frame(t) {
    const real = Math.min(0.05, (t - last) / 1000 || 0);
    last = t;
    if (S.animating) {
      acc += real;
      let n = 0;
      while (acc >= DT && n < 200) {
        acc -= DT;
        n++;
        if (!P.step(S.balls, null)) { endShot(); break; }
      }
      S.dirty = true;
    }
    if (S.predDirty && !S.animating) {
      computePrediction();
      S.predDirty = false;
      S.dirty = true;
      $('#summary').innerHTML = summaryHTML();
    }
    if (S.dirty) {
      draw();
      S.dirty = false;
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- entrada en la mesa
  let drag = null, aiming = null;

  function eventWorld(e) {
    const r = cv.getBoundingClientRect();
    return toWorld(e.clientX - r.left, e.clientY - r.top);
  }

  function ballAt(x, y) {
    const tol = R + 14 / V.s;
    let best = null, bd = tol;
    for (const b of S.balls) {
      if (!b.on) continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  function setAimTo(x, y) {
    const c = S.balls[0];
    if (Math.hypot(x - c.x, y - c.y) < R * 0.8) return;
    S.aim = Math.atan2(y - c.y, x - c.x);
    changed();
  }

  cv.addEventListener('pointerdown', e => {
    if (S.animating) return;
    if (e.button !== undefined && e.button > 0) return;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
    const [x, y] = eventWorld(e);
    const hit = ballAt(x, y);
    if (hit && (S.mode === 'move' || (S.ballInHand && hit.num === 0))) {
      drag = { ball: hit, ox: hit.x - x, oy: hit.y - y, out: false, from: [hit.x, hit.y] };
      return;
    }
    if (S.mode === 'aim') {
      // Con el dedo el giro es relativo (sin saltos y sin tapar la bola objetivo);
      // un toque sin deslizar apunta directamente a ese punto.
      const c = S.balls[0];
      const rel = e.pointerType === 'touch';
      aiming = { rel, x0: e.clientX, y0: e.clientY, moved: false, a0: Math.atan2(y - c.y, x - c.x) };
      if (!rel) setAimTo(x, y);
    }
  });

  cv.addEventListener('pointermove', e => {
    if (!drag && !aiming) return;
    const [x, y] = eventWorld(e);
    if (drag) {
      const nx = x + drag.ox, ny = y + drag.oy;
      drag.out = drag.ball.num !== 0 && (Math.abs(nx) > HL + CW + 0.02 || Math.abs(ny) > HW + CW + 0.02);
      drag.ball.x = clampX(nx);
      drag.ball.y = clampY(ny);
      changed();
    } else if (!aiming.rel) {
      setAimTo(x, y);
    } else {
      if (!aiming.moved && Math.hypot(e.clientX - aiming.x0, e.clientY - aiming.y0) < 8) return;
      aiming.moved = true;
      const c = S.balls[0];
      if (Math.hypot(x - c.x, y - c.y) < R * 1.5) return;
      const a = Math.atan2(y - c.y, x - c.x);
      const da = Math.atan2(Math.sin(a - aiming.a0), Math.cos(a - aiming.a0));
      aiming.a0 = a;
      rotate(da);
    }
  });

  function endPointer(e) {
    if (aiming && aiming.rel && !aiming.moved && e.type === 'pointerup') {
      const [x, y] = eventWorld(e);
      setAimTo(x, y);
    }
    if (drag) {
      const b = drag.ball;
      if (drag.out) {
        b.on = false;
      } else {
        const [x, y] = findFree(b.x, b.y, b);
        b.x = x;
        b.y = y;
      }
      drag = null;
      changed();
    }
    aiming = null;
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (S.animating) return;
    const step = (e.shiftKey ? 0.5 : 0.05) * (Math.PI / 180);
    rotate(e.deltaY > 0 ? -step : step);
  }, { passive: false });

  function rotate(da) {
    S.aim = Math.atan2(Math.sin(S.aim + da), Math.cos(S.aim + da));
    changed();
  }

  // ---------------------------------------------------------------- selector de efecto
  const spinCv = $('#spin'), sctx = spinCv.getContext('2d');
  const SPIN_MAX = 0.5;

  function drawSpin() {
    const size = spinCv.clientWidth, dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (spinCv.width !== Math.round(size * dpr)) {
      spinCv.width = spinCv.height = Math.round(size * dpr);
    }
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, size, size);
    const c = size / 2, r = c - 3;
    const g = sctx.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#c9c3b3');
    sctx.beginPath();
    sctx.arc(c, c, r, 0, Math.PI * 2);
    sctx.fillStyle = g;
    sctx.fill();
    sctx.strokeStyle = 'rgba(0,0,0,.18)';
    sctx.lineWidth = 1;
    sctx.beginPath();
    sctx.moveTo(c - r, c); sctx.lineTo(c + r, c);
    sctx.moveTo(c, c - r); sctx.lineTo(c, c + r);
    sctx.stroke();
    sctx.setLineDash([3, 3]);
    sctx.strokeStyle = 'rgba(200,40,40,.5)';
    sctx.beginPath();
    sctx.arc(c, c, r * SPIN_MAX, 0, Math.PI * 2);
    sctx.stroke();
    sctx.setLineDash([]);
    const x = c + S.spinX * r, y = c - S.spinY * r;
    sctx.beginPath();
    sctx.arc(x, y, Math.max(5, r * 0.09), 0, Math.PI * 2);
    sctx.fillStyle = '#2f6fd6';
    sctx.fill();
    sctx.strokeStyle = '#0d1311';
    sctx.lineWidth = 1.5;
    sctx.stroke();
  }

  function setSpinFrom(e) {
    const rect = spinCv.getBoundingClientRect();
    const r = rect.width / 2 - 3;
    let sx = (e.clientX - rect.left - rect.width / 2) / r;
    let sy = -(e.clientY - rect.top - rect.height / 2) / r;
    const m = Math.hypot(sx, sy);
    if (m > SPIN_MAX) { sx *= SPIN_MAX / m; sy *= SPIN_MAX / m; }
    if (Math.hypot(sx, sy) < 0.025) sx = sy = 0;
    S.spinX = sx;
    S.spinY = sy;
    changed();
  }

  let spinDrag = false, lastTap = -Infinity;
  spinCv.addEventListener('pointerdown', e => {
    try { spinCv.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
    const now = performance.now();
    if (now - lastTap < 300) { S.spinX = S.spinY = 0; changed(); lastTap = -Infinity; return; }
    lastTap = now;
    spinDrag = true;
    setSpinFrom(e);
  });
  spinCv.addEventListener('pointermove', e => { if (spinDrag) setSpinFrom(e); });
  spinCv.addEventListener('pointerup', () => { spinDrag = false; });
  spinCv.addEventListener('pointercancel', () => { spinDrag = false; });
  $('#spinOut').addEventListener('click', () => { S.spinX = S.spinY = 0; changed(); });

  // ---------------------------------------------------------------- ajuste fino de dirección
  const strip = $('#strip');
  let stripX = null;
  strip.addEventListener('pointerdown', e => {
    try { strip.setPointerCapture(e.pointerId); } catch (err) { /* puntero sintético */ }
    stripX = e.clientX;
    strip.classList.add('active');
  });
  strip.addEventListener('pointermove', e => {
    if (stripX === null || S.animating) return;
    const dx = e.clientX - stripX;
    stripX = e.clientX;
    rotate(-dx * 0.02 * (Math.PI / 180));
  });
  const stripEnd = () => { stripX = null; strip.classList.remove('active'); };
  strip.addEventListener('pointerup', stripEnd);
  strip.addEventListener('pointercancel', stripEnd);

  document.querySelectorAll('.rot').forEach(btn => {
    let timer = null, rep = null;
    const dir = Number(btn.dataset.rot);
    const once = () => { if (!S.animating) rotate(dir * 0.1 * (Math.PI / 180)); };
    const stop = () => { clearTimeout(timer); clearInterval(rep); timer = rep = null; };
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      once();
      timer = setTimeout(() => { rep = setInterval(once, 45); }, 350);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('contextmenu', e => e.preventDefault());
  });

  // ---------------------------------------------------------------- UI
  const power = $('#power');
  power.addEventListener('input', () => {
    S.power = Number(power.value);
    store.save();
    changed();
  });

  $('#btnShoot').addEventListener('click', shoot);
  $('#btnUndo').addEventListener('click', undo);
  $('#btnMove').addEventListener('click', () => {
    if (S.animating) return;
    S.mode = S.mode === 'move' ? 'aim' : 'move';
    changed();
  });
  $('#selRack').addEventListener('change', e => {
    const v = e.target.value;
    e.target.value = '';
    if (!v) return;
    pushUndo();
    rack(v);
  });

  const optsCard = $('#opts'), btnOpts = $('#btnOpts');
  const setOpts = open => {
    optsCard.hidden = !open;
    btnOpts.setAttribute('aria-expanded', String(open));
  };
  btnOpts.addEventListener('click', e => { e.stopPropagation(); setOpts(optsCard.hidden); });
  $('#optsClose').addEventListener('click', () => setOpts(false));
  document.addEventListener('pointerdown', e => {
    if (!optsCard.hidden && !optsCard.contains(e.target) && e.target !== btnOpts && !btnOpts.contains(e.target)) setOpts(false);
  });
  const bindOpt = (id, key, prop = 'checked') => {
    const el = $(id);
    el[prop] = S.opts[key];
    el.addEventListener('change', () => {
      S.opts[key] = el[prop];
      store.save();
      changed();
    });
  };

  const tray = $('#tray');
  tray.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip || S.animating) return;
    const b = S.balls[Number(chip.dataset.n)];
    const [x, y] = findFree(HL / 2, 0, b);
    Object.assign(b, { x, y, on: true, pocket: -1, moving: false });
    S.mode = 'move';
    changed();
  });

  function renderTray() {
    const off = S.balls.filter(b => !b.on && b.num > 0);
    const key = off.map(b => b.num).join(',');
    if (tray.dataset.key === key) return;
    tray.dataset.key = key;
    tray.innerHTML = off.map(b => {
      const c = colorOf(b.num);
      const bg = b.num > 8 ? `linear-gradient(#f6f2e6 0 24%, ${c} 24% 76%, #f6f2e6 76%)` : c;
      return `<button class="chip" data-n="${b.num}" style="background:${bg}" title="Colocar la bola ${b.num}"><span>${b.num}</span></button>`;
    }).join('');
  }

  function spinText() {
    const pct = v => `${Math.round((Math.abs(v) / SPIN_MAX) * 100)}%`;
    const parts = [];
    if (S.spinY > 0.01) parts.push(`Alto ${pct(S.spinY)}`);
    if (S.spinY < -0.01) parts.push(`Bajo ${pct(S.spinY)}`);
    if (S.spinX > 0.01) parts.push(`Der ${pct(S.spinX)}`);
    if (S.spinX < -0.01) parts.push(`Izq ${pct(S.spinX)}`);
    return parts.length ? parts.join(' · ') : 'Centro';
  }

  function updateUI() {
    power.value = S.power;
    $('#powOut').textContent = `${S.power}% · ${speed().toFixed(2)} m/s`;
    const deg = ((S.aim * 180) / Math.PI + 360) % 360;
    $('#aimOut').textContent = `${deg.toFixed(2)}°`;
    $('#spinOut').textContent = spinText();
    const shootBtn = $('#btnShoot');
    shootBtn.textContent = S.animating ? 'Saltar ⏭' : 'Tirar';
    shootBtn.classList.toggle('skip', S.animating);
    $('#btnMove').setAttribute('aria-pressed', String(S.mode === 'move'));
    $('#btnMove').disabled = S.animating;
    $('#btnUndo').disabled = !S.undo.length;
    cv.classList.toggle('move', S.mode === 'move');
    const hint = $('#hint');
    hint.classList.toggle('strong', false);
    if (S.animating) hint.textContent = '';
    else if (S.mode === 'move') hint.textContent = 'Arrastra las bolas · sácalas de la mesa para quitarlas';
    else if (S.ballInHand) { hint.textContent = 'Bola en mano: arrastra la blanca o apunta'; hint.classList.add('strong'); }
    else hint.textContent = '';
    renderTray();
    drawSpin();
  }

  // ---------------------------------------------------------------- teclado
  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLSelectElement) return;
    const deg = Math.PI / 180;
    const fine = e.altKey ? 0.01 : e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (!S.animating) rotate(fine * deg); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (!S.animating) rotate(-fine * deg); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      S.power = Math.max(1, Math.min(100, S.power + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 1)));
      store.save();
      changed();
    }
    else if (e.key === ' ' || e.key === 'Enter') { if (e.target === document.body || e.target === cv) { e.preventDefault(); shoot(); } }
    else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
    else if (e.key === 'm' || e.key === 'M') { if (!S.animating) { S.mode = S.mode === 'move' ? 'aim' : 'move'; changed(); } }
  });

  // ---------------------------------------------------------------- inicio
  store.load();
  bindOpt('#optDetail', 'detail', 'value');
  bindOpt('#optObj', 'objPaths');
  bindOpt('#optFinals', 'finals');
  bindOpt('#optSquirt', 'squirt');
  new ResizeObserver(() => { resize(); drawSpin(); }).observe(stage);
  new ResizeObserver(drawSpin).observe(spinCv);
  resize();
  rack('8');
  requestAnimationFrame(frame);
})();
