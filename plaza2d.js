// 대기실 2D 광장
// - 배경 그림(img/lobby.webp) 위를 동물 캐릭터가 걸어다님
// - 걷는 방향에 따라 앞·옆·뒷모습으로 바뀜, 뒤쪽(위)으로 갈수록 작게 보임
// - 방향키 / WASD / 바닥 클릭 / 화면 방향 버튼으로 이동, Shift 달리기, Space 점프
// 위치(x, y)는 배경 그림 기준 0~1 (y = 발 위치)
import { animalImg, lookAccHtml, VIEWS, walkFrames } from './animals.js?v=11';

// 걸을 수 있는 바닥 (배경 그림의 타일 광장, 타원)
const FLOOR = { cx: 0.5, cy: 0.635, rx: 0.38, ry: 0.245 };
const SPEED = 0.2; // 초당 이동 거리 (광장 가로 대비, 걷기)
const RUN_SPEED = 0.38; // 달리기
const JUMP_MS = 600;
const JUMP_H = 0.11; // 점프 높이 (광장 세로 대비)
const SEND_MS = 150; // 내 위치를 서버에 보내는 간격
const CHAR_H = 0.21; // 캐릭터 키 (광장 세로 대비, 맨 앞 기준)
const STEP_MS = 190; // 걸을 때 옆모습 그림 두 장을 번갈아 보여주는 간격 (달리면 더 빠르게)

export function clampFloor(x, y) {
  const u = (x - FLOOR.cx) / FLOOR.rx;
  const v = (y - FLOOR.cy) / FLOOR.ry;
  const d = Math.hypot(u, v);
  if (d <= 1) return { x, y };
  return { x: FLOOR.cx + (u / d) * FLOOR.rx, y: FLOOR.cy + (v / d) * FLOOR.ry };
}
const round3 = (v) => Math.round(v * 1000) / 1000;
// 뒤쪽일수록 작게 (원근감)
const depthScale = (y) => 0.72 + 0.38 * Math.min(1, Math.max(0, (y - (FLOOR.cy - FLOOR.ry)) / (2 * FLOOR.ry)));

