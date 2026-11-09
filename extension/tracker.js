// 레이스 기록 로직 (크롬 API를 쓰지 않는 순수 함수라 따로 테스트할 수 있음)

export const norm = (s) => String(s ?? '').normalize('NFC').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

// https://namu.wiki/w/<제목>?from=<넘겨주기 전 제목> → { title, from }
// 문서가 아닌 페이지(검색, 최근 변경 등)는 null
export function pageFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'namu.wiki' || !u.pathname.startsWith('/w/')) return null;
  const raw = u.pathname.slice(3);
  let title;
  try { title = decodeURIComponent(raw); } catch { title = raw; }
  if (!title) return null;
  return { title, from: u.searchParams.get('from') };
}

// 넘겨주기(리다이렉트)도 인정: 목표가 'BTS'면 '방탄소년단?from=BTS'도 도착
export function matches(page, keyword) {
  if (!page) return false;
  const k = norm(keyword);
  return norm(page.title) === k || (page.from != null && norm(page.from) === k);
}

export const CLICK_WINDOW_MS = 8000; // 링크 클릭 후 이 시간 안에 문서가 바뀌면 '링크로 이동'으로 인정
export const BACK_WINDOW_MS = 3000;
export const MAX_STRIKES = 2; // 위반이 이만큼 쌓이면 실격
export const AWAY_MS = 3000; // 다른 탭·창을 이 시간 넘게 보면 경고
export const RETURN_WINDOW_MS = 20000; // '이전 문서로' 버튼을 누른 뒤 이 시간 안에 그 문서가 열리면 되돌아가기로 인정

export function newRace(info) {
  return {
    code: info.code,
    round: info.round,
    playerId: info.playerId,
    mode: info.mode,
    start: info.start,
    target: info.target,
    // 릴레이는 목표가 여러 개. 아니면 목표 1개짜리 릴레이와 같음
    targets: Array.isArray(info.targets) && info.targets.length ? info.targets : [info.target],
    leg: 0, // 지금까지 도착한 목표 수
    legT: [], // 목표마다 도착 시각
    startAt: info.startAt, // 내 PC 시계 기준 ms
    tabId: null,
    gameTabId: info.gameTabId ?? null,
    steps: [], // { title, h: 'start' | 'link' | 'back' | 'other' | 'return', t }
    trail: [], // 되돌아가기용: 지나온 문서 (되돌아가면 하나씩 빠짐)
    returnTo: null, // '이전 문서로'를 눌러 돌아가는 중인 문서 { title, t }
    hints: [], // 힌트를 본 목표 번호 (릴레이는 목표마다 따로)
    hintText: {}, // 목표 번호 → 힌트 내용
    strikes: [], // 위반 { kind: 'back' | 'other' | 'find', title, t }
    findDocs: [], // Ctrl+F를 시도한 문서 (문서마다 1회만 셈)
    pendingRestore: null, // 위반 이동을 되돌릴 문서
    dq: false, // 실격
    away: 0, // 다른 탭·창을 본 횟수 (경고만)
    awaySince: null,
    offDoc: false,
    finished: false,
    finishT: null,
  };
}

/**
 * 레이스 탭의 주소가 바뀌었을 때 호출.
 * nav: { url, t, clickT, popT }  (clickT: 마지막 링크 클릭 시각, popT: 마지막 뒤로/앞으로 가기 시각)
 * 반환: 기록이 바뀌었으면 true
 */
// 위반 1회 추가. 3회면 실격
export function addStrike(race, kind, title, t) {
  race.strikes = race.strikes || [];
  race.strikes.push({ kind, title, t });
  if (race.strikes.length >= MAX_STRIKES) { race.dq = true; race.dqT = t; }
}

// Ctrl+F 시도: 같은 문서에서는 1회만 셈
export function strikeFind(race, title, t) {
  if (race.finished || race.dq) return false;
  race.findDocs = race.findDocs || [];
  const key = norm(title || '');
  if (race.findDocs.includes(key)) return false;
  race.findDocs.push(key);
  addStrike(race, 'find', title, t);
  return true;
}

