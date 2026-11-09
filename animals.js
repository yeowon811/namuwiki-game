// 대기실 캐릭터: 동물 10마리
// 그림은 img/animals/{id}-{icon|front|side|back}.webp (옆모습은 왼쪽을 봄)
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
const BY_ID = new Map(ANIMALS.map((a) => [a.id, a]));
export const animalOf = (id) => BY_ID.get(id) || null;
export const ANIMAL_VER = 1; // 그림을 바꾸면 올려서 캐시를 새로 받게 함
export const animalImg = (id, view = 'front') => `img/animals/${id}-${view}.webp?v=${ANIMAL_VER}`;
