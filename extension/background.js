import { newRace, applyNav, summary, pageFromUrl, requestReturn, useHint, strikeFind, AWAY_MS } from './tracker.js';

const namuUrl = (t) => 'https://namu.wiki/w/' + encodeURIComponent(t);

// 서비스 워커는 언제든 꺼질 수 있으니 상태는 storage.session에 저장
async function load() { return (await chrome.storage.session.get('race')).race || null; }
async function save(race) { await chrome.storage.session.set({ race }); }
async function clear() { await chrome.storage.session.remove('race'); }

// 메시지를 순서대로 처리 (동시에 들어온 이동 기록이 섞이지 않도록)
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

function notifyGame(race) {
  if (race?.gameTabId == null) return;
  chrome.tabs.sendMessage(race.gameTabId, { type: 'STATE', race: summary(race) }).catch(() => {});
}
function notifyRaceTab(race, tabId = race?.tabId, extra = {}) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'HUD', race: race ? summary(race) : null, ...extra }).catch(() => {});
}

async function openRaceTab(race) {
  if (race.tabId != null) {
    try {
      const tab = await chrome.tabs.update(race.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      race.tabId = null; // 탭이 닫혀 있음
    }
  }
  // 탭을 닫았다가 다시 열면 마지막으로 있던 문서에서 이어서 시작
  const last = race.steps[race.steps.length - 1];
  const tab = await chrome.tabs.create({ url: namuUrl(last ? last.title : race.start) });
  race.tabId = tab.id;
}

// 위키백과 요약 (힌트): 처음 1~2문장
function shorten(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = t.match(/[^.!?。]+[.!?。]?/g) || [t];
  let out = '';
  for (const s of sentences) {
    if (out && (out + s).length > 170) break;
    out += s;
    if (out.length > 90) break;
  }
  return out.trim().slice(0, 220);
}
async function wikiSummary(title) {
  const summaryOf = async (t) => {
    try {
      const r = await fetch(`https://ko.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`);
      if (!r.ok) return null;
      const j = await r.json();
      if (j.type === 'disambiguation' || !j.extract) return null;
      return shorten(j.extract);
    } catch { return null; }
  };
  let text = await summaryOf(title);
  if (!text) {
    try {
      const r = await fetch(`https://ko.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title)}&srlimit=1&format=json&origin=*`);
      const found = (await r.json())?.query?.search?.[0]?.title;
      if (found) text = await summaryOf(found);
    } catch { /* 검색 실패 */ }
  }
  return text || '위키백과에서 설명을 찾지 못했어요. 문서 제목에서 떠오르는 분야로 가 보세요!';
}

async function handle(msg, sender) {
  const tabId = sender.tab?.id;
  let race = await load();

  switch (msg.type) {
    // ----- 게임 페이지에서 -----
    case 'GAME_HELLO': {
      if (race) { race.gameTabId = tabId; await save(race); }
      return { race: summary(race) };
    }
    case 'RACE': {
      const r = msg.race || {};
      if (race && race.code === r.code && race.round === r.round && race.playerId === r.playerId) {
        race.gameTabId = tabId;
      } else {
        if (race) notifyRaceTab(null, race.tabId);
        race = newRace({ ...r, gameTabId: tabId });
      }
      await save(race);
      return { race: summary(race) };
    }
    case 'OPEN_START': {
      if (!race) return { race: null };
      race.gameTabId = tabId;
      await openRaceTab(race);
      await save(race);
      return { race: summary(race) };
    }
    case 'STOP': {
      if (race) { notifyRaceTab(null, race.tabId, { ended: !!msg.ended, board: msg.board || race.board || null }); await clear(); }
      return { race: null };
    }
    case 'BOARD': {
      // 실시간 순위: 같은 판일 때만 받아서 레이스 탭에 전달
      if (!race || race.code !== msg.code || race.round !== msg.round) return {};
      race.board = msg.board;
      await save(race);
      notifyRaceTab(race);
      return {};
    }

    // ----- 나무위키 탭에서 -----
    case 'NAMU_HELLO': {
      if (!race || tabId !== race.tabId) return { race: null };
      return { race: summary(race) };
    }
    case 'RETURN': {
      // '이전 문서로' 버튼: 레이스 탭을 직전 문서로 보냄 (규칙 위반이 아니라 되돌아가기로 기록)
      if (!race || tabId !== race.tabId) return { race: null };
      const title = requestReturn(race, Date.now());
      if (!title) return { race: summary(race) };
      await save(race);
      chrome.tabs.update(race.tabId, { url: namuUrl(title) }).catch(() => {});
      return { race: summary(race), returnTo: title };
    }
    case 'HINT': {
      // 힌트: 지금 목표의 위키백과 요약. 목표마다 처음 볼 때만 페널티
      if (!race || tabId !== race.tabId || race.finished || race.dq) return { race: summary(race) };
      const h = useHint(race);
      race.hintText = race.hintText || {};
      if (!race.hintText[h.idx]) {
        await save(race); // 페널티는 먼저 기록
        race.hintText[h.idx] = await wikiSummary(h.target);
        const latest = await load(); // 요약을 받는 동안 바뀐 기록 반영
        if (latest && latest.code === race.code && latest.round === race.round) {
          latest.hints = race.hints;
          latest.hintText = { ...(latest.hintText || {}), [h.idx]: race.hintText[h.idx] };
          race = latest;
        }
      }
      await save(race);
      if (h.isNew) notifyGame(race);
      return { race: summary(race), hint: { target: h.target, text: race.hintText[h.idx], isNew: h.isNew } };
    }
    case 'NAV': {
      if (!race || tabId !== race.tabId) return { race: null };
      if (applyNav(race, msg.nav)) {
        // 위반 이동이면 원래 문서로 되돌림
        const restore = race.pendingRestore;
        race.pendingRestore = null;
        await save(race);
        if (restore && !race.dq) chrome.tabs.update(race.tabId, { url: namuUrl(restore) }).catch(() => {});
        notifyGame(race);
      }
      return { race: summary(race) };
    }
    case 'STRIKE': {
      // 레이스 탭에서 Ctrl+F 등 금지 행동 시도
      if (!race || tabId !== race.tabId) return { race: null };
      if (msg.kind === 'find' && strikeFind(race, msg.title, Date.now())) {
        await save(race);
        notifyGame(race);
      }
      return { race: summary(race) };
    }
  }
  return {};
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  serial(() => handle(msg, sender)).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // 비동기 응답
});

