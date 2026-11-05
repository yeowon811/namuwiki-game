// 대기실 3D 광장 (three.js)
// - 각자 고른 색의 몸통 + 동물 얼굴 캐릭터
// - 방향키 / WASD / 바닥 클릭 / 화면 방향 버튼으로 이동
// - 이름표와 말풍선은 HTML로 캐릭터 머리 위에 띄움
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const W = 12; // 광장 가로 (x 0~1 ↔ -6~6)
const D = 7.5; // 광장 세로 (y 0~1 ↔ -3.75~3.75)
const CHAR_SCALE = 1.25; // 캐릭터 크기
const MIN = 0.05;
const MAX = 0.95;
const SPEED = 3.6; // 초당 이동 거리
const SEND_MS = 150; // 내 위치를 서버에 보내는 간격

const toWorld = (x, y) => new THREE.Vector3((x - 0.5) * W, 0, (y - 0.5) * D);
const toUnit = (v) => ({
  x: Math.round(Math.min(MAX, Math.max(MIN, v.x / W + 0.5)) * 1000) / 1000,
  y: Math.round(Math.min(MAX, Math.max(MIN, v.z / D + 0.5)) * 1000) / 1000,
});
const clampWorld = (v) => {
  v.x = Math.min((MAX - 0.5) * W, Math.max((MIN - 0.5) * W, v.x));
  v.z = Math.min((MAX - 0.5) * D, Math.max((MIN - 0.5) * D, v.z));
  return v;
};

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// 이모지를 그린 텍스처 (캐릭터 얼굴)
const faceCache = new Map();
function faceTexture(emoji) {
  if (faceCache.has(emoji)) return faceCache.get(emoji);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = '100px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, 64, 72);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  faceCache.set(emoji, tex);
  return tex;
}

function makeCharacter(emoji, color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.42, 6, 16), mat);
  body.position.y = 0.72;
  body.castShadow = true;
  g.add(body);
  // 배 부분 (앞쪽 표시)
  const belly = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }),
  );
  belly.scale.set(1, 1.2, 0.5);
  belly.position.set(0, 0.68, 0.24);
  g.add(belly);
  const footMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.6), roughness: 0.7 });
  const feet = [-0.15, 0.15].map((x) => {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), footMat);
    f.scale.set(1, 0.6, 1.4);
    f.position.set(x, 0.1, 0.04);
    f.castShadow = true;
    g.add(f);
    return f;
  });
  // 얼굴: 항상 카메라를 보는 이모지
  const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: faceTexture(emoji), transparent: true }));
  head.scale.set(1.05, 1.05, 1);
  head.position.y = 1.55;
  g.add(head);
  g.scale.setScalar(CHAR_SCALE);
  return { group: g, body, belly, feet, head, mat, footMat };
}