export function applyNav(race, nav) {
  if (race.finished || race.dq) return false;
  if (nav.t < race.startAt) return false;
  const page = pageFromUrl(nav.url);
  if (!page) {
    // 검색 결과 같은 문서가 아닌 페이지로 나감 → 다음 이동은 규칙 위반으로 표시
    race.offDoc = true;
    return false;
  }
  const last = race.steps[race.steps.length - 1];
  if (last && norm(last.title) === norm(page.title)) {
    race.offDoc = false; // 같은 문서로 돌아옴 (문단 이동, 새로고침 등)
    return false;
  }
  race.trail = race.trail || [];
  let h;
  const ret = race.returnTo;
  race.returnTo = null;
  if (ret && nav.t - ret.t >= 0 && nav.t - ret.t < RETURN_WINDOW_MS && norm(ret.title) === norm(page.title)) h = 'return';
  else if (race.steps.length === 0) h = matches(page, race.start) ? 'start' : 'other';
  else if (race.offDoc) h = 'other';
  else if (nav.popT && nav.t - nav.popT >= 0 && nav.t - nav.popT < BACK_WINDOW_MS) h = 'back';
  else if (nav.clickT && nav.t - nav.clickT >= 0 && nav.t - nav.clickT < CLICK_WINDOW_MS) h = 'link';
  else h = 'other';

  // 위반 이동(뒤로가기, 주소창 입력 등): 기록에 남기지 않고 원래 문서로 되돌림
  if (h === 'back' || h === 'other') {
    race.offDoc = false;
    addStrike(race, h, page.title, nav.t);
    race.pendingRestore = last ? last.title : race.start;
    return true;
  }

  const step = { title: page.title, h, t: nav.t };
  race.steps.push(step);
  race.offDoc = false;
  if (h === 'return') race.trail.pop();
  else race.trail.push(page.title);
  const targets = race.targets || [race.target];
  race.leg = race.leg || 0;
  race.legT = race.legT || [];
  if (matches(page, targets[race.leg])) {
    step.cp = true;
    race.legT.push(nav.t);
    race.leg += 1;
    if (race.leg >= targets.length) {
      race.finished = true;
      race.finishT = nav.t;
    }
  }
  return true;
}

// '이전 문서로' 버튼: 돌아갈 문서 제목 (돌아갈 곳이 없으면 null)
export function requestReturn(race, t) {
  const trail = race.trail || [];
  if (race.finished || race.dq || trail.length < 2) return null;
  const title = trail[trail.length - 2];
  race.returnTo = { title, t };
  return title;
}

// 힌트: 지금 목표에 대한 힌트를 처음 보는 것인지 기록
export function useHint(race) {
  const targets = race.targets || [race.target];
  const idx = Math.min(race.leg || 0, targets.length - 1);
  race.hints = race.hints || [];
  const isNew = !race.hints.includes(idx);
  if (isNew) race.hints.push(idx);
  return { idx, target: targets[idx], isNew };
}

export function summary(race) {
  if (!race) return null;
  return {
    code: race.code,
    round: race.round,
    playerId: race.playerId,
    mode: race.mode,
    start: race.start,
    target: race.target,
    targets: race.targets || [race.target],
    total: (race.targets || [race.target]).length,
    leg: race.leg || 0,
    legT: race.legT || [],
    // 지금 쫓고 있는 목표 (도착하면 마지막 목표)
    current: (race.targets || [race.target])[Math.min(race.leg || 0, (race.targets || [race.target]).length - 1)],
    startAt: race.startAt,
    steps: race.steps.map(({ title, h, cp }) => (cp ? { title, h, cp } : { title, h })),
    clicks: Math.max(0, race.steps.length - 1),
    violations: (race.strikes || []).length,
    strikes: (race.strikes || []).map(({ kind, title }) => ({ kind, title })),
    maxStrikes: MAX_STRIKES,
    dq: !!race.dq,
    away: race.away || 0,
    returns: race.steps.filter((s) => s.h === 'return').length,
    canReturn: !race.finished && !race.dq && (race.trail || []).length >= 2,
    returnTitle: (race.trail || []).length >= 2 ? race.trail[race.trail.length - 2] : null,
    hints: (race.hints || []).length,
    hintText: race.hintText?.[Math.min(race.leg || 0, (race.targets || [race.target]).length - 1)] || null,
    finished: race.finished,
    finishT: race.finishT,
    hasTab: race.tabId != null,
    board: race.board || null, // 게임 페이지가 보내준 실시간 순위
    chat: race.chat || [], // 이번 판 채팅 (최근 5개)
  };
}