export function createPlaza(container, { onMove, onJump }) {
  const stage = document.createElement('div');
  stage.className = 'pz2';
  container.appendChild(stage);
  const layer = document.createElement('div');
  layer.className = 'pz2-layer';
  stage.appendChild(layer);

  // 휴대폰용 방향 버튼
  const pad = document.createElement('div');
  pad.className = 'pz3-pad';
  pad.innerHTML = ['up', 'left', 'down', 'right']
    .map((d) => `<button type="button" data-dir="${d}" aria-label="${{ up: '위', left: '왼쪽', down: '아래', right: '오른쪽' }[d]}로 이동">${{ up: '▲', left: '◀', down: '▼', right: '▶' }[d]}</button>`)
    .join('');
  stage.appendChild(pad);
  const acts = document.createElement('div');
  acts.className = 'pz3-acts';
  acts.innerHTML = '<button type="button" data-act="run" aria-pressed="false">달리기</button><button type="button" data-act="jump">점프</button>';
  stage.appendChild(acts);

  let W = 1;
  let H = 1;
  const ro = new ResizeObserver(() => { W = stage.clientWidth || 1; H = stage.clientHeight || 1; });
  ro.observe(stage);
  W = stage.clientWidth || 1;
  H = stage.clientHeight || 1;

  // ---- 캐릭터 ----
  const chars = new Map();
  let myId = null;

  const lookOf = (p) => ({ a: p.a, head: p.head, eyes: p.eyes, neck: p.neck, body: p.body, feet: p.feet, back: p.back });

  function ensureChar(p) {
    let c = chars.get(p.id);
    if (c) {
      if (c.animal !== p.a) for (const v of VIEWS) new Image().src = animalImg(p.a, v);
      c.animal = p.a;
      c.look = lookOf(p);
      return c;
    }
    const node = document.createElement('div');
    node.className = 'pz2-ch';
    node.innerHTML = '<div class="shadow"></div><div class="fig"><div class="inner charfig"><img alt="" draggable="false"><div class="accs"></div></div></div>'
      + '<div class="label"><div class="bubble"></div><div class="nm"></div></div>';
    layer.appendChild(node);
    for (const v of VIEWS) new Image().src = animalImg(p.a, v);
    const pos = clampFloor(p.x, p.y);
    c = {
      node, img: node.querySelector('img'), fig: node.querySelector('.fig'), inner: node.querySelector('.inner'),
      acc: node.querySelector('.accs'), accKey: '', label: node.querySelector('.label'),
      animal: p.a, look: lookOf(p), pos: { ...pos }, target: { ...pos }, facing: 'front', view: null,
      moving: false, running: false, walkT: 0, stepT: 0, step: 0, frame: 0, jumpStart: -1e9, jumpAt: null, dustT: 0,
    };
    chars.set(p.id, c);
    return c;
  }

  // 바라보는 방향 → 그림. 옆으로 걸을 땐 두 장(1, 2)을 번갈아 보여줌
  function setView(c, dt) {
    let view;
    if (c.facing === 'left' || c.facing === 'right') {
      const frames = walkFrames(c.animal);
      if (c.moving) {
        c.stepT += dt * 1000;
        if (c.stepT > (c.running ? STEP_MS * 0.6 : STEP_MS)) { c.stepT = 0; c.step = (c.step + 1) % frames.length; }
        c.frame = frames[c.step % frames.length];
      } else { c.frame = 0; c.step = 0; }
      view = `${c.facing}${c.frame + 1}`;
    } else view = c.facing === 'up' ? 'back' : 'front';
    const key = `${c.animal}/${view}`;
    if (c.view !== key) {
      c.view = key;
      c.img.src = animalImg(c.animal, view);
    }
    const accKey = `${view}/${JSON.stringify(c.look)}`;
    if (c.accKey !== accKey) {
      c.accKey = accKey;
      c.acc.innerHTML = lookAccHtml(c.look, view);
    }
  }
  function faceToward(c, dxPx, dyPx) {
    if (Math.abs(dxPx) < 0.01 && Math.abs(dyPx) < 0.01) return;
    if (Math.abs(dxPx) >= Math.abs(dyPx) * 0.9) c.facing = dxPx > 0 ? 'right' : 'left';
    else c.facing = dyPx > 0 ? 'down' : 'up';
  }

  // ---- 입력 ----
  const keys = new Set();
  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  let clickTarget = null;
  let runToggle = false; // 휴대폰 '달리기' 버튼
  let paused = false;
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const active = () => !paused && container.offsetParent !== null;
  function onKeyDown(e) {
    if (!active() || typing(document.activeElement) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { keys.add('run'); return; }
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) jump(); return; }
    const dir = KEYMAP[e.code];
    if (!dir) return;
    e.preventDefault(); // 방향키로 페이지가 스크롤되지 않게
    keys.add(dir);
    clickTarget = null;
  }
  function onKeyUp(e) {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.delete('run');
    const dir = KEYMAP[e.code];
    if (dir) keys.delete(dir);
  }
  const moveKeys = () => ['up', 'down', 'left', 'right'].some((k) => keys.has(k));
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => keys.clear());

  function jump() {
    const me = chars.get(myId);
    if (!me || performance.now() - me.jumpStart < JUMP_MS) return;
    me.jumpStart = performance.now();
    onJump?.();
  }
  for (const b of acts.querySelectorAll('button')) {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.act === 'jump') jump();
      else { runToggle = !runToggle; b.setAttribute('aria-pressed', String(runToggle)); }
    });
    b.addEventListener('click', (e) => e.stopPropagation());
  }
  for (const b of pad.querySelectorAll('button')) {
    const dir = b.dataset.dir;
    const on = (e) => { e.preventDefault(); e.stopPropagation(); keys.add(dir); clickTarget = null; };
    const off = (e) => { e.stopPropagation(); keys.delete(dir); };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointerleave', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('click', (e) => e.stopPropagation());
  }
  // 바닥을 누르면 그 자리로 걸어감
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = stage.getBoundingClientRect();
    clickTarget = clampFloor((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
  stage.addEventListener('click', (e) => e.stopPropagation());

  // ---- 달리기 먼지 ----
  function puff(c) {
    const d = document.createElement('div');
    d.className = 'pz2-dust';
    d.style.transform = `translate(${c.pos.x * W + (Math.random() - 0.5) * 14}px, ${c.pos.y * H - 4}px)`;
    d.style.zIndex = String(Math.round(c.pos.y * 1000) - 1);
    layer.appendChild(d);
    d.addEventListener('animationend', () => d.remove());
  }

  // ---- 루프 ----
  let last = performance.now();
  let lastSent = 0;
  let pendingSend = false;
  let raf = 0;

  function step(t) {
    raf = requestAnimationFrame(step);
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    const me = chars.get(myId);
    if (me) {
      // 이동 방향 (화면 픽셀 기준으로 계산해서 가로·세로 속도를 같게)
      let vx = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
      let vy = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
      let remain = Infinity;
      if (!vx && !vy && clickTarget) {
        vx = (clickTarget.x - me.pos.x) * W;
        vy = (clickTarget.y - me.pos.y) * H;
        remain = Math.hypot(vx, vy);
        if (remain < 2) { clickTarget = null; vx = vy = 0; }
      }
      if (vx || vy) {
        me.running = keys.has('run') || runToggle;
        const len = Math.hypot(vx, vy);
        const dist = Math.min((me.running ? RUN_SPEED : SPEED) * W * dt, clickTarget && !moveKeys() ? remain : Infinity);
        const nx = me.pos.x + (vx / len) * dist / W;
        const ny = me.pos.y + (vy / len) * dist / H;
        const cl = clampFloor(nx, ny);
        me.pos.x = cl.x;
        me.pos.y = cl.y;
        faceToward(me, vx, vy);
        me.moving = true;
        pendingSend = true;
      } else {
        me.moving = false;
        me.running = false;
      }
      if (pendingSend && (t - lastSent > SEND_MS || !me.moving)) {
        lastSent = t;
        pendingSend = false;
        onMove(round3(me.pos.x), round3(me.pos.y), me.moving && me.running);
      }
    }
    for (const [id, c] of chars) {
      if (id !== myId) {
        const dx = (c.target.x - c.pos.x) * W;
        const dy = (c.target.y - c.pos.y) * H;
        const d = Math.hypot(dx, dy);
        if (d > 1) {
          // 다른 사람은 받은 위치로 부드럽게 걸어감 (멀리 떨어지면 빠르게 따라잡음)
          const move = Math.min(d, Math.max((c.running ? RUN_SPEED : SPEED) * W, d * 3) * dt);
          c.pos.x += (dx / d) * move / W;
          c.pos.y += (dy / d) * move / H;
          faceToward(c, dx, dy);
          c.moving = true;
        } else {
          c.moving = false;
        }
      }
      setView(c, dt);
      const run = c.moving && c.running;
      c.walkT = c.moving ? c.walkT + dt * (run ? 17 : 11) : 0;
      const s = depthScale(c.pos.y);
      const h = CHAR_H * H * s;
      const bob = c.moving ? Math.abs(Math.sin(c.walkT)) * h * (run ? 0.09 : 0.06) : 0;
      const tilt = c.moving ? Math.sin(c.walkT) * (run ? 6 : 4) : 0;
      const jp = (t - c.jumpStart) / JUMP_MS;
      const jumpY = jp >= 0 && jp < 1 ? Math.sin(jp * Math.PI) * JUMP_H * H : 0;
      c.node.style.transform = `translate(${c.pos.x * W}px, ${c.pos.y * H}px)`;
      c.node.style.zIndex = String(Math.round(c.pos.y * 1000));
      c.fig.style.height = `${h}px`;
      c.fig.style.fontSize = `${h}px`; // 액세서리 크기·위치는 em (= 캐릭터 키) 기준
      c.fig.style.transform = `translate(-50%, ${-(bob + jumpY)}px) rotate(${tilt}deg)`;
      c.label.style.transform = `translate(-50%, ${-(h + bob + jumpY + 4)}px)`;
      const sh = jumpY ? Math.max(0.45, 1 - jumpY / (JUMP_H * H)) : 1;
      c.node.querySelector('.shadow').style.transform = `translate(-50%, -50%) scale(${s * sh})`;
      if (run && !jumpY && (c.dustT += dt) > 0.1) { c.dustT = 0; puff(c); }
    }
  }
  raf = requestAnimationFrame(step);

  return {
    // players: [{ id, name, a, head, eyes, neck, body, feet, back, x, y, run, jumpAt, jumpAgo, online, me }]
    update(players) {
      const keep = new Set();
      for (const p of players) {
        keep.add(p.id);
        const c = ensureChar(p);
        if (p.me) myId = p.id;
        else {
          c.target = clampFloor(p.x, p.y);
          c.running = !!p.run;
          // 다른 사람이 점프하면 (1초 안에 일어난 점프만) 따라서 뜀
          if (p.jumpAt && p.jumpAt !== c.jumpAt) {
            if (p.jumpAgo < 1000) c.jumpStart = performance.now() - Math.max(0, p.jumpAgo);
            c.jumpAt = p.jumpAt;
          }
        }
        c.node.classList.toggle('me', !!p.me);
        c.node.classList.toggle('off', !p.online);
        const nm = c.node.querySelector('.nm');
        if (nm.textContent !== p.name) nm.textContent = p.name;
        c.img.alt = p.name;
      }
      for (const [id, c] of chars) {
        if (keep.has(id)) continue;
        c.node.remove();
        chars.delete(id);
      }
    },
    setBubbles(map) {
      for (const [id, c] of chars) {
        const text = map.get(id) || '';
        const b = c.node.querySelector('.bubble');
        if (b.textContent !== text) b.textContent = text;
      }
    },
    pause() {
      if (paused) return;
      paused = true;
      keys.clear();
      runToggle = false;
      acts.querySelector('[data-act="run"]').setAttribute('aria-pressed', 'false');
      cancelAnimationFrame(raf);
    },
    resume() {
      if (!paused) return;
      paused = false;
      last = performance.now();
      raf = requestAnimationFrame(step);
    },
  };
}
