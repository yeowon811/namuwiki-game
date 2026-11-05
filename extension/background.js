import { newRace, applyNav, summary, pageFromUrl } from './tracker.js';

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
      if (race) { notifyRaceTab(null, race.tabId, { ended: !!msg.ended }); await clear(); }
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
    case 'NAV': {
      if (!race || tabId !== race.tabId) return { race: null };
      if (applyNav(race, msg.nav)) {
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
