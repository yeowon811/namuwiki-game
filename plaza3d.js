// 대기실 3D 광장 (three.js)
// - 각자 고른 색의 캐릭터 + 액세서리(모자, 안경, 수염, 목 장식)
// - 방향키 / WASD / 바닥 클릭 / 화면 방향 버튼으로 이동
// - 이름표와 말풍선은 HTML로 캐릭터 머리 위에 띄움
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const W = 12; // 광장 가로 (x 0~1 ↔ -6~6)
const D = 7.5; // 광장 세로 (y 0~1 ↔ -3.75~3.75)
const CHAR_SCALE = 1.5; // 캐릭터 크기
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

// ---------- 캐릭터 ----------
const R = 0.38; // 머리 반지름
const HEAD_Y = 1.62; // 머리 중심 높이
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
const mesh = (geo, mat, [x = 0, y = 0, z = 0] = [], rot = null, scale = null) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (rot) m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  m.castShadow = true;
  return m;
};
const GOLD = () => std(0xfadb14, { metalness: 0.6, roughness: 0.3 });
const DARK = () => std(0x262626, { roughness: 0.4 });

function heartShape() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.08);
  s.bezierCurveTo(-0.13, 0.0, -0.1, 0.11, 0, 0.05);
  s.bezierCurveTo(0.1, 0.11, 0.13, 0.0, 0, -0.08);
  return s;
}

