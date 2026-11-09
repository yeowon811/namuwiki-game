// 캐릭터(동물)와 액세서리 목록 + 상점 가격
// 동물 그림: img/animals/{id}-{icon|front|side|back}.webp (옆모습은 왼쪽을 봄)
// 액세서리 그림: img/acc/{id}.webp 를 넣고 아래 목록의 img를 true로 바꾸면 이모지 대신 그림이 보여요.
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
  { key: 'head', label: '머리' },
  { key: 'eyes', label: '눈' },
  { key: 'neck', label: '목' },
];
// 지금은 임시 이모지. 그림 파일을 받으면 img: true
export const ACCESSORIES = [
  { id: 'crown', slot: 'head', label: '왕관', emoji: '👑', img: false },
  { id: 'tophat', slot: 'head', label: '중절모', emoji: '🎩', img: false },
  { id: 'ribbon', slot: 'head', label: '리본', emoji: '🎀', img: false },
  { id: 'flower', slot: 'head', label: '꽃', emoji: '🌸', img: false },
  { id: 'sunglasses', slot: 'eyes', label: '선글라스', emoji: '🕶️', img: false },
  { id: 'glasses', slot: 'eyes', label: '안경', emoji: '👓', img: false },
  { id: 'scarf', slot: 'neck', label: '목도리', emoji: '🧣', img: false },
  { id: 'medal', slot: 'neck', label: '메달', emoji: '🏅', img: false },
];

const BY_ID = new Map(ANIMALS.map((a) => [a.id, a]));
const ACC_BY_ID = new Map(ACCESSORIES.map((a) => [a.id, a]));
export const animalOf = (id) => BY_ID.get(id) || null;
export const accOf = (id) => ACC_BY_ID.get(id) || null;
export const ANIMAL_VER = 1; // 그림을 바꾸면 올려서 캐시를 새로 받게 함
export const animalImg = (id, view = 'front') => `img/animals/${id}-${view}.webp?v=${ANIMAL_VER}`;
export const accImg = (id) => `img/acc/${id}.webp?v=${ANIMAL_VER}`;

// 가진 것 확인 (profile = users/{uid})
export const ownsAnimal = (profile, id) => id === FREE_ANIMAL || profile?.owned?.animals?.[id] === true;
export const ownsAcc = (profile, id) => profile?.owned?.acc?.[id] === true;

// 저장된 모습에서 올바른 것만 남김 → { a, head, eyes, neck } (액세서리 없으면 null)
// owned를 주면 가진 것만 남김
export function cleanLook(raw, profile = null) {
  const a = animalOf(raw?.a) && (!profile || ownsAnimal(profile, raw.a)) ? raw.a : FREE_ANIMAL;
  const out = { a };
  for (const s of SLOTS) {
    const it = accOf(raw?.[s.key]);
    out[s.key] = it && it.slot === s.key && (!profile || ownsAcc(profile, it.id)) ? it.id : null;
  }
  return out;
}
// 액세서리 한 개를 HTML로 (그림이 있으면 그림, 없으면 이모지)
export const accHtml = (it, cls = '') => (it.img
  ? `<img class="${cls}" src="${accImg(it.id)}" alt="${it.label}" draggable="false">`
  : `<span class="${cls}" role="img" aria-label="${it.label}">${it.emoji}</span>`);
