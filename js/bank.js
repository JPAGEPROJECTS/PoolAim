'use strict';
/*
 * Entrenador de tiros a banda.
 * Busca con el motor físico real los ángulos de tiro que cumplen un patrón:
 * la blanca toca `k` bandas antes de la bola objetivo y la bola objetivo toca `b`
 * bandas antes de entrar en la tronera. También calcula la referencia del espejo
 * (reflexión geométrica pura) y los diamantes, que es lo que se usa en una mesa real.
 */
(function (global) {
  const P = global.Pool;
  const { R, HL, HW, CW, FRAME, DT, POCKETS } = P;
  const DIAMOND_X = HL + CW + FRAME * 0.5, DIAMOND_Y = HW + CW + FRAME * 0.5;
  const LONG_UNIT = (2 * HL) / 8, SHORT_UNIT = (2 * HW) / 4;
  const CLEAN_DIST = 0.28;

  // bandas en coordenadas de mundo; `c` es la línea por la que pasa el centro de la bola al tocarla
  const RAILS = {
    top: { axis: 'y', sign: 1, c: HW - R, long: true },
    bottom: { axis: 'y', sign: -1, c: -(HW - R), long: true },
    right: { axis: 'x', sign: 1, c: HL - R, long: false },
    left: { axis: 'x', sign: -1, c: -(HL - R), long: false },
  };

  function railOf(x, y) {
    const dy = HW - Math.abs(y), dx = HL - Math.abs(x);
    if (dy < dx) return y > 0 ? 'top' : 'bottom';
    return x > 0 ? 'right' : 'left';
  }

  /** El centro de la bola queda fuera del tramo recto de la banda: ha tocado una mandíbula. */
  function isJaw(pt) {
    if (RAILS[pt.rail].long) {
      const ax = Math.abs(pt.x);
      return ax < P.SIDE || ax > HL - P.CORNER;
    }
    return Math.abs(pt.y) > HW - P.CORNER;
  }

  /** Distancia en diamantes desde la esquina más cercana, como se cuenta en una mesa real. */
  function fromCorner(d, rail) {
    return RAILS[rail].long ? Math.min(d, 8 - d) : Math.min(d, 4 - d);
  }

  function reflect(pt, rail) {
    const r = RAILS[rail];
    return r.axis === 'y' ? { x: pt.x, y: 2 * r.c - pt.y } : { x: 2 * r.c - pt.x, y: pt.y };
  }

  /** Punto donde la recta a→b cruza la línea de una banda (o null). */
  function crossRail(a, b, rail, line) {
    const r = RAILS[rail];
    const c = line === undefined ? r.c : line;
    const ka = r.axis, kb = ka === 'y' ? 'x' : 'y';
    const d = b[ka] - a[ka];
    if (Math.abs(d) < 1e-9) return null;
    const t = (c - a[ka]) / d;
    const p = {};
    p[ka] = c;
    p[kb] = a[kb] + t * (b[kb] - a[kb]);
    return p;
  }

  /**
   * Número de diamante de un punto a lo largo de una banda.
   * Bandas largas: 0 a 8 de izquierda a derecha (la lateral es el 4). Cortas: 0 a 4 de abajo a arriba.
   */
  function diamondOf(pt, rail) {
    return RAILS[rail].long ? (pt.x + HL) / LONG_UNIT : (pt.y + HW) / SHORT_UNIT;
  }

  /**
   * Diamante al que hay que mirar: la recta de llegada a la banda prolongada hasta la fila
   * de diamantes del marco. Es la referencia que se usa en una mesa de verdad.
   */
  function aimDiamond(from, hit, rail) {
    const r = RAILS[rail];
    const line = r.sign * (r.axis === 'y' ? DIAMOND_Y : DIAMOND_X);
    const p = crossRail(from, hit, rail, line);
    return p ? { pt: p, d: diamondOf(p, rail) } : null;
  }

  /**
   * Un intento de tiro con parada temprana. `quick` para en el primer contacto de la blanca.
   */
  function trial(base, spec, aim, quick) {
    const balls = P.cloneBalls(base);
    const cue = balls[0];
    P.strike(cue, aim, spec.speed, spec.sx, spec.sy, spec.squirt);
    const r = { aim, contact: null, cueRails: [], objRails: [], pocket: -1, fail: null };
    let stop = false;
    const fail = why => { if (!r.fail) r.fail = why; stop = true; };
    const emit = (type, a, c) => {
      if (stop) return;
      if (type === 'ball') {
        if (r.contact || (a.num !== 0 && c.num !== 0)) return;
        const other = a.num === 0 ? c : a;
        if (other.num !== spec.obj) return fail('other');
        r.contact = { x: cue.x, y: cue.y, ox: other.x, oy: other.y };
        if (r.cueRails.length !== spec.k) return fail('cueRails');
        if (quick) stop = true;
      } else if (type === 'rail') {
        const pt = { x: a.x, y: a.y, rail: railOf(a.x, a.y) };
        const counts = (a.num === 0 && !r.contact) || (a.num === spec.obj && r.contact);
        // un toque en la boca de la tronera no es una banda limpia
        if (counts && isJaw(pt)) return fail('jaw');
        if (a.num === 0 && !r.contact) {
          r.cueRails.push(pt);
          if (r.cueRails.length > spec.k) fail('cueRails');
        } else if (a.num === spec.obj && r.contact) {
          r.objRails.push(pt);
          if (r.objRails.length > spec.b) fail('objRails');
        }
      } else if (type === 'pocket') {
        if (a.num === spec.obj) { r.pocket = c; stop = true; }
        else if (a.num === 0 && !r.contact) fail('scratch');
      }
    };
    const max = Math.ceil(14 / DT);
    for (let s = 0; s < max && !stop; s++) if (!P.step(balls, emit)) break;
    if (!r.contact && !r.fail) r.fail = 'miss';
    r.ok = !r.fail && r.pocket >= 0 && r.objRails.length === spec.b &&
      (spec.pocket < 0 || r.pocket === spec.pocket);
    return r;
  }

  function onTable(allBalls) {
    return P.cloneBalls(allBalls.filter(b => b.on)).sort((a, b) => a.num - b.num);
  }

  /** Resultado de un tiro concreto (el que hace el jugador). */
  function attempt(allBalls, spec, aim) {
    return trial(onTable(allBalls), spec, aim, false);
  }

  /** Banda "de verdad": ningún contacto pegado a una tronera (eso sería rozar la boca, no una banda). */
  function isClean(res) {
    return [...res.cueRails, ...res.objRails].every(h => POCKETS.every(p => Math.hypot(h.x - p.x, h.y - p.y) > CLEAN_DIST));
  }

  const DEG = Math.PI / 180;
  const COARSE = 0.25 * DEG, FINE = 0.02 * DEG;

  /**
   * Busca todas las soluciones. spec = { obj, k, b, pocket (-1 = cualquiera), speed, sx, sy, squirt }.
   * Devuelve [{ aim, width (grados), pocket, clean, res }]: primero las bandas limpias, y de más fácil a más difícil.
   * Trabaja por tramos: `budgetMs` limita cada llamada a `next()` para no bloquear la interfaz.
   */
  function solver(allBalls, spec) {
    const base = onTable(allBalls);
    if (!base.length || base[0].num !== 0) return { done: true, solutions: [], next() { return true; } };

    // fase 1: ventanas de ángulo en las que la blanca llega a la bola con k bandas
    const n = Math.round((2 * Math.PI) / COARSE);
    const hits = new Uint8Array(n);
    let i = 0;
    const windows = [];
    let wi = 0, a = 0, aEnd = 0, run = 0, runPocket = -1;
    let phase = 1;
    const solutions = [];

    function buildWindows() {
      // tramos circulares de aciertos, ampliados un paso por cada lado
      for (let j = 0; j < n; j++) {
        if (!hits[j] || hits[(j - 1 + n) % n]) continue;
        let e = j;
        while (hits[(e + 1) % n] && (e + 1) % n !== j) e = (e + 1) % n;
        const len = (e - j + n) % n + 1;
        windows.push([(j - 1) * COARSE, (j + len) * COARSE]);
      }
      if (!windows.length && hits.every(h => h)) windows.push([0, 2 * Math.PI]);
    }

    function closeRun() {
      if (run > 0) {
        const w = run * FINE;
        const mid = a - FINE - (w - FINE) / 2;
        const res = trial(base, spec, mid, false);
        if (res.ok) solutions.push({ aim: mid, width: w / DEG, pocket: res.pocket, clean: isClean(res), res });
      }
      run = 0;
    }

    const it = {
      done: false,
      solutions,
      progress: 0,
      next(budgetMs = 12) {
        const t0 = performance.now();
        while (!it.done && performance.now() - t0 < budgetMs) {
          if (phase === 1) {
            for (let c = 0; c < 24 && i < n; c++, i++) {
              const r = trial(base, spec, i * COARSE, true);
              hits[i] = r.contact && !r.fail ? 1 : 0;
            }
            it.progress = (i / n) * 0.3;
            if (i >= n) {
              buildWindows();
              phase = 2;
              if (windows.length) { a = windows[0][0]; aEnd = windows[0][1]; }
            }
          } else {
            if (wi >= windows.length) {
              solutions.sort((p, q) => q.clean - p.clean || q.width - p.width);
              it.done = true;
              it.progress = 1;
              break;
            }
            for (let c = 0; c < 8 && a <= aEnd; c++, a += FINE) {
              const r = trial(base, spec, a, false);
              if (r.ok && run && r.pocket !== runPocket) closeRun();
              if (r.ok) { run++; runPocket = r.pocket; } else closeRun();
            }
            if (a > aEnd) {
              closeRun();
              wi++;
              if (wi < windows.length) { a = windows[wi][0]; aEnd = windows[wi][1]; }
            }
            it.progress = 0.3 + 0.7 * (wi / Math.max(1, windows.length));
          }
        }
        return it.done;
      },
    };
    return it;
  }

  /**
   * Referencia geométrica (espejo) para el primer tramo con banda de una solución.
   * Para la blanca (k ≥ 1): se refleja la bola fantasma en cada banda, de la última a la primera.
   * Para la bola (k = 0, b ≥ 1): se refleja el centro de la tronera.
   */
  function mirror(balls, spec, res) {
    const cue = balls.find(b => b.num === 0), obj = balls.find(b => b.num === spec.obj);
    if (!res.contact) return null;
    let from, target, rails, who;
    if (spec.k > 0) {
      from = { x: cue.x, y: cue.y };
      target = { x: res.contact.x, y: res.contact.y };
      rails = res.cueRails;
      who = 0;
    } else if (spec.b > 0 && res.pocket >= 0) {
      from = { x: obj.x, y: obj.y };
      const pk = POCKETS[res.pocket];
      target = { x: pk.x, y: pk.y };
      rails = res.objRails;
      who = spec.obj;
    } else {
      return null;
    }
    if (!rails.length) return null;
    let img = target;
    for (let j = rails.length - 1; j >= 0; j--) img = reflect(img, rails[j].rail);
    const first = rails[0];
    const geo = crossRail(from, img, first.rail);
    return {
      who, from, target, image: img, rail: first.rail,
      geoHit: geo, realHit: { x: first.x, y: first.y },
      geoDiamond: geo ? aimDiamond(from, geo, first.rail) : null,
      realDiamond: aimDiamond(from, first, first.rail),
    };
  }

  /**
   * Colocación aleatoria para un ejercicio: blanca y bola 1 lejos de bandas y troneras.
   * En los tiros con la blanca a banda (kick) se pone la 8 tapando el tiro directo.
   */
  function randomLayout(k) {
    const balls = [];
    for (let n = 0; n <= 15; n++) balls.push(P.makeBall(n, 0, 0, false));
    const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    const ok = (x, y) =>
      balls.every(o => !o.on || Math.hypot(o.x - x, o.y - y) > 3 * R) &&
      POCKETS.every(p => Math.hypot(p.x - x, p.y - y) > 0.3);
    const place = (n, test) => {
      for (let t = 0; t < 200; t++) {
        const x = rnd(-HL + 0.12, HL - 0.12), y = rnd(-HW + 0.12, HW - 0.12);
        if (ok(x, y) && (!test || test(x, y))) { Object.assign(balls[n], { x, y, on: true }); return true; }
      }
      return false;
    };
    const obj = balls[1], cue = balls[0];
    if (!place(1) || !place(0, (x, y) => Math.hypot(x - obj.x, y - obj.y) > 0.45)) return null;
    if (k > 0) {
      const t = rnd(0.35, 0.65), off = rnd(-0.6, 0.6) * R;
      const dx = obj.x - cue.x, dy = obj.y - cue.y, d = Math.hypot(dx, dy);
      const x = cue.x + dx * t - (dy / d) * off, y = cue.y + dy * t + (dx / d) * off;
      if (!ok(x, y)) return null;
      Object.assign(balls[8], { x, y, on: true });
    }
    return balls;
  }

  global.Bank = {
    randomLayout, attempt, RAILS, railOf, diamondOf, fromCorner, aimDiamond, reflect, trial, solver, mirror, DIAMOND_X, DIAMOND_Y };
})(typeof window !== 'undefined' ? window : globalThis);