// 레이스 중 다른 탭·창을 보는지 감시 (경고만, 3초 넘게 보면 1회)
function onActiveChange(activeTabId) {
  serial(async () => {
    const race = await load();
    if (!race || race.finished || race.dq || race.tabId == null) return;
    const allowed = activeTabId != null && (activeTabId === race.tabId || activeTabId === race.gameTabId);
    if (!allowed) {
      if (!race.awaySince) { race.awaySince = Date.now(); await save(race); }
      return;
    }
    if (race.awaySince) {
      const long = Date.now() - race.awaySince > AWAY_MS;
      race.awaySince = null;
      if (long) race.away = (race.away || 0) + 1;
      await save(race);
      if (long) {
        notifyGame(race);
        notifyRaceTab(race, race.tabId, { awayWarn: true });
      }
    }
  });
}
chrome.tabs.onActivated.addListener(({ tabId }) => onActiveChange(tabId));
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return onActiveChange(null); // 크롬 밖의 다른 프로그램
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    onActiveChange(tab?.id ?? null);
  } catch { /* 무시 */ }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const race = await load();
    if (race && race.tabId === tabId) {
      race.tabId = null;
      await save(race);
      notifyGame(race);
    }
  });
});

// 레이스 탭에서 새 탭 열기(가운데 클릭 등)로 다른 문서를 보는 건 기록하지 않음.
// 단, 레이스 탭 자체의 주소 변경은 내용 스크립트가 보고하지 못하는 경우(전체 새로고침 직후 등)를 대비해 여기서도 확인
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url || !pageFromUrl(info.url)) return;
  serial(async () => {
    const race = await load();
    if (!race || race.tabId !== tabId || race.steps.length > 0) return;
    // 레이스 탭이 처음 시작 문서를 열었을 때 (내용 스크립트보다 먼저 기록)
    if (applyNav(race, { url: info.url, t: Date.now() })) {
      await save(race);
      notifyGame(race);
      notifyRaceTab(race);
    }
  });
});