// 액세서리 모양 (머리 액세서리는 머리 중심 기준, 목 액세서리는 몸 기준 좌표)
const ACC_BUILDERS = {
  // ----- 머리 -----
  cap(g) {
    const red = std(0xf5222d);
    g.add(mesh(new THREE.SphereGeometry(R * 1.04, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), red, [0, 0.06, 0]));
    g.add(mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.03, 24), red, [0, 0.1, R * 0.85], [0.15, 0, 0], [1, 1, 0.75]));
    g.add(mesh(new THREE.SphereGeometry(0.04, 8, 6), red, [0, R * 1.08, 0]));
  },
  tophat(g) {
    const blk = DARK();
    g.add(mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.03, 32), blk, [0, R * 0.78, 0]));
    g.add(mesh(new THREE.CylinderGeometry(0.29, 0.31, 0.46, 32), blk, [0, R * 0.78 + 0.24, 0]));
    g.add(mesh(new THREE.CylinderGeometry(0.315, 0.315, 0.07, 32), std(0xcf1322), [0, R * 0.78 + 0.06, 0]));
  },
  crown(g) {
    const gold = GOLD();
    const y = R * 0.82;
    g.add(mesh(new THREE.CylinderGeometry(0.3, 0.28, 0.14, 24, 1, true), Object.assign(gold, { side: THREE.DoubleSide }), [0, y, 0]));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.add(mesh(new THREE.ConeGeometry(0.06, 0.16, 8), gold, [Math.sin(a) * 0.28, y + 0.14, Math.cos(a) * 0.28]));
      g.add(mesh(new THREE.SphereGeometry(0.035, 8, 6), std(i % 2 ? 0x1677ff : 0xf5222d, { roughness: 0.2 }), [Math.sin(a) * 0.3, y, Math.cos(a) * 0.3]));
    }
  },
  party(g) {
    g.add(mesh(new THREE.ConeGeometry(0.2, 0.55, 20), std(0xeb2f96), [0.06, R + 0.22, 0], [0, 0, -0.18]));
    g.add(mesh(new THREE.TorusGeometry(0.16, 0.025, 8, 20), std(0xfadb14), [0.04, R + 0.08, 0], [Math.PI / 2, 0, -0.18]));
    g.add(mesh(new THREE.SphereGeometry(0.07, 10, 8), std(0xfadb14), [0.16, R + 0.5, 0]));
  },
  straw(g) {
    const straw = std(0xe8c36b, { roughness: 0.9 });
    g.add(mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.025, 32), straw, [0, R * 0.62, 0]));
    g.add(mesh(new THREE.SphereGeometry(0.33, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), straw, [0, R * 0.62, 0], null, [1, 0.85, 1]));
    g.add(mesh(new THREE.CylinderGeometry(0.335, 0.335, 0.06, 32), std(0xf5222d), [0, R * 0.62 + 0.04, 0]));
  },
  beanie(g) {
    const blue = std(0x2f54eb, { roughness: 0.9 });
    g.add(mesh(new THREE.SphereGeometry(R * 1.06, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), blue, [0, 0.04, 0]));
    g.add(mesh(new THREE.TorusGeometry(R * 1.02, 0.05, 10, 32), std(0x597ef7, { roughness: 0.9 }), [0, 0.06, 0], [Math.PI / 2, 0, 0]));
    g.add(mesh(new THREE.SphereGeometry(0.09, 10, 8), std(0xffffff, { roughness: 1 }), [0, R * 1.12, 0]));
  },
  ribbon(g) {
    const pink = std(0xff85c0);
    g.add(mesh(new THREE.TorusGeometry(R * 1.03, 0.03, 8, 32, Math.PI), pink, [0, 0.02, -0.05], [0, 0, 0]));
    const bow = new THREE.Group();
    bow.add(mesh(new THREE.ConeGeometry(0.09, 0.16, 12), pink, [-0.08, 0, 0], [0, 0, -Math.PI / 2]));
    bow.add(mesh(new THREE.ConeGeometry(0.09, 0.16, 12), pink, [0.08, 0, 0], [0, 0, Math.PI / 2]));
    bow.add(mesh(new THREE.SphereGeometry(0.045, 8, 6), std(0xeb2f96), [0, 0, 0]));
    bow.position.set(0.2, R * 0.9, 0.02);
    bow.rotation.z = -0.5;
    g.add(bow);
  },
  bunny(g) {
    const white = std(0xffffff);
    const pinkIn = std(0xffadd2);
    g.add(mesh(new THREE.TorusGeometry(R * 1.03, 0.03, 8, 32, Math.PI), std(0x434343), [0, 0.02, -0.05]));
    for (const s of [-1, 1]) {
      const ear = new THREE.Group();
      ear.add(mesh(new THREE.CapsuleGeometry(0.07, 0.32, 4, 10), white));
      ear.add(mesh(new THREE.CapsuleGeometry(0.035, 0.26, 4, 8), pinkIn, [0, 0, 0.045]));
      ear.position.set(s * 0.15, R + 0.22, -0.02);
      ear.rotation.z = -s * 0.25;
      g.add(ear);
    }
  },
  // ----- 눈 -----
  glasses(g) {
    const frame = DARK();
    for (const s of [-1, 1]) g.add(mesh(new THREE.TorusGeometry(0.095, 0.018, 8, 24), frame, [s * 0.13, 0.04, R * 0.95]));
    g.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.07, 6), frame, [0, 0.06, R * 0.98], [0, 0, Math.PI / 2]));
  },
  sunglasses(g) {
    const lens = std(0x141414, { roughness: 0.15, metalness: 0.3 });
    for (const s of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.11, 0.1, 0.03, 20), lens, [s * 0.13, 0.04, R * 0.96], [Math.PI / 2, 0, 0], [1.15, 1, 0.9]));
    g.add(mesh(new THREE.BoxGeometry(0.1, 0.025, 0.025), lens, [0, 0.07, R * 0.99]));
  },
  heart(g) {
    const red = std(0xff4d4f, { roughness: 0.25 });
    const geo = new THREE.ExtrudeGeometry(heartShape(), { depth: 0.03, bevelEnabled: false });
    for (const s of [-1, 1]) g.add(mesh(geo, red, [s * 0.13, 0.05, R * 0.94], null, [1.2, 1.2, 1]));
    g.add(mesh(new THREE.BoxGeometry(0.08, 0.02, 0.02), red, [0, 0.07, R * 0.99]));
  },
  monocle(g) {
    const gold = GOLD();
    g.add(mesh(new THREE.TorusGeometry(0.1, 0.018, 8, 24), gold, [0.13, 0.04, R * 0.96]));
    g.add(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.4, 4), gold, [0.2, -0.15, R * 0.85], [0.2, 0, 0.35]));
  },
  // ----- 얼굴 -----
  mustache(g) {
    const brown = std(0x5c3317, { roughness: 0.9 });
    for (const s of [-1, 1]) g.add(mesh(new THREE.SphereGeometry(0.07, 12, 8), brown, [s * 0.07, -0.08, R * 0.96], [0, 0, s * 0.35], [1.6, 0.6, 0.6]));
  },
  beard(g) {
    const brown = std(0x6b3e1f, { roughness: 1 });
    g.add(mesh(new THREE.SphereGeometry(R * 1.02, 24, 12, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.52, Math.PI * 0.4), brown, [0, 0, 0.02], null, [1, 1.05, 1.08]));
  },
  blush(g) {
    const pink = std(0xff85c0, { roughness: 1, transparent: true, opacity: 0.85 });
    for (const s of [-1, 1]) g.add(mesh(new THREE.SphereGeometry(0.06, 12, 8), pink, [s * 0.22, -0.06, R * 0.82], null, [1.2, 0.7, 0.3]));
  },
  mask(g) {
    const white = std(0xf5f5f5, { roughness: 0.9, side: THREE.DoubleSide });
    g.add(mesh(new THREE.SphereGeometry(R * 1.03, 24, 12, Math.PI * 0.2, Math.PI * 0.6, Math.PI * 0.5, Math.PI * 0.3), white));
  },
  // ----- 목 (몸 기준) -----
  bowtie(g) {
    const red = std(0xcf1322);
    for (const s of [-1, 1]) g.add(mesh(new THREE.ConeGeometry(0.08, 0.14, 12), red, [s * 0.075, 1.15, 0.27], [0, 0, s * Math.PI / 2]));
    g.add(mesh(new THREE.SphereGeometry(0.045, 8, 6), red, [0, 1.15, 0.29]));
  },
  scarf(g) {
    const red = std(0xfa541c, { roughness: 0.95 });
    g.add(mesh(new THREE.TorusGeometry(0.26, 0.07, 10, 28), red, [0, 1.2, 0], [Math.PI / 2, 0, 0]));
    g.add(mesh(new THREE.BoxGeometry(0.12, 0.34, 0.06), red, [0.12, 0.98, 0.29], [0.15, 0, 0.1]));
  },
  medal(g) {
    const blue = std(0x1677ff);
    for (const s of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.05, 0.3, 0.02), blue, [s * 0.07, 1.04, 0.3], [0.25, 0, s * 0.35]));
    g.add(mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.025, 20), GOLD(), [0, 0.88, 0.36], [Math.PI / 2 - 0.2, 0, 0]));
  },
  necklace(g) {
    g.add(mesh(new THREE.TorusGeometry(0.27, 0.02, 8, 32), GOLD(), [0, 1.13, 0.02], [Math.PI / 2 - 0.25, 0, 0]));
    g.add(mesh(new THREE.SphereGeometry(0.055, 12, 8), std(0x13c2c2, { roughness: 0.15 }), [0, 1.02, 0.29]));
  },
};
const HEAD_SLOTS = ['head', 'eyes', 'face'];

