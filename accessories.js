// 캐릭터 꾸미기 액세서리 목록
// 부위(slot)마다 하나씩 고를 수 있고, 여러 부위를 함께 착용할 수 있어요.
// 3D 모양은 plaza3d.js의 ACC_BUILDERS에 같은 id로 만들어져 있어요.
export const SLOTS = [
  {
    key: 'head',
    label: '머리',
    items: [
      { id: 'cap', label: '캡모자', emoji: '🧢' },
      { id: 'tophat', label: '중절모', emoji: '🎩' },
      { id: 'crown', label: '왕관', emoji: '👑' },
      { id: 'party', label: '파티 모자', emoji: '🥳' },
      { id: 'straw', label: '밀짚모자', emoji: '👒' },
      { id: 'beanie', label: '비니', emoji: '🧶' },
      { id: 'ribbon', label: '리본 머리띠', emoji: '🎀' },
      { id: 'bunny', label: '토끼 머리띠', emoji: '🐰' },
    ],
  },
  {
    key: 'eyes',
    label: '눈',
    items: [
      { id: 'glasses', label: '안경', emoji: '👓' },
      { id: 'sunglasses', label: '선글라스', emoji: '🕶️' },
      { id: 'heart', label: '하트 선글라스', emoji: '😍' },
      { id: 'monocle', label: '외알 안경', emoji: '🧐' },
    ],
  },
  {
    key: 'face',
    label: '얼굴',
    items: [
      { id: 'mustache', label: '콧수염', emoji: '👨' },
      { id: 'beard', label: '턱수염', emoji: '🧔' },
      { id: 'blush', label: '볼터치', emoji: '☺️' },
      { id: 'mask', label: '마스크', emoji: '😷' },
    ],
  },
  {
    key: 'neck',
    label: '목',
    items: [
      { id: 'bowtie', label: '나비넥타이', emoji: '🤵' },
      { id: 'scarf', label: '목도리', emoji: '🧣' },
      { id: 'medal', label: '메달', emoji: '🏅' },
      { id: 'necklace', label: '목걸이', emoji: '📿' },
    ],
  },
];

const ITEM = new Map(SLOTS.flatMap((s) => s.items.map((it) => [it.id, { ...it, slot: s.key }])));
export const itemOf = (id) => ITEM.get(id) || null;

// 저장된 값에서 올바른 액세서리만 골라냄 → { head, eyes, face, neck } (없으면 null)
export function cleanAcc(raw) {
  const out = {};
  for (const s of SLOTS) {
    const id = raw?.[s.key];
    out[s.key] = ITEM.get(id)?.slot === s.key ? id : null;
  }
  return out;
}

// 목록 등에 쓰는 대표 이모지: 착용한 액세서리 중 첫 번째, 없으면 🙂
export function glyphOf(acc) {
  for (const s of SLOTS) if (acc?.[s.key]) return ITEM.get(acc[s.key]).emoji;
  return '🙂';
}
