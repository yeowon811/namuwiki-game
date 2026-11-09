// 캐릭터(동물)와 액세서리 목록 + 상점 가격 + 액세서리 위치
// 동물 그림: img/animals/{id}-{front|back|left1|left2|right1|right2|icon}.webp (키 360px로 맞춤)
// 액세서리 그림: img/acc/{id}.webp
// 목록(아이디)을 바꾸면 database.rules.json의 허용 목록도 같이 바꿔야 해요.
export const FREE_ANIMAL = 'cat'; // 처음부터 쓸 수 있는 캐릭터
export const ANIMAL_PRICE = 500;
export const ACC_PRICE = 300;

export const ANIMALS = [
  { id: 'cat', label: '고양이', emoji: '🐱' },
  { id: 'rabbit', label: '토끼', emoji: '🐰' },
  { id: 'penguin', label: '펭귄', emoji: '🐧' },
  { id: 'chick', label: '병아리', emoji: '🐥' },
  { id: 'panda', label: '판다', emoji: '🐼' },
  { id: 'dog', label: '강아지', emoji: '🐶' },
  { id: 'dinosaur', label: '공룡', emoji: '🦖' },
  { id: 'bear', label: '곰', emoji: '🐻' },
  { id: 'fox', label: '여우', emoji: '🦊' },
  { id: 'sheep', label: '양', emoji: '🐑' },
];

// 액세서리 부위: 부위마다 하나씩 착용
export const SLOTS = [
  { key: 'head', label: '모자' },
  { key: 'eyes', label: '안경' },
  { key: 'neck', label: '목' },
  { key: 'body', label: '옷' },
  { key: 'feet', label: '신발' },
  { key: 'back', label: '가방' },
];
// size: 그 부위 기본 크기 대비 배율 · ay: 기준점에 맞출 그림 속 높이(%)
// brow: 모자 아랫단을 머리 꼭대기와 눈 사이 어디에 둘지 (0 = 머리 꼭대기, 1 = 눈)
export const ACCESSORIES = [
  { id: 'crown', slot: 'head', label: '왕관', emoji: '👑', size: 0.72 },
  { id: 'beanie', slot: 'head', label: '비니', emoji: '🧶', size: 1.05, ay: 97, brow: 0.5 },
  { id: 'cap', slot: 'head', label: '야구 모자', emoji: '🧢', size: 1.15, ay: 95, brow: 0.4 },
  { id: 'beret', slot: 'head', label: '베레모', emoji: '🎨', size: 1.1, ay: 96, brow: 0.38 },
  { id: 'glasses', slot: 'eyes', label: '동그란 안경', emoji: '👓', size: 1 },
  { id: 'sunglasses', slot: 'eyes', label: '선글라스', emoji: '🕶️', size: 1 },
  { id: 'heartglasses', slot: 'eyes', label: '하트 안경', emoji: '😍', size: 1 },
  { id: 'bowtie', slot: 'neck', label: '나비넥타이', emoji: '🎀', size: 0.5 },
  { id: 'scarf', slot: 'neck', label: '목도리', emoji: '🧣', size: 0.85, ay: 14 },
  { id: 'hoodie', slot: 'body', label: '후드티', emoji: '👕', size: 1.5 },
  { id: 'raincoat', slot: 'body', label: '레인코트', emoji: '🧥', size: 1.45 },
  { id: 'overalls', slot: 'body', label: '멜빵바지', emoji: '👖', size: 1.05 },
  { id: 'dress', slot: 'body', label: '멜빵 원피스', emoji: '👗', size: 1.2 },
  { id: 'sneakers', slot: 'feet', label: '운동화', emoji: '👟', size: 1 },
  { id: 'boots', slot: 'feet', label: '장화', emoji: '🥾', size: 1 },
  { id: 'backpack', slot: 'back', label: '백팩', emoji: '🎒', size: 1 },
];

const BY_ID = new Map(ANIMALS.map((a) => [a.id, a]));
const ACC_BY_ID = new Map(ACCESSORIES.map((a) => [a.id, a]));
export const animalOf = (id) => BY_ID.get(id) || null;
export const accOf = (id) => ACC_BY_ID.get(id) || null;
export const ANIMAL_VER = 2; // 그림을 바꾸면 올려서 캐시를 새로 받게 함
export const animalImg = (id, view = 'front') => `img/animals/${id}-${view}.webp?v=${ANIMAL_VER}`;
export const accImg = (id) => `img/acc/${id}.webp?v=${ANIMAL_VER}`;
export const VIEWS = ['front', 'back', 'left1', 'left2', 'right1', 'right2'];

// 가진 것 확인 (profile = users/{uid})
export const ownsAnimal = (profile, id) => id === FREE_ANIMAL || profile?.owned?.animals?.[id] === true;
export const ownsAcc = (profile, id) => profile?.owned?.acc?.[id] === true;