// 기본 캐릭터 (몸통 색 + 얼굴) 위에 액세서리를 얹음
function makeCharacter(color, acc) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.42, 6, 16), mat);
  body.position.y = 0.72;
  body.castShadow = true;
  g.add(body);
  // 배 부분 (앞쪽 표시)
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }));
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
  // 머리: 몸 색을 밝게 + 눈과 웃는 입
  const headGroup = new THREE.Group();
  headGroup.position.y = HEAD_Y;
  const headMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55), roughness: 0.6 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(R, 28, 20), headMat);
  head.castShadow = true;
  headGroup.add(head);
  const eyeMat = std(0x1f1f1f, { roughness: 0.3 });
  for (const s of [-1, 1]) headGroup.add(mesh(new THREE.SphereGeometry(0.045, 12, 8), eyeMat, [s * 0.13, 0.04, R * 0.92], null, [1, 1.25, 0.6]));
  headGroup.add(mesh(new THREE.TorusGeometry(0.07, 0.014, 6, 16, Math.PI), eyeMat, [0, -0.07, R * 0.93], [0, 0, Math.PI]));
  g.add(headGroup);
  // 액세서리
  for (const [slot, id] of Object.entries(acc || {})) {
    if (!id || !ACC_BUILDERS[id]) continue;
    ACC_BUILDERS[id](HEAD_SLOTS.includes(slot) ? headGroup : g);
  }
  g.scale.setScalar(CHAR_SCALE);
  const mats = [];
  g.traverse((o) => { if (o.material && !mats.includes(o.material)) mats.push(o.material); });
  return { group: g, body, belly, feet, head: headGroup, mats };
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
    const look = `${p.c}|${JSON.stringify(p.acc || {})}`;
    if (c && c.look !== look) {
      scene.remove(c.group);
      c.label.remove();
      chars.delete(p.id);
      c = null;
    }
    if (!c) {
      const made = makeCharacter(p.c, p.acc);
      const pos = toWorld(p.x, p.y);
      made.group.position.copy(pos);
      scene.add(made.group);
      const label = document.createElement('div');
      label.className = 'pz3-label';
      label.innerHTML = '<div class="bubble"></div><div class="nm"></div>';
      labels.appendChild(label);
      c = { ...made, pos, target: pos.clone(), label, look, walkT: 0, moving: false };
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
      proj.set(c.group.position.x, c.group.position.y + 2.55 * CHAR_SCALE, c.group.position.z).project(camera);
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
        for (const m of c.mats) {
          if (m.userData.baseOpacity == null) m.userData.baseOpacity = m.opacity;
          m.transparent = !p.online || m.userData.baseOpacity < 1;
          m.opacity = p.online ? m.userData.baseOpacity : 0.45;
        }
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
