'use strict';
/*
 * Motor físico del simulador de billar.
 * Unidades SI (m, s, rad). Origen en el centro de la mesa, eje x a lo largo, eje y hacia arriba.
 * Modelo: deslizamiento/rodadura con fricción del paño, efecto lateral (wz), efecto
 * alto/bajo (wx, wy), choques bola-bola con fricción (throw) y bandas con fricción.
 * El paso de tiempo es fijo, así que la predicción y el tiro real son idénticos.
 */
(function (global) {
  const G = 9.81;
  const L = 2.54, W = 1.27, HL = L / 2, HW = W / 2;   // mesa de 9 pies
  const R = 0.028575;                                 // radio de bola (57.15 mm)
  const CW = 0.05, FRAME = 0.11;                      // ancho de banda y de marco
  const DT = 1 / 400;
  const MU_SLIDE = 0.2, MU_ROLL = 0.011, SPIN_DECEL = 10;
  const E_BALL = 0.95, MU_BALL = 0.06;
  const E_CUSH = 0.8, MU_CUSH = 0.2;
  const MAX_SPEED = 7;
  const SQUIRT_K = 0.045;                             // desvío de la blanca por efecto lateral

  // Geometría de bandas: cada banda es un polígono [mandíbula, punta, punta, mandíbula]
  const CORNER = 0.082, SIDE = 0.064, JAW_C = 1.15, JAW_S = 0.25;
  const RAILS = (() => {
    const top = [[-HL + CORNER - JAW_C * CW, HW + CW], [-HL + CORNER, HW], [-SIDE, HW], [-SIDE + JAW_S * CW, HW + CW]];
    const end = [[-HL - CW, HW - CORNER + JAW_C * CW], [-HL, HW - CORNER], [-HL, -HW + CORNER], [-HL - CW, -HW + CORNER - JAW_C * CW]];
    const out = [];
    for (const sx of [1, -1]) for (const sy of [1, -1]) out.push(top.map(([x, y]) => [x * sx, y * sy]));
    for (const sx of [1, -1]) out.push(end.map(([x, y]) => [x * sx, y]));
    return out;
  })();

  const SEGS = [];
  for (const poly of RAILS) {
    for (let i = 0; i < 3; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[i + 1];
      const dx = bx - ax, dy = by - ay;
      SEGS.push({ ax, ay, dx, dy, len2: dx * dx + dy * dy });
    }
  }

  const C = 0.012, S = 0.04;
  const POCKETS = [
    { x: -HL - C, y: HW + C, r: 0.06, draw: 0.066, kind: 'esquina' },
    { x: 0, y: HW + S, r: 0.052, draw: 0.058, kind: 'lateral' },
    { x: HL + C, y: HW + C, r: 0.06, draw: 0.066, kind: 'esquina' },
    { x: -HL - C, y: -HW - C, r: 0.06, draw: 0.066, kind: 'esquina' },
    { x: 0, y: -HW - S, r: 0.052, draw: 0.058, kind: 'lateral' },
    { x: HL + C, y: -HW - C, r: 0.06, draw: 0.066, kind: 'esquina' },
  ];

  function makeBall(num, x, y, on = true) {
    return { num, x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on, moving: false, pocket: -1 };
  }

  function cloneBalls(balls) {
    return balls.map(b => ({ ...b }));
  }

  /**
   * Golpe de taco. sx, sy: punto de contacto como fracción del radio
   * (sx > 0 = derecha, sy > 0 = arriba). Una bola golpeada a 2/5 R arriba sale rodando.
   */
  function strike(b, angle, speed, sx, sy, squirt) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const a = angle + (squirt ? sx * SQUIRT_K : 0);
    const k = 2.5 * speed / R;
    b.vx = Math.cos(a) * speed;
    b.vy = Math.sin(a) * speed;
    b.wz = k * sx;
    b.wx = -dy * k * sy;
    b.wy = dx * k * sy;
    b.moving = true;
  }

  function applyFriction(b) {
    // velocidad del punto de contacto con el paño
    const ux = b.vx - R * b.wy, uy = b.vy + R * b.wx;
    const un = Math.hypot(ux, uy);
    if (un > 3.5 * MU_SLIDE * G * DT) {
      const fx = ux / un, fy = uy / un, a = MU_SLIDE * G * DT;
      b.vx -= fx * a;
      b.vy -= fy * a;
      const k = 2.5 * a / R;
      b.wy += fx * k;
      b.wx -= fy * k;
    } else {
      const sp = Math.hypot(b.vx, b.vy), dec = MU_ROLL * G * DT;
      if (sp <= dec) {
        b.vx = b.vy = b.wx = b.wy = b.wz = 0;
        b.moving = false;
        return;
      }
      const f = (sp - dec) / sp;
      b.vx *= f;
      b.vy *= f;
      b.wy = b.vx / R;
      b.wx = -b.vy / R;
    }
    const sd = SPIN_DECEL * DT;
    b.wz = Math.abs(b.wz) <= sd ? 0 : b.wz - Math.sign(b.wz) * sd;
  }

  function collideBalls(a, b, emit) {
    const rvx = a.vx - b.vx, rvy = a.vy - b.vy;
    let dx = b.x - a.x, dy = b.y - a.y;
    let d = Math.hypot(dx, dy) || 1e-9;
    if (rvx * dx + rvy * dy <= 0) {
      separate(a, b, dx, dy, d);
      return;
    }
    // retroceder ambas bolas al instante exacto de contacto
    const qa = rvx * rvx + rvy * rvy, qb = 2 * (dx * rvx + dy * rvy), qc = dx * dx + dy * dy - 4 * R * R;
    let tau = qa > 1e-12 ? (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa) : 0;
    tau = Math.min(tau, DT * 1.5);
    a.x -= a.vx * tau; a.y -= a.vy * tau;
    b.x -= b.vx * tau; b.y -= b.vy * tau;
    dx = b.x - a.x; dy = b.y - a.y;
    d = Math.hypot(dx, dy) || 1e-9;
    const nx = dx / d, ny = dy / d;
    const vn = rvx * nx + rvy * ny;

    const jn = 0.5 * (1 + E_BALL) * vn;
    a.vx -= jn * nx; a.vy -= jn * ny;
    b.vx += jn * nx; b.vy += jn * ny;

    // fricción entre bolas: produce "throw" por corte y por efecto
    const tx = -ny, ty = nx;
    const slip = (a.vx - b.vx) * tx + (a.vy - b.vy) * ty + R * (a.wz + b.wz);
    if (slip !== 0) {
      const jt = -Math.sign(slip) * Math.min(MU_BALL * jn, Math.abs(slip) / 7);
      a.vx += jt * tx; a.vy += jt * ty;
      b.vx -= jt * tx; b.vy -= jt * ty;
      const dw = 2.5 * jt / R;
      a.wz += dw;
      b.wz += dw;
    }
    if (emit) emit('ball', a, b);

    a.x += a.vx * tau; a.y += a.vy * tau;
    b.x += b.vx * tau; b.y += b.vy * tau;
    a.moving = b.moving = true;
    dx = b.x - a.x; dy = b.y - a.y;
    separate(a, b, dx, dy, Math.hypot(dx, dy) || 1e-9);
  }

  function separate(a, b, dx, dy, d) {
    const overlap = 2 * R - d;
    if (overlap <= 0) return;
    const nx = dx / d, ny = dy / d, h = overlap / 2 + 1e-7;
    a.x -= nx * h; a.y -= ny * h;
    b.x += nx * h; b.y += ny * h;
  }

  function cushion(b, nx, ny, vn) {
    const jn = -(1 + E_CUSH) * vn;
    b.vx += jn * nx;
    b.vy += jn * ny;
    // el efecto lateral abre o cierra el ángulo de salida
    const tx = -ny, ty = nx;
    const slip = b.vx * tx + b.vy * ty - R * b.wz;
    const jt = -Math.sign(slip) * Math.min(MU_CUSH * jn, Math.abs(slip) / 3.5);
    b.vx += jt * tx;
    b.vy += jt * ty;
    b.wz -= 2.5 * jt / R;
    // la banda absorbe la rotación de avance perpendicular a ella
    let sx = R * b.wy, sy = -R * b.wx;
    const sn = sx * nx + sy * ny;
    sx -= sn * nx;
    sy -= sn * ny;
    b.wy = sx / R;
    b.wx = -sy / R;
  }

  function collideRails(b, emit) {
    for (const s of SEGS) {
      let t = ((b.x - s.ax) * s.dx + (b.y - s.ay) * s.dy) / s.len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = s.ax + t * s.dx, cy = s.ay + t * s.dy;
      let nx = b.x - cx, ny = b.y - cy;
      const d2 = nx * nx + ny * ny;
      if (d2 >= R * R) continue;
      const d = Math.sqrt(d2) || 1e-9;
      nx /= d; ny /= d;
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        const tau = Math.min((R - d) / -vn, DT * 1.5);
        b.x -= b.vx * tau; b.y -= b.vy * tau;
        cushion(b, nx, ny, vn);
        if (emit) emit('rail', b);
        b.x += b.vx * tau; b.y += b.vy * tau;
      }
      const ex = b.x - cx, ey = b.y - cy, ed = Math.hypot(ex, ey);
      if (ed < R) {
        b.x = cx + nx * (R + 1e-7);
        b.y = cy + ny * (R + 1e-7);
      }
    }
  }

  function checkPocket(b, emit) {
    for (let i = 0; i < POCKETS.length; i++) {
      const p = POCKETS[i], dx = b.x - p.x, dy = b.y - p.y;
      if (dx * dx + dy * dy < p.r * p.r) return sink(b, i, emit);
    }
    // si atravesó la boca de una tronera ya no puede volver
    if (Math.abs(b.x) > HL + 0.02 || Math.abs(b.y) > HW + 0.02) {
      let best = 0, bd = Infinity;
      POCKETS.forEach((p, i) => {
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < bd) { bd = d; best = i; }
      });
      sink(b, best, emit);
    }
  }

  function sink(b, i, emit) {
    if (emit) emit('pocket', b, i);
    b.on = false;
    b.moving = false;
    b.pocket = i;
    b.vx = b.vy = b.wx = b.wy = b.wz = 0;
  }

  /** Avanza un paso DT. Devuelve true si alguna bola sigue en movimiento. */
  function step(balls, emit) {
    const n = balls.length;
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (!b.on || !b.moving) continue;
      b.x += b.vx * DT;
      b.y += b.vy * DT;
      applyFriction(b);
    }
    const r2 = 4 * R * R;
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      if (!a.on) continue;
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (!b.on || !(a.moving || b.moving)) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        if (dx * dx + dy * dy < r2) collideBalls(a, b, emit);
      }
    }
    let any = false;
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (!b.on || !b.moving) continue;
      if (Math.abs(b.x) > HL - R - 1e-4 || Math.abs(b.y) > HW - R - 1e-4) {
        collideRails(b, emit);
        checkPocket(b, emit);
      }
      if (b.moving) any = true;
    }
    return any;
  }

  /**
   * Simula el tiro completo y registra trayectorias.
   * paths[num] = { pts: [x0,y0,x1,y1,...], ev: [índices de punto con choque], moved }
   */
  function simulate(balls, maxTime = 40) {
    const paths = [];
    for (const b of balls) paths[b.num] = { pts: [b.x, b.y], ev: [], moved: false };
    let first = null, railsBeforeFirst = 0;
    const pocketed = [];
    const mark = b => {
      const p = paths[b.num];
      p.pts.push(b.x, b.y);
      p.ev.push(p.pts.length / 2 - 1);
      p.moved = true;
    };
    const emit = (type, a, b) => {
      if (type === 'ball') {
        if (!first && (a.num === 0 || b.num === 0)) {
          const cue = a.num === 0 ? a : b, obj = a.num === 0 ? b : a;
          first = { num: obj.num, x: cue.x, y: cue.y };
        }
        mark(a);
        mark(b);
      } else if (type === 'rail') {
        if (a.num === 0 && !first) railsBeforeFirst++;
        mark(a);
      } else if (type === 'pocket') {
        pocketed.push({ num: a.num, pocket: b });
        mark(a);
      }
    };
    const maxSteps = Math.ceil(maxTime / DT);
    let s = 0;
    for (; s < maxSteps; s++) {
      const any = step(balls, emit);
      if ((s & 3) === 3 || !any) {
        for (const b of balls) {
          if (!b.on) continue;
          const p = paths[b.num];
          if (b.moving) p.moved = true;
          if (b.moving || (!any && p.moved)) p.pts.push(b.x, b.y);
        }
      }
      if (!any) break;
    }
    return { paths, first, pocketed, railsBeforeFirst, balls, time: s * DT };
  }

  global.Pool = {
    G, L, W, HL, HW, R, CW, FRAME, DT, MAX_SPEED, SQUIRT_K,
    RAILS, POCKETS, makeBall, cloneBalls, strike, step, simulate,
  };
})(window);