// 저장된 모습에서 올바른 것만 남김 → { a, head, eyes, neck, body, feet, back } (액세서리 없으면 null)
// profile을 주면 가진 것만 남김
export function cleanLook(raw, profile = null) {
  const a = animalOf(raw?.a) && (!profile || ownsAnimal(profile, raw.a)) ? raw.a : FREE_ANIMAL;
  const out = { a };
  for (const s of SLOTS) {
    const it = accOf(raw?.[s.key]);
    out[s.key] = it && it.slot === s.key && (!profile || ownsAcc(profile, it.id)) ? it.id : null;
  }
  return out;
}
// 액세서리 한 개 그림 (상점·고르기 목록용)
export const accHtml = (it, cls = '') => `<img class="${cls}" src="${accImg(it.id)}" alt="${it.label}" draggable="false">`;

// ---------- 액세서리 위치 ----------
// 동물 그림(키 360px) 위의 기준점: [x(px), y(px), 폭(px)]
//   head: 모자 아랫단이 놓이는 머리 꼭대기 · eyes: 두 눈 가운데 · neck: 목 · body: 어깨(옷 윗단)
//   feet: 발바닥 가운데 · pack: 가방 가운데
// F = 앞모습(뒷모습은 좌우 반전해서 씀), S = 왼쪽을 보는 옆모습(오른쪽은 좌우 반전)
// fw / sw = 앞모습 / 옆모습 그림 폭(px)
const ANCHORS = {
  cat: { fw: 286, sw: 262,
    F: { head: [146, 46, 200], eyes: [148, 160, 175], neck: [146, 224, 150], body: [146, 214, 150], feet: [143, 357, 165], pack: [146, 270, 150] },
    S: { head: [112, 56, 185], eyes: [34, 155, 105], neck: [92, 222, 120], body: [102, 212, 128], feet: [100, 352, 150], pack: [178, 262, 150] } },
  rabbit: { fw: 220, sw: 220,
    F: { head: [110, 108, 165], eyes: [110, 184, 140], neck: [110, 256, 135], body: [110, 248, 140], feet: [110, 357, 145], pack: [110, 300, 135] },
    S: { head: [92, 112, 150], eyes: [26, 186, 105], neck: [80, 252, 110], body: [96, 244, 118], feet: [104, 352, 140], pack: [158, 292, 150] } },
  penguin: { fw: 260, sw: 261,
    F: { head: [130, 40, 180], eyes: [130, 152, 150], neck: [130, 222, 150], body: [130, 214, 175], feet: [130, 355, 175], pack: [130, 275, 155] },
    S: { head: [140, 42, 175], eyes: [48, 150, 105], neck: [104, 222, 120], body: [120, 214, 150], feet: [128, 352, 160], pack: [204, 268, 150] } },
  chick: { fw: 250, sw: 235,
    F: { head: [125, 48, 180], eyes: [128, 156, 150], neck: [126, 236, 160], body: [125, 228, 175], feet: [125, 355, 165], pack: [125, 285, 160] },
    S: { head: [124, 50, 175], eyes: [40, 150, 105], neck: [92, 234, 120], body: [112, 228, 148], feet: [112, 352, 150], pack: [186, 280, 150] } },
  panda: { fw: 269, sw: 253,
    F: { head: [134, 32, 200], eyes: [133, 147, 185], neck: [134, 226, 160], body: [134, 218, 165], feet: [134, 357, 175], pack: [134, 285, 160] },
    S: { head: [128, 36, 190], eyes: [42, 150, 105], neck: [100, 230, 120], body: [126, 222, 138], feet: [130, 352, 155], pack: [204, 282, 150] } },
  dog: { fw: 348, sw: 285,
    F: { head: [176, 22, 200], eyes: [176, 130, 170], neck: [176, 220, 150], body: [176, 214, 158], feet: [174, 357, 170], pack: [174, 282, 150] },
    S: { head: [132, 22, 200], eyes: [42, 132, 105], neck: [84, 228, 112], body: [106, 222, 125], feet: [112, 352, 150], pack: [190, 282, 150] } },
  dinosaur: { fw: 286, sw: 307,
    F: { head: [124, 46, 180], eyes: [128, 142, 140], neck: [126, 214, 150], body: [124, 208, 158], feet: [124, 357, 160], pack: [130, 275, 150] },
    S: { head: [112, 50, 175], eyes: [42, 136, 105], neck: [84, 220, 115], body: [110, 212, 135], feet: [112, 352, 150], pack: [186, 268, 150] } },
  bear: { fw: 255, sw: 246,
    F: { head: [128, 32, 200], eyes: [127, 136, 155], neck: [128, 216, 155], body: [128, 210, 165], feet: [128, 357, 170], pack: [128, 278, 155] },
    S: { head: [132, 36, 190], eyes: [46, 141, 105], neck: [102, 226, 118], body: [122, 218, 130], feet: [122, 352, 150], pack: [194, 276, 150] } },
  fox: { fw: 298, sw: 310,
    F: { head: [146, 52, 190], eyes: [140, 154, 165], neck: [142, 226, 150], body: [142, 220, 155], feet: [140, 355, 160], pack: [146, 286, 150] },
    S: { head: [116, 60, 180], eyes: [46, 158, 105], neck: [92, 230, 112], body: [120, 222, 125], feet: [122, 352, 155], pack: [190, 278, 150] } },
  sheep: { fw: 343, sw: 280,
    F: { head: [171, 24, 200], eyes: [170, 154, 160], neck: [171, 226, 165], body: [171, 220, 170], feet: [171, 357, 170], pack: [171, 290, 160] },
    S: { head: [140, 26, 200], eyes: [32, 154, 105], neck: [84, 232, 115], body: [116, 224, 140], feet: [110, 354, 150], pack: [200, 282, 150] } },
};
const H = 360;
// 부위별: 기준점에 액세서리 그림의 어느 점을 맞출지 (그림 크기 대비 %), 옆모습에서 가로로 줄이는 정도
const SLOT_FIT = {
  head: { ax: 50, ay: 80, side: 0.9 },
  eyes: { ax: 50, ay: 50, side: 1 },
  neck: { ax: 50, ay: 45, side: 0.8 },
  body: { ax: 50, ay: 10, side: 0.82 },
  feet: { ax: 50, ay: 88, side: 0.85 },
  back: { ax: 50, ay: 50, side: 0.5 },
};
const SLOT_ANCHOR = { head: 'head', eyes: 'eyes', neck: 'neck', body: 'body', feet: 'feet', back: 'pack' };
// 그리는 순서 (뒤에 있을수록 위)
const LAYERS = {
  front: ['feet', 'body', 'neck', 'eyes', 'head'],
  back: ['feet', 'body', 'neck', 'back', 'head'],
  side: ['feet', 'body', 'back', 'neck', 'eyes', 'head'],
};
export const viewKind = (view) => (view === 'front' || view === 'back' ? view : 'side');