export function createPlaza3D(container, { onMove }) {
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'pz3';
  container.appendChild(canvasWrap);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  canvasWrap.appendChild(renderer.domElement);

  const labels = document.createElement('div');
  labels.className = 'pz3-labels';
  canvasWrap.appendChild(labels);

  // 휴대폰용 방향 버튼
  const pad = document.createElement('div');
  pad.className = 'pz3-pad';
  pad.innerHTML = ['up', 'left', 'down', 'right']
    .map((d) => `<button type="button" data-dir="${d}" aria-label="${{ up: '위', left: '왼쪽', down: '아래', right: '오른쪽' }[d]}로 이동">${{ up: '▲', left: '◀', down: '▼', right: '▶' }[d]}</button>`)
    .join('');
  canvasWrap.appendChild(pad);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 100);
  camera.position.set(0, 12.5, 13.5);
  camera.lookAt(0, 0, 0.6);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-6, 14, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 7, bottom: -7 });
  scene.add(sun);

  // ---- 광장 ----
  const groundMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  const ground = new THREE.Mesh(new THREE.BoxGeometry(W + 1.6, 0.4, D + 1.6), groundMat);
  ground.position.y = -0.2;
  ground.receiveShadow = true;
  scene.add(ground);
  // 바닥 타일 무늬
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = tileCanvas.height = 64;
  const tileTex = new THREE.CanvasTexture(tileCanvas);
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
  tileTex.repeat.set((W + 1.6) / 1.6, (D + 1.6) / 1.6);
  const tiles = new THREE.Mesh(new THREE.PlaneGeometry(W + 1.6, D + 1.6), new THREE.MeshStandardMaterial({ map: tileTex, transparent: true, roughness: 1 }));
  tiles.rotation.x = -Math.PI / 2;
  tiles.position.y = 0.001;
  tiles.receiveShadow = true;
  scene.add(tiles);

  const decor = new THREE.Group();
  scene.add(decor);
  const treeSpots = [[-6.5, -4.3], [6.5, -4.3], [-6.5, 4.2], [6.5, 4.2], [-3, -4.4], [3, -4.4]];
  for (const [x, z] of treeSpots) {
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0x8d6e63 }));
    trunk.position.y = 0.35;
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.65, 1.5, 10), new THREE.MeshStandardMaterial({ color: 0x52c41a, roughness: 0.8 }));
    leaf.position.y = 1.35;
    trunk.castShadow = leaf.castShadow = true;
    t.add(trunk, leaf);
    t.position.set(x, 0, z);
    decor.add(t);
  }
  // 뒤쪽 가운데 깃발 (나무위키 레이스 표시)
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0xbfbfbf, metalness: 0.4 }));
  pole.position.set(0, 1.3, -4.5);
  pole.castShadow = true;
  const flagMat = new THREE.MeshStandardMaterial({ color: 0x1677ff, side: THREE.DoubleSide });
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.65, 8, 1), flagMat);
  flag.position.set(0.58, 2.2, -4.5);
  flag.castShadow = true;
  decor.add(pole, flag);
  const flagBase = flag.geometry.attributes.position.array.slice();

  function applyTheme() {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light'
      || document.documentElement.dataset.theme === 'dark';
    groundMat.color.set(dark ? 0x26313f : 0xe6f4ff);
    const g = tileCanvas.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = dark ? 'rgba(255,255,255,.07)' : 'rgba(22,119,255,.12)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, 62, 62);
    tileTex.needsUpdate = true;
    flagMat.color.set(css('--color-primary', '#1677ff'));
  }
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

  // ---- 캐릭터 ----
  const chars = new Map(); // id → { ...mesh, pos(Vector3), target, label, bubble, emoji, color }
  let myId = null;
  const myRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 32), new THREE.MeshBasicMaterial({ color: css('--color-primary', '#1677ff'), transparent: true, opacity: 0.85 }));
  myRing.rotation.x = -Math.PI / 2;
  myRing.position.y = 0.02;

  function ensureChar(p) {
    let c = chars.get(p.id);
    if (c && (c.emoji !== p.e || c.color !== p.c)) {
      scene.remove(c.group);
      c.label.remove();
      chars.delete(p.id);
      c = null;
    }
    if (!c) {
      const made = makeCharacter(p.e, p.c);
      const pos = toWorld(p.x, p.y);
      made.group.position.copy(pos);
      scene.add(made.group);
      const label = document.createElement('div');
      label.className = 'pz3-label';
      label.innerHTML = '<div class="bubble"></div><div class="nm"></div>';
      labels.appendChild(label);
      c = { ...made, pos, target: pos.clone(), label, emoji: p.e, color: p.c, walkT: 0, moving: false };
      chars.set(p.id, c);
    }
    return c;
  }

  // ---- 입력 ----
  const keys = new Set();
  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  let clickTarget = null;
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const active = () => !paused && container.offsetParent !== null;
  function onKeyDown(e) {
    const dir = KEYMAP[e.code];
    if (!dir || !active() || typing(document.activeElement) || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault(); // 방향키로 페이지가 스크롤되지 않게
    keys.add(dir);
    clickTarget = null;
  }
  function onKeyUp(e) {
    const dir = KEYMAP[e.code];
    if (dir) keys.delete(dir);
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => keys.clear());

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
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  renderer.domElement.addEventListener('pointerdown', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(plane, hit)) clickTarget = clampWorld(hit);
  });
  renderer.domElement.addEventListener('click', (e) => e.stopPropagation());

  // ---- 크기 ----
  function resize() {
    const w = canvasWrap.clientWidth || 1;
    const h = canvasWrap.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // 광장 전체(앞쪽 모서리까지)가 화면에 들어오도록 카메라 거리 조절
    camera.updateProjectionMatrix();
    let dist = 8;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 40; i++) {
      camera.position.set(0, dist * 0.85, dist);
      camera.lookAt(0, 0, 0.4);
      camera.updateMatrixWorld();
      let fits = true;
      for (const [x, z] of [[-(W / 2 + 0.8), D / 2 + 0.8], [W / 2 + 0.8, D / 2 + 0.8], [-(W / 2 + 0.8), -(D / 2 + 0.8)], [W / 2 + 0.8, -(D / 2 + 0.8)]]) {
        corner.set(x, 0, z).project(camera);
        if (Math.abs(corner.x) > 0.98 || Math.abs(corner.y) > 0.92) fits = false;
      }
      if (fits) break;
      dist += 0.5;
    }
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvasWrap);
  resize();

  // ---- 루프 ----
  let paused = false;
  let last = performance.now();
  let lastSent = 0;
  let pendingSend = false;
  const tmp = new THREE.Vector3();
  const proj = new THREE.Vector3();

  function step(t) {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    const me = chars.get(myId);
    if (me) {
      const v = new THREE.Vector3(
        (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0), 0,
        (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0),
      );
      if (v.lengthSq() === 0 && clickTarget) {
        v.subVectors(clickTarget, me.pos).setY(0);
        if (v.length() < 0.05) { clickTarget = null; v.set(0, 0, 0); }
      }
      if (v.lengthSq() > 0) {
        const dist = Math.min(SPEED * dt, clickTarget && !keys.size ? v.length() : Infinity);
        v.normalize();
        me.pos.addScaledVector(v, dist);
        clampWorld(me.pos);
        me.target.copy(me.pos);
        me.group.rotation.y = Math.atan2(v.x, v.z);
        me.moving = true;
        pendingSend = true;
      } else {
        me.moving = false;
      }
      if (pendingSend && (t - lastSent > SEND_MS || !me.moving)) {
        lastSent = t;
        pendingSend = false;
        const u = toUnit(me.pos);
        onMove(u.x, u.y);
      }
    }
    for (const [id, c] of chars) {
      if (id !== myId) {
        tmp.subVectors(c.target, c.pos).setY(0);
        const d = tmp.length();
        if (d > 0.02) {
          // 다른 사람은 받은 위치로 부드럽게 걸어감 (멀리 떨어지면 빠르게 따라잡음)
          const move = Math.min(d, Math.max(SPEED, d * 3) * dt);
          c.pos.addScaledVector(tmp.normalize(), move);
          c.group.rotation.y = Math.atan2(tmp.x, tmp.z);
          c.moving = true;
        } else {
          c.moving = false;
        }
      }
      // 걷는 동작: 몸이 통통 튀고 발이 번갈아 나감
      c.walkT = c.moving ? c.walkT + dt * 10 : 0;
      const bob = c.moving ? Math.abs(Math.sin(c.walkT)) * 0.12 : 0;
      c.group.position.set(c.pos.x, bob, c.pos.z);
      c.feet[0].position.z = 0.04 + (c.moving ? Math.sin(c.walkT) * 0.16 : 0);
      c.feet[1].position.z = 0.04 - (c.moving ? Math.sin(c.walkT) * 0.16 : 0);
      c.feet[0].position.y = 0.1 - bob;
      c.feet[1].position.y = 0.1 - bob;
    }
    if (me) myRing.position.set(me.pos.x, 0.02, me.pos.z);

    // 깃발 펄럭임
    const arr = flag.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = flagBase[i] + 0.55;
      arr[i + 2] = flagBase[i + 2] + Math.sin(t / 250 + x * 4) * 0.07 * x;
    }
    flag.geometry.attributes.position.needsUpdate = true;

    renderer.render(scene, camera);

    // 이름표·말풍선 위치
    const w = canvasWrap.clientWidth;
    const h = canvasWrap.clientHeight;
    for (const c of chars.values()) {
      proj.set(c.group.position.x, c.group.position.y + 2.15 * CHAR_SCALE, c.group.position.z).project(camera);
      c.label.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px)`;
      c.label.style.zIndex = String(1000 + Math.round(c.pos.z * 10));
    }
  }
  renderer.setAnimationLoop(step);

  return {
    // players: [{ id, name, e, c, x, y, online, me }]
    update(players) {
      const keep = new Set();
      for (const p of players) {
        keep.add(p.id);
        const c = ensureChar(p);
        if (p.me) {
          if (myId !== p.id) {
            myId = p.id;
            scene.add(myRing);
          }
        } else {
          c.target.copy(toWorld(p.x, p.y));
        }
        c.label.classList.toggle('me', !!p.me);
        c.label.classList.toggle('off', !p.online);
        c.mat.transparent = c.footMat.transparent = !p.online;
        c.mat.opacity = c.footMat.opacity = p.online ? 1 : 0.45;
        c.label.querySelector('.nm').textContent = p.name;
      }
      for (const [id, c] of chars) {
        if (keep.has(id)) continue;
        scene.remove(c.group);
        c.label.remove();
        chars.delete(id);
      }
    },
    setBubbles(map) {
      for (const [id, c] of chars) {
        const text = map.get(id) || '';
        const b = c.label.querySelector('.bubble');
        if (b.textContent !== text) b.textContent = text;
      }
    },
    pause() {
      if (paused) return;
      paused = true;
      keys.clear();
      renderer.setAnimationLoop(null);
    },
    resume() {
      if (!paused) return;
      paused = false;
      last = performance.now();
      renderer.setAnimationLoop(step);
    },
  };
}
