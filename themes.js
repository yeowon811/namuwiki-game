// 대기실 광장 배경 테마 (상점에서 1000P로 삼)
// 그림: img/themes/{id}.webp — 기본 테마는 img/lobby.webp
// 크기는 기본 배경과 같은 비율(1672×941, 가로:세로 ≈ 16:9)로 맞춰야 캐릭터가 걸어다니는 자리가 어긋나지 않아요.
// 아이디는 영어 소문자·숫자·_ 로 1~20자 (서버 규칙이 이 모양만 허용).
export const THEME_PRICE = 1000;
export const DEFAULT_THEME = 'default';
export const THEME_VER = 1; // 그림을 바꾸면 올려서 캐시를 새로 받게 함

export const THEMES = [
  { id: DEFAULT_THEME, label: '기본 광장', src: 'img/lobby.webp?v=1' },
  // 예) { id: 'beach', label: '해변' },
];

export const themeOf = (id) => THEMES.find((t) => t.id === id) || null;
export const themeImg = (id) => {
  const t = themeOf(id) || themeOf(DEFAULT_THEME);
  return t.src || `img/themes/${t.id}.webp?v=${THEME_VER}`;
};
export const ownsTheme = (profile, id) => id === DEFAULT_THEME || profile?.owned?.themes?.[id] === true;
// 지금 쓰는 테마 (없어졌거나 안 산 테마면 기본)
export const myThemeId = (profile) => {
  const id = profile?.theme;
  return id && themeOf(id) && ownsTheme(profile, id) ? id : DEFAULT_THEME;
};