// 액세서리 위치: { left(%), top(%), width(em = 캐릭터 키 대비), ax, ay, sx(가로 배율) }
export function accPlace(animal, view, slot, item) {
  const an = ANCHORS[animal];
  if (!an) return null;
  const kind = viewKind(view);
  const isSide = kind === 'side';
  const p = (isSide ? an.S : an.F)[SLOT_ANCHOR[slot]];
  const W = isSide ? an.sw : an.fw;
  // 뒷모습은 앞모습 좌우 반전, 오른쪽 옆모습은 왼쪽 옆모습 좌우 반전
  const mirror = kind === 'back' || view.startsWith('right');
  const x = mirror ? W - p[0] : p[0];
  const fit = SLOT_FIT[slot];
  // 푹 쓰는 모자(비니·야구 모자·베레모)는 아랫단을 이마에
  const eyesY = (isSide ? an.S : an.F).eyes[1];
  const y = item?.brow != null ? p[1] + (eyesY - p[1]) * item.brow : p[1];
  return {
    left: (x / W) * 100, top: (y / H) * 100, width: (p[2] / H) * (item?.size || 1),
    ax: fit.ax, ay: item?.ay ?? fit.ay, sx: isSide ? fit.side : 1, mirror,
  };
}

// 캐릭터 위에 얹을 액세서리 HTML (그림과 같은 상자 안에 넣음, font-size = 캐릭터 키)
export function lookAccHtml(look, view) {
  const kind = viewKind(view);
  return LAYERS[kind].map((slot) => {
    const it = accOf(look?.[slot]);
    if (!it || it.slot !== slot) return '';
    if (slot === 'eyes' && kind === 'back') return '';
    if (slot === 'back' && kind === 'front') return ''; // 앞에서는 가방이 안 보임
    if (slot === 'neck' && kind === 'back' && it.id === 'bowtie') return '';
    const pl = accPlace(look.a, view, slot, it);
    if (!pl) return '';
    // 옆모습 안경은 한쪽 알만 보이게 좁게
    const sx = slot === 'eyes' && kind === 'side' ? 0.45 : pl.sx;
    const flip = pl.mirror && kind === 'side' ? -1 : 1;
    const style = `left:${pl.left.toFixed(2)}%;top:${pl.top.toFixed(2)}%;width:${pl.width.toFixed(3)}em;`
      + `transform:translate(-${pl.ax}%,-${pl.ay}%) scaleX(${(sx * flip).toFixed(2)})`;
    return `<img class="acc acc-${slot}" src="${accImg(it.id)}" alt="" draggable="false" style="${style}">`;
  }).join('');
}
