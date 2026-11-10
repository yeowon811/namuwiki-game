// 캐릭터(동물)와 액세서리 목록 + 상점 가격 + 액세서리 위치
// 동물 그림: img/animals/{id}-{front|back|left1|left2|right1|right2|icon}.webp (키 360px로 맞춤)
// 액세서리 그림: img/acc/{id}.webp
// 옷 입은 그림: img/animals/outfit/{id}-{view}-{옷 id}.webp (기본 그림 둘레에 OUTFIT_PAD px 여백, 같은 크기·위치)
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
  { id: 'hamster', label: '햄스터', emoji: '🐹', runOnly: true }, // 옆으로 움직일 땐 달리는 그림(2번)만
  { id: 'shark', label: '우주 상어', emoji: '🦈', noAcc: true }, // 헬멧을 쓰고 있어서 액세서리를 못 씀
];

// 액세서리 부위: 부위마다 하나씩 착용
// off: true인 부위는 잠시 숨김 (상점·고르기 목록에 안 나오고, 이미 착용한 것도 안 보임. 산 기록은 그대로 남음)
//   → 옷 입은 그림이 준비되면 off를 지워서 다시 켜요. (옷은 켜짐: 옷 입은 그림으로 통째로 바꿔 보여줌)
const ALL_SLOTS = [
  { key: 'head', label: '모자' },
  { key: 'eyes', label: '안경', off: true },
  { key: 'neck', label: '목', off: true },
  { key: 'body', label: '옷' },
  { key: 'feet', label: '신발', off: true },
  { key: 'back', label: '가방' },
];
export const SLOTS = ALL_SLOTS.filter((s) => !s.off);
// size: 그 부위 기본 크기 대비 배율 · ay: 기준점에 맞출 그림 속 높이(%)
// brow: 모자 아랫단을 머리 꼭대기와 눈 사이 어디에 둘지 (0 = 머리 꼭대기, 1 = 눈)
const ALL_ACCESSORIES = [
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
// 지금 켜져 있는 부위의 액세서리만
export const ACCESSORIES = ALL_ACCESSORIES.filter((a) => SLOTS.some((s) => s.key === a.slot));
const ACC_BY_ID = new Map(ACCESSORIES.map((a) => [a.id, a]));
export const animalOf = (id) => BY_ID.get(id) || null;
// 옆으로 움직일 때 쓰는 그림 번호: 보통은 1·2번을 번갈아, runOnly면 2번만
export const walkFrames = (id) => (BY_ID.get(id)?.runOnly ? [1] : [0, 1]);
export const accOf = (id) => ACC_BY_ID.get(id) || null;
// 액세서리를 쓸 수 있는 캐릭터인지 (noAcc면 착용해 둔 것도 안 보임, 다른 캐릭터로 바꾸면 다시 보임)
export const canWearAcc = (id) => !BY_ID.get(id)?.noAcc;
export const ANIMAL_VER = 8; // 그림을 바꾸면 올려서 캐시를 새로 받게 함
export const animalImg = (id, view = 'front') => `img/animals/${id}-${view}.webp?v=${ANIMAL_VER}`;
export const accImg = (id) => `img/acc/${id}.webp?v=${ANIMAL_VER}`;
// 옷: 옷 입은 캐릭터 그림을 기본 그림 위에 겹쳐서 보여줌 (기본 그림은 CSS로 숨김)
export const OUTFIT_PAD = 30;
const outfitOf = (look) => {
  const it = canWearAcc(look?.a) ? accOf(look?.body) : null;
  return it && it.slot === 'body' && FRAMES[look.a] ? it.id : null;
};
const outfitImg = (a, view, id) => `img/animals/outfit/${a}-${view}-${id}.webp?v=${ANIMAL_VER}`;
// 미리 받아 둘 옷 그림들 (광장에서 방향을 바꿀 때 깜빡이지 않게)
export const lookOutfitImgs = (look) => {
  const id = outfitOf(look);
  return id ? VIEWS.map((v) => outfitImg(look.a, v, id)) : [];
};
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
// S2 / sw2: 옆모습 두 번째 장이 첫 장과 많이 다를 때만 (햄스터: 달리는 자세)
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
  hamster: { fw: 299, sw: 266, sw2: 267,
    F: { head: [149, 30, 190], eyes: [147, 122, 150], neck: [148, 178, 145], body: [148, 172, 172], feet: [148, 357, 180], pack: [148, 232, 165] },
    S: { head: [140, 32, 180], eyes: [40, 130, 105], neck: [80, 182, 105], body: [122, 178, 138], feet: [112, 352, 145], pack: [210, 232, 140] },
    S2: { head: [112, 174, 150], eyes: [42, 194, 95], neck: [70, 250, 85], body: [138, 236, 112], feet: [132, 352, 130], pack: [206, 228, 120] } },
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
// 그림마다 잰 값 (자동 측정): 그림 폭 w[앞, 뒤, 왼1, 왼2, 오1, 오2], 머리 가운데 hc[앞, 뒤],
// 앞모습 두 눈 ef[왼눈 x, 오른눈 x, y], 옆모습 눈 es[왼1, 왼2, 오1, 오2] = [x, y]
// → 액세서리를 각 그림의 실제 눈·머리 위치에 맞춤 (그림마다 자세·폭이 조금씩 달라도 어긋나지 않게)
const FRAMES = {
  cat: { w: [286, 256, 262, 269, 280, 279], hc: [137, 128], ef: [85, 192, 159], es: [[30, 159], [31, 161], [245, 148], [243, 158]] },
  rabbit: { w: [220, 209, 220, 191, 189, 199], hc: [110, 105], ef: [68, 154, 185], es: [[25, 190], [26, 176], [160, 175], [174, 177]] },
  penguin: { w: [260, 246, 261, 247, 251, 244], hc: [130, 122], ef: [85, 175, 151], es: [[44, 148], [45, 149], [207, 144], [206, 142]] },
  chick: { w: [250, 238, 235, 244, 272, 252], hc: [126, 119], ef: [79, 173, 157], es: [[38, 143], [41, 148], [231, 154], [212, 149]] },
  panda: { w: [269, 269, 253, 248, 245, 237], hc: [133, 134], ef: [87, 183, 137], es: [[36, 149], [38, 139], [207, 133], [199, 130]] },
  dog: { w: [348, 356, 285, 298, 288, 272], hc: [174, 178], ef: [126, 227, 131], es: [[44, 134], [42, 131], [239, 123], [231, 121]] },
  dinosaur: { w: [286, 239, 307, 329, 311, 294], hc: [121, 119], ef: [70, 162, 141], es: [[42, 137], [44, 147], [270, 133], [253, 119]] },
  bear: { w: [255, 267, 246, 244, 234, 249], hc: [126, 132], ef: [78, 175, 134], es: [[50, 143], [40, 135], [190, 134], [201, 137]] },
  fox: { w: [298, 270, 310, 335, 315, 337], hc: [132, 134], ef: [84, 184, 155], es: [[46, 156], [42, 154], [270, 146], [296, 143]] },
  sheep: { w: [343, 318, 280, 261, 266, 277], hc: [171, 158], ef: [125, 216, 156], es: [[30, 143], [31, 151], [231, 138], [240, 154]] },
  hamster: { w: [299, 294, 266, 267, 264, 249], hc: [149, 146], ef: [103, 196, 124], es: [[31, 137], [43, 209], [234, 137], [207, 211]] },
};
const VIEW_IDX = { front: 0, back: 1, left1: 2, left2: 3, right1: 4, right2: 5 };
const LENS = 0.445; // 안경 그림에서 두 렌즈 가운데 사이 거리 (그림 폭 대비)

// 액세서리 위치: { left(%), top(%), width(em = 캐릭터 키 대비), ax, ay, sx(가로 배율) }
export function accPlace(animal, view, slot, item) {
  const an = ANCHORS[animal];
  const fr = FRAMES[animal];
  if (!an || !fr) return null;
  const kind = viewKind(view);
  const isSide = kind === 'side';
  const right = view.startsWith('right');
  const second = view.endsWith('2');
  const fit = SLOT_FIT[slot];
  const W = fr.w[VIEW_IDX[view]];
  let x;
  let y;
  let w;
  let eyesY;
  if (kind === 'front' || kind === 'back') {
    const p = an.F[SLOT_ANCHOR[slot]];
    w = p[2];
    eyesY = fr.ef[2];
    // 뒷모습: 앞모습을 머리 가운데 기준으로 좌우 반전
    x = kind === 'front' ? p[0] : fr.hc[1] - (p[0] - fr.hc[0]);
    y = p[1];
    if (slot === 'eyes') {
      // 안경: 두 렌즈를 두 눈에 정확히
      x = (fr.ef[0] + fr.ef[1]) / 2;
      y = fr.ef[2];
      w = (fr.ef[1] - fr.ef[0]) / LENS;
    }
  } else {
    // 옆모습: 기준(왼쪽 1번, 햄스터처럼 두 번째 장이 많이 다르면 왼쪽 2번)에서 잰 눈과의 거리를 지금 그림의 눈에 맞춤
    const useS2 = second && an.S2;
    const set = useS2 ? an.S2 : an.S;
    const srcEye = fr.es[useS2 ? 1 : 0];
    const eye = fr.es[VIEW_IDX[view] - 2];
    const p = set[SLOT_ANCHOR[slot]];
    w = p[2];
    const dx = p[0] - srcEye[0];
    x = right ? eye[0] - dx : eye[0] + dx;
    y = slot === 'feet' ? p[1] : eye[1] + (p[1] - srcEye[1]);
    eyesY = eye[1];
    if (slot === 'eyes') { x = eye[0]; y = eye[1]; }
  }
  // 푹 쓰는 모자(비니·야구 모자·베레모)는 아랫단을 이마에
  if (item?.brow != null) y += (eyesY - y) * item.brow;
  return {
    left: (x / W) * 100, top: (y / H) * 100, width: (w / H) * (item?.size || 1),
    ax: fit.ax, ay: item?.ay ?? fit.ay, sx: isSide ? fit.side : 1, mirror: right,
  };
}

// 캐릭터 위에 얹을 액세서리 HTML (그림과 같은 상자 안에 넣음, font-size = 캐릭터 키)
export function lookAccHtml(look, view) {
  if (!canWearAcc(look?.a)) return '';
  const kind = viewKind(view);
  const outfit = outfitOf(look);
  let head = '';
  if (outfit) {
    const W = FRAMES[look.a].w[VIEW_IDX[view]];
    const P = OUTFIT_PAD;
    head = `<img class="acc acc-outfit" src="${outfitImg(look.a, view, outfit)}" alt="" draggable="false" style="`
      + `left:${(-P / W * 100).toFixed(3)}%;top:${(-P / H * 100).toFixed(3)}%;width:${((W + 2 * P) / H).toFixed(4)}em">`;
  }
  return head + LAYERS[kind].map((slot) => {
    if (slot === 'body') return ''; // 옷은 위에서 통째로 그림
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
