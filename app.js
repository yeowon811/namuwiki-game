import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider, signInAnonymously, deleteUser,
  setPersistence, browserSessionPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getDatabase, ref, get, set, update, remove, push, onValue, onDisconnect, serverTimestamp, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import {
  QUESTIONS, QA_COUNT, RCV_VER, checkQA, makeRecovery, relock, unlockKeys, recoverPassword, rememberPassword, recallPassword, forgetPasswords,
} from './recovery.js?v=2';
import { maskBad, hasBad } from './badwords.js?v=1';
import KEYWORDS from './keywords.js';
import {
  ANIMALS, ACCESSORIES, SLOTS, ANIMAL_PRICE, ACC_PRICE,
  animalOf, accOf, animalImg, accHtml, cleanLook, ownsAnimal, ownsAcc, lookAccHtml, canWearAcc,
} from './animals.js?v=14';
import { createPlaza } from './plaza2d.js?v=14';
import { THEMES, THEME_PRICE, DEFAULT_THEME, themeOf, themeImg, ownsTheme, myThemeId } from './themes.js?v=2';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const COUNTDOWN_MS = 3000;
const MAX_PLAYERS = 30;
const HOST_TIMEOUT_MS = 30 * 1000; // 방장이 이 시간 이상 연결이 끊기면 방장을 넘김

// ---------- 저장소 (실패해도 동작하도록) ----------
const ls = (() => { try { return localStorage; } catch { return null; } })();
const ss = (() => { try { return sessionStorage; } catch { return null; } })();
const store = {
  get(k, s = ls) { try { return s ? s.getItem(k) : null; } catch { return null; } },
  set(k, v, s = ls) { try { s && s.setItem(k, v); } catch {} },
  del(k, s = ls) { try { s && s.removeItem(k); } catch {} },
};
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
let playerId = null; // 로그인한 회원의 uid

// ---------- Firebase ----------
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);
let clockOffset = 0; // 서버시간 - 내시간
onValue(ref(db, '.info/serverTimeOffset'), (s) => { clockOffset = s.val() || 0; });
const now = () => Date.now() + clockOffset;

const roomRef = (code, ...rest) => ref(db, ['rooms', code, ...rest].join('/'));

// ---------- 상태 ----------
let room = null; // { code, hostId, mode, timeLimitMin, state, round, start, target, startAt, players: [] }
let currentCode = null;
let unsubscribeRoom = null;
let arrivedAt = null; // '도착' 버튼 누른 시각 (서버 기준)
let lastPhase = null;

// ---------- 확장 프로그램 연동 ----------
// 확장 프로그램(extension/game.js)과 window.postMessage로 대화
const ext = { ready: false, race: null, sentKey: null, writtenKey: null };
const toExt = (type, data = {}) => window.postMessage({ source: 'nr-page', type, ...data }, location.origin);
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'nr-ext') return;
  const msg = e.data;
  if (msg.type === 'READY') {
    ext.ready = true;
    ext.version = msg.version;
    ext.race = msg.race;
    if (!extOk() && !ext.minWarned) { ext.minWarned = true; toast(OLD_EXT_MSG, 'warning'); }
    render();
    syncExt();
  } else if (msg.type === 'STATE') {
    ext.race = msg.race;
    onExtState();
  } else if (msg.type === 'CHAT_SEND') {
    // 나무위키 탭의 채팅창에서 보낸 메시지 (지금 레이스 중인 방에만)
    if (room && extRaceIsCurrent()) sendChat(msg.text);
  } else if (msg.type === 'ERROR') {
    console.warn('[확장 프로그램]', msg.message);
  }
});
// 확장 프로그램의 내용 스크립트가 늦게 준비될 수 있으니 응답이 올 때까지 몇 번 물어봄
[0, 300, 1000, 2500, 5000].forEach((ms) => setTimeout(() => { if (!ext.ready) toExt('PING'); }, ms));

// 자동 기록 확장 프로그램이 있어야 준비·시작·오늘의 챔피언 도전을 할 수 있음
const NEED_EXT_MSG = '자동 기록 확장 프로그램을 설치해야 게임에 참가할 수 있어요. 시작 화면의 \'자동 기록 확장 프로그램 설치\'를 참고해 주세요.';
// 확장 프로그램이 이 버전보다 낮으면 게임에 참가할 수 없음 (규칙이 바뀐 버전: 1.7.0 = '이전 문서로'는 막다른 문서에서만)
const EXT_MIN = '1.7.0';
const verGte = (a, b) => {
  const x = String(a || '0').split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return true;
};
const extOk = () => ext.ready && verGte(ext.version, EXT_MIN);
const OLD_EXT_MSG = `자동 기록 확장 프로그램을 새 버전(${EXT_MIN})으로 바꿔야 게임에 참가할 수 있어요. 예전에 ZIP 파일로 설치했다면 삭제하고, 시작 화면의 '자동 기록 확장 프로그램 설치'에서 크롬 웹 스토어로 새로 설치해 주세요.`;
const extMsg = () => (ext.ready ? OLD_EXT_MSG : NEED_EXT_MSG);
const raceKey = () => (room ? `${room.code}/${room.round}` : null);
const extRaceIsCurrent = () => ext.race && room && ext.race.code === room.code && ext.race.round === room.round && ext.race.playerId === playerId;

// 게임 단계가 바뀔 때마다 확장 프로그램에 알림
function syncExt() {
  if (!ext.ready) return;
  const ph = phase();
  const racing = (ph === 'countdown' || ph === 'playing') && me()?.status === 'playing';
  const makeBoard = () => ({
    mode: room.mode,
    players: ranking(room).map((p) => ({
      id: p.id, name: p.name, status: p.status, me: p.id === playerId,
      clicks: p.clicks ?? null, elapsed: p.elapsed ?? null, leg: p.leg || 0, dq: !!p.dq, hints: p.hints || 0,
    })),
    total: targetsOf(room).length,
    // 힌트 카운트다운 (확장 프로그램 1.8.0부터 나무위키 화면에 표시). until은 내 PC 시계 기준
    wait: (() => {
      const w = hintWait();
      return w ? { until: w.until - clockOffset, who: w.who.map((p) => p.id), names: w.who.map((p) => p.name), winners: room.winners || 1 } : null;
    })(),
  });
  if (racing && ext.sentKey !== raceKey()) {
    ext.sentKey = raceKey();
    toExt('RACE', {
      race: {
        code: room.code, round: room.round, playerId, mode: room.mode,
        start: room.start, target: room.target, targets: targetsOf(room),
        startAt: room.startAt - clockOffset, // 내 PC 시계 기준으로 변환
      },
    });
  } else if (!racing && ext.sentKey) {
    // 판이 끝났거나 포기하면 기록 중지 (도착한 경우엔 판이 끝날 때까지 '도착!' 표시 유지)
    const inRound = ph === 'countdown' || ph === 'playing';
    if (!inRound || me()?.status !== 'finished') {
      ext.sentKey = null;
      ext.boardSent = null;
      ext.chatSent = null;
      toExt('STOP', { ended: !inRound, board: makeBoard() });
      return;
    }
  }
  // 나무위키 탭에 실시간 순위 보내기
  if (ext.sentKey && ext.sentKey === raceKey()) {
    const board = makeBoard();
    const json = JSON.stringify(board);
    if (ext.boardSent !== json) {
      ext.boardSent = json;
      toExt('BOARD', { code: room.code, round: room.round, board });
    }
    // 나무위키 탭 채팅창: 이번 판이 시작된 뒤의 대화 중 최근 5개 (시작할 땐 비어 있음)
    const chat = chatList()
      .filter((m) => typeof m.t === 'number' && m.t >= (room.startAt || 0))
      .slice(-5)
      .map((m) => ({ id: m.id, name: room.players.find((p) => p.id === m.pid)?.name || m.name || '', text: m.text, t: m.t, me: m.pid === playerId }));
    const chatJson = JSON.stringify(chat);
    if (ext.chatSent !== chatJson) {
      ext.chatSent = chatJson;
      toExt('CHAT', { code: room.code, round: room.round, chat });
    }
  }
}

// 확장 프로그램이 보낸 기록을 Firebase에 저장
function onExtState() {
  if (room?.state === 'playing') renderProgress();
  if (!extRaceIsCurrent() || me()?.status !== 'playing') return;
  const r = ext.race;
  const relay = room.mode === 'relay';
  // 예전 버전 확장 프로그램은 릴레이의 중간 목표를 모르므로 기록하지 않음
  if (relay && !Array.isArray(r.legT)) {
    if (!ext.oldWarned) { ext.oldWarned = true; toast('릴레이 모드는 확장 프로그램을 업데이트해야 기록돼요. (1.3.0 이상)', 'warning'); }
    return;
  }
  const key = `${raceKey()}/${r.steps.length}/${r.finished}/${r.leg}/${r.hints || 0}/${r.violations || 0}/${r.away || 0}/${!!r.dq}`;
  if (ext.writtenKey === key) return;
  const prevLeg = me()?.leg || 0;
  ext.writtenKey = key;
  const hints = r.hints || 0;
  const clicksMode = room.mode === 'clicks';
  const data = {
    auto: true,
    steps: r.steps,
    path: r.steps.map((s) => s.title),
    clicks: r.clicks + (clicksMode ? hints * HINT_CLICKS : 0),
    violations: r.violations,
    hints,
    returns: r.returns || 0,
    away: r.away || 0,
  };
  // 위반 3회 → 실격 (포기와 같이 처리하되 실격으로 표시)
  if (r.dq && !r.finished) {
    data.status = 'gaveup';
    data.dq = true;
  }
  if (relay) {
    data.leg = r.leg;
    data.legTimes = r.legT.map((t) => Math.max(0, t + clockOffset - room.startAt));
    const targets = targetsOf(room);
    if (!r.finished && r.leg > prevLeg) toast(`${r.leg}번째 목표 도착! 다음 목표: ${targets[r.leg]}`, 'success');
  }
  if (r.finished) {
    data.status = 'finished';
    data.elapsed = Math.max(0, r.finishT + clockOffset - room.startAt) + (clicksMode ? 0 : hints * HINT_MS);
  }
  update(roomRef(room.code, 'players', playerId), data).catch((e) => console.error(e));
  if (r.finished) toast('도착! 기록이 저장됐어요.', 'success');
  else if (data.dq) toast('규칙 위반 2회로 실격됐어요.', 'error');
}

// 힌트 페널티: 최소 클릭은 +3클릭, 타임어택·릴레이·오늘의 챔피언은 +30초
const HINT_MS = 30 * 1000;
const HINT_CLICKS = 3;
const hintPenaltyText = (mode, n) => (mode === 'clicks' ? `+${n * HINT_CLICKS}클릭` : `+${n * HINT_MS / 1000}초`);

// 도착한 사람을 기록(힌트 페널티 포함) 순으로
const podiumFinishers = () => room.players.filter((p) => p.status === 'finished').sort((a, b) => (a.elapsed || 0) - (b.elapsed || 0));
// 힌트 카운트다운: 설정한 등수(1~3등) 안에 힌트 페널티가 붙은 기록이 있으면,
// 그 기록(실제 도착 + 30초)만큼 시간이 지날 때까지 게임을 끝내지 않음 → 다른 사람이 그 안에 도착하면 앞설 수 있음
// 기다리는 중이면 { until(서버 시각), who(아직 확정 안 된 사람들) }, 아니면 null
function hintWait() {
  if (!room || room.state !== 'playing' || room.mode === 'clicks' || room.daily) return null;
  const k = room.winners || 1;
  const fin = podiumFinishers();
  if (fin.length < k) return null;
  const t = now() - room.startAt;
  const until = room.startAt + (fin[k - 1].elapsed || 0);
  if (now() >= until) return null;
  return { until, who: fin.slice(0, k).filter((p) => (p.elapsed || 0) > t) };
}
let hintWaitShown = null; // 이번 판에 안내 알림을 띄웠는지 (판 시작 시각)
function renderHintWait() {
  const box = $('#play-hintwait');
  const w = room?.state === 'playing' ? hintWait() : null;
  box.classList.toggle('hidden', !w);
  if (!w) return;
  const sec = Math.max(1, Math.ceil((w.until - now()) / 1000));
  const names = w.who.map((p) => `${esc(p.name)}님`).join(', ');
  const mine = w.who.some((p) => p.id === playerId);
  const status = me()?.status;
  const k = room.winners || 1;
  const place = k > 1 ? `${k}등 안에 들어요` : '이겨요';
  box.querySelector('.hw-sec').textContent = `${sec}초`;
  box.querySelector('.hw-msg').innerHTML = mine
    ? `힌트 페널티가 붙어서 아직 순위가 확정되지 않았어요. ${sec}초 안에 아무도 도착하지 못하면 순위가 그대로 확정돼요!`
    : status === 'playing'
      ? `${names}이 힌트를 쓰고 도착해서 기록에 페널티가 붙었어요. <b>${sec}초 안에 도착하면</b> 앞설 수 있어요! 못 하면 ${names}이 ${place}.`
      : `${names}이 힌트를 쓰고 도착했어요. 페널티 시간만큼 ${sec}초 뒤에 순위가 확정돼요.`;
  if (hintWaitShown !== room.startAt) {
    hintWaitShown = room.startAt;
    toast(mine ? '힌트 페널티 때문에 다른 사람에게 따라잡을 시간이 주어져요.' : `${w.who.map((p) => p.name).join(', ')}님이 힌트를 쓰고 도착했어요! ${sec}초 안에 도착하면 앞설 수 있어요.`, 'warning');
  }
}

function renderProgress() {
  const el = $('#play-progress');
  const r = extRaceIsCurrent() ? ext.race : null;
  if (!ext.ready || !r || me()?.status === 'waiting') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const last = r.steps[r.steps.length - 1];
  if (!last) {
    el.innerHTML = '위 버튼으로 나무위키를 열면 기록이 시작돼요.';
    return;
  }
  el.innerHTML = `<b>${r.clicks}클릭</b> · 지금 문서 <b>${esc(last.title)}</b>`
    + (r.hints ? `<br>💡 힌트 ${r.hints}회 (${hintPenaltyText(room.mode, r.hints)})` : '')
    + (r.violations ? `<br><span class="warn">규칙 위반 ${r.violations}/${r.maxStrikes || 2}회 (${r.maxStrikes || 2}회면 실격)</span>` : '')
    + (r.away ? `<br><span class="warn">다른 탭을 본 횟수 ${r.away}회</span>` : '');
}

const params = new URLSearchParams(location.search);
// 초대 링크(?room=ABCD)로 들어오면 '초대받은 방 참가하기' 버튼을 보여줌
const inviteCode = /^[A-Z0-9]{4}$/i.test(params.get('room') || '') ? params.get('room').toUpperCase() : null;
if (inviteCode) {
  $('#btn-invite').textContent = `초대받은 방 (${inviteCode}) 참가하기`;
  $('#btn-invite').classList.remove('hidden');
}

// ---------- 받은 데이터 정리 (보안) ----------
// 방 데이터는 참가자가 직접 쓰므로, 숫자여야 하는 칸에 글자(화면을 조작하는 코드 등)가 들어 있으면 버림
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const PLAYER_NUMS = ['clicks', 'hints', 'violations', 'returns', 'away', 'leg', 'elapsed', 'joinedAt', 'offlineSince', 'jumpAt'];
const PLAYER_BOOLS = ['dq', 'auto', 'online', 'ready', 'guest'];
const PLAYER_STATUS = ['waiting', 'playing', 'finished', 'gaveup'];
function cleanPlayer(id, p) {
  const o = { ...p, id, name: maskBad(String(p.name ?? '')) };
  for (const k of PLAYER_NUMS) if (k in o && !isNum(o[k])) delete o[k];
  for (const k of PLAYER_BOOLS) if (k in o && typeof o[k] !== 'boolean') delete o[k];
  if ('status' in o && !PLAYER_STATUS.includes(o.status)) o.status = 'waiting';
  if ('legTimes' in o) o.legTimes = Array.isArray(o.legTimes) ? o.legTimes.filter(isNum) : [];
  if ('path' in o) o.path = Array.isArray(o.path) ? o.path.map((t) => String(t ?? '')) : [];
  if ('steps' in o) o.steps = Array.isArray(o.steps) ? o.steps.filter((s) => s && typeof s === 'object').map((s) => ({ ...s, title: String(s.title ?? '') })) : [];
  return o;
}
const ROOM_NUMS = ['round', 'startAt', 'endedAt', 'createdAt', 'winners', 'legs', 'timeLimitMin'];
function cleanRoom(v) {
  const o = { ...v };
  for (const k of ROOM_NUMS) if (k in o && !isNum(o[k])) delete o[k];
  if (isNum(o.winners)) o.winners = Math.min(3, Math.max(1, Math.round(o.winners)));
  for (const k of ['start', 'target']) if (k in o) o[k] = String(o[k] ?? '');
  if ('targets' in o) o.targets = Array.isArray(o.targets) ? o.targets.map((t) => String(t ?? '')) : null;
  return o;
}

// ---------- 유틸 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const namuUrl = (t) => 'https://namu.wiki/w/' + encodeURIComponent(t);
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim();
// 닉네임 중복 확인용 키 (database.rules.json의 nicks 규칙과 같아야 함): 소문자, 띄어쓰기 없앰, 키에 못 쓰는 글자는 _
const nickKey = (n) => String(n || '').toLowerCase().replaceAll(' ', '').replace(/[.$#[\]/]/g, '_');
const nickOwner = async (n) => (await get(ref(db, `nicks/${nickKey(n)}`))).val();
// 다른 사람이 이 닉네임을 쓰는지: 닉네임 목록 + (목록에 아직 없는 예전 회원까지) 전체 회원 정보로 확인
async function nickTakenBy(n, myUid) {
  const owner = await nickOwner(n);
  if (owner && owner !== myUid) return true;
  const all = (await get(ref(db, 'users'))).val() || {};
  const key = nickKey(n);
  return Object.entries(all).some(([uid, u]) => uid !== myUid && u?.nick && nickKey(u.nick) === key);
}
// 닉네임 최대 길이 (실시간 순위 상자에 한 줄로 보이도록)
const NICK_MAX = 8;
const nickLen = (n) => n.length; // 입력칸·서버 규칙과 같은 방식으로 셈
function fmtTime(ms) {
  if (ms == null) return '-';
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
const fmtTimePrecise = (ms) => (ms == null ? '-' : `${fmtTime(ms)}.${Math.floor((ms % 1000) / 100)}`);
let toastTimer;
// Ant Design의 message처럼 화면 위쪽에 잠깐 뜨는 알림
const icon = (id, cls = '') => `<svg class="ic ${cls}"><use href="#i-${id}"/></svg>`;
const MSG_ICON = { info: ['info', 'var(--color-primary)'], success: ['check', 'var(--color-success)'], warning: ['warn', 'var(--color-warning)'], error: ['close', 'var(--color-error)'] };
function toast(msg, kind = 'info') {
  const el = $('#toast');
  const [id, color] = MSG_ICON[kind] || MSG_ICON.info;
  el.innerHTML = `<svg class="ic" style="color:${color}"><use href="#i-${id}"/></svg><span>${esc(msg)}</span>`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}
const modeLabel = (m) => ({ clicks: '최소 클릭', relay: '릴레이' }[m] || '타임어택');
const MODE_DESC = {
  time: '목표 문서에 가장 먼저 도착한 사람이 이기고, 그 순간 게임이 끝나요.',
  clicks: '가장 적은 클릭으로 도착한 사람이 이겨요. 클릭 수가 같으면 더 빨리 도착한 사람이 이겨요.',
  relay: '목표가 하나씩 공개돼요. 지금 목표에 도착해야 다음 목표가 나와요. 모든 목표를 가장 먼저 지나간 사람이 이기고, 그 순간 게임이 끝나요.',
};
const modeDesc = (m, winners = 1) => {
  const d = MODE_DESC[m] || MODE_DESC.time;
  return m !== 'clicks' && winners > 1 ? d.replace('그 순간 게임이 끝나요', `${winners}등까지 도착하면 게임이 끝나요`) : d;
};
// 이번 판의 목표 목록 (릴레이가 아니면 목표 1개)
const targetsOf = (r) => (Array.isArray(r?.targets) && r.targets.length ? r.targets : [r?.target]);
// 지금 쫓고 있는 목표 (릴레이는 도착한 만큼 다음 목표)
const legOf = (p) => Math.min(p?.leg || 0, targetsOf(room).length - 1);
const show = (screen) => $$('.screen').forEach((el) => el.classList.toggle('hidden', el.id !== 'screen-' + screen));
const isHost = () => room?.hostId === playerId;
const me = () => room?.players.find((p) => p.id === playerId);

// 서로 다른 키워드 n+1개 (시작 1개 + 목표 n개). 지난 판의 시작/마지막 목표와는 겹치지 않게
function pickKeywords(prev, n = 1) {
  const avoid = new Set(prev ? [prev.start, prev.target] : []);
  const pool = KEYWORDS.filter((k) => !avoid.has(k));
  const picked = [];
  while (picked.length < n + 1) {
    const k = pool[Math.floor(Math.random() * pool.length)];
    if (!picked.includes(k)) picked.push(k);
  }
  const [start, ...targets] = picked;
  return { start, targets, target: targets[targets.length - 1] };
}

function ranking(r) {
  const players = r.players.filter((p) => p.status && p.status !== 'waiting');
  const finished = players.filter((p) => p.status === 'finished');
  finished.sort((a, b) => (r.mode === 'clicks' ? a.clicks - b.clicks || a.elapsed - b.elapsed : a.elapsed - b.elapsed));
  const rest = players.filter((p) => p.status !== 'finished');
  // 릴레이: 아직 못 끝낸 사람은 더 많은 목표를, 더 빨리 지난 사람이 앞
  if (r.mode === 'relay') {
    const lastT = (p) => (p.legTimes?.length ? p.legTimes[p.legTimes.length - 1] : Infinity);
    rest.sort((a, b) => (a.status === 'gaveup') - (b.status === 'gaveup') || (b.leg || 0) - (a.leg || 0) || lastT(a) - lastT(b));
  }
  return [...finished, ...rest];
}

// 지금 화면 단계: lobby / countdown / playing / results
function phase() {
  if (!room) return 'home';
  if (room.state === 'playing') return now() < room.startAt ? 'countdown' : 'playing';
  return room.state;
}

// ---------- 방 입장/퇴장 ----------
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function setHomeError(msg) { $('#home-error').textContent = msg || ''; }

// 방 데이터 + 정리용 활동 기록(roomIndex)을 함께 만듦. rid는 방마다 다른 고유 번호
// (같은 4자리 코드가 나중에 다시 뽑혀도 예전 방과 구분하기 위해)
function createRoomData(code, data) {
  return update(ref(db), {
    [`rooms/${code}`]: { ...data, rid: newId() },
    [`roomIndex/${code}`]: { lastActive: serverTimestamp() },
  });
}

async function createRoom(name) {
  let code;
  for (let i = 0; i < 10; i++) {
    code = makeCode();
    if (!(await get(roomRef(code))).exists()) break;
  }
  await createRoomData(code, {
    hostId: playerId,
    mode: 'time',
    timeLimitMin: 0,
    state: 'lobby',
    round: 0,
    createdAt: serverTimestamp(),
    players: { [playerId]: { name, status: 'waiting', online: true, joinedAt: serverTimestamp(), char: myLook(), ...guestMark() } },
  });
  enterRoom(code);
}

async function joinRoom(code, name) {
  const snap = await get(roomRef(code));
  if (!snap.exists()) throw new Error('존재하지 않는 방 코드예요.');
  const players = snap.val().players || {};
  if (snap.val().kicked?.[playerId]) throw new Error('방장이 이 방에서 내보냈어요.');
  if (snap.val().closed) throw new Error('방장이 없앤 방이에요.');
  if (players[playerId]?.name) {
    const patch = { online: true, offlineSince: null, char: myLook() };
    if (name) patch.name = name;
    await update(roomRef(code, 'players', playerId), patch);
  } else {
    if (!name) throw new Error('닉네임을 입력해주세요.');
    if (Object.keys(players).length >= MAX_PLAYERS) throw new Error(`방이 가득 찼어요. (최대 ${MAX_PLAYERS}명)`);
    // 게임 도중에 들어오면 'waiting'(관전) 상태로 있다가 다음 판부터 참가
    const record = { name, status: 'waiting', online: true, joinedAt: serverTimestamp(), char: myLook(), ...guestMark() };
    if (snap.val().locked && snap.val().hostId !== playerId) await joinLocked(code, record);
    else {
      try {
        await set(roomRef(code, 'players', playerId), record);
      } catch (e) {
        // 서버가 막으면 비밀번호가 걸린 방일 수 있음 → 비밀번호를 물어봄
        if (!/permission.denied/i.test(`${e?.code} ${e?.message}`)) throw e;
        await joinLocked(code, record);
      }
    }
  }
  enterRoom(code);
}

// ---------- 방 비밀번호 (숫자 4자리) ----------
// 비밀번호는 roomPw/<코드>에 있고 방장만 읽을 수 있음. 들어오는 사람은 roomKeys/<코드>/<나>에 입력한 비밀번호를 쓰고,
// 서버 규칙이 둘이 같을 때만 방에 들어오게 함 (2초에 한 번만 시도 가능)
const ROOM_PW_RE = /^[0-9]{4}$/;
const ROOM_PW_GAP_MS = 2200;
let roomPwTriedAt = 0;
function askRoomPw(msg = '') {
  const dlg = $('#roompw-dialog');
  $('#roompw-input').value = '';
  $('#roompw-error').textContent = msg;
  dlg.showModal();
  $('#roompw-input').focus();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; $('#roompw-form').removeEventListener('submit', onSubmit); dlg.removeEventListener('close', onClose); resolve(v); };
    const onSubmit = (e) => {
      if (e.submitter?.value !== 'ok') return;
      e.preventDefault();
      const pw = $('#roompw-input').value.trim();
      if (!ROOM_PW_RE.test(pw)) { $('#roompw-error').textContent = '숫자 4자리를 입력해 주세요.'; return; }
      finish(pw);
      dlg.close();
    };
    const onClose = () => { if (!dlg.open) finish(null); }; // 앞서 닫힌 창의 늦게 온 'close' 신호는 무시
    $('#roompw-form').addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
  });
}
async function joinLocked(code, record) {
  let msg = '';
  for (;;) {
    const pw = await askRoomPw(msg);
    if (pw == null) throw new Error('비밀번호를 입력하지 않아서 방에 들어가지 않았어요.');
    // 너무 빨리 다시 시도하면 서버가 막으므로 잠깐 기다림
    const wait = roomPwTriedAt + ROOM_PW_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    roomPwTriedAt = Date.now();
    try {
      await update(ref(db), { [`roomKeys/${code}/${playerId}`]: { pw, at: serverTimestamp() }, [`rooms/${code}/players/${playerId}`]: record });
      return;
    } catch (e) {
      if (!/permission.denied/i.test(`${e?.code} ${e?.message}`)) throw e;
      msg = '비밀번호가 맞지 않아요. 다시 입력해 주세요.';
    }
  }
}
// 방장: 비밀번호 켜기·바꾸기·끄기
let roomPwShown = { code: null, pw: '' };
async function loadRoomPw() {
  if (!room || !isHost() || !room.locked) return;
  if (roomPwShown.code === room.code) return;
  roomPwShown = { code: room.code, pw: '' };
  const pw = (await get(ref(db, `roomPw/${room.code}`)).catch(() => null))?.val() || '';
  roomPwShown.pw = pw;
  if (document.activeElement !== $('#room-pw')) $('#room-pw').value = pw;
}
$('#room-lock').onclick = async () => {
  if (!isHost()) return;
  if (room.locked) {
    await update(ref(db), { [`rooms/${room.code}/locked`]: null, [`roomPw/${room.code}`]: null });
    roomPwShown = { code: null, pw: '' };
    $('#room-pw').value = '';
    toast('비밀번호를 껐어요. 이제 누구나 들어올 수 있어요.', 'info');
  } else {
    $('#room-pw-box').classList.remove('hidden');
    $('#room-pw').focus();
  }
};
$('#room-pw-save').onclick = async () => {
  if (!isHost()) return;
  const pw = $('#room-pw').value.trim();
  if (!ROOM_PW_RE.test(pw)) { toast('비밀번호는 숫자 4자리로 정해 주세요.', 'warning'); return; }
  try {
    await update(ref(db), { [`roomPw/${room.code}`]: pw, [`rooms/${room.code}/locked`]: true });
    roomPwShown = { code: room.code, pw };
    toast(`비밀번호를 ${pw}(으)로 정했어요. 들어올 사람에게 알려 주세요.`, 'success');
  } catch (e) {
    toast(/permission.denied/i.test(`${e?.code} ${e?.message}`) ? '비밀번호를 저장하지 못했어요. 데이터베이스 규칙을 다시 게시했는지 확인해 주세요.' : e.message, 'error');
  }
};
$('#room-pw').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4); });
$('#roompw-input').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4); });

function enterRoom(code) {
  currentCode = code;
  store.set('nr.room', code, ss);
  history.replaceState(null, '', '?room=' + code);
  setupPresence();
  unsubscribeRoom?.();
  unsubscribeRoom = onValue(roomRef(code), (snap) => {
    const v = snap.val();
    if (v?.closed) {
      const byMe = v.hostId === playerId;
      leaveLocal();
      if (v.closed === 'idle') toast(`${IDLE_CLOSE_MIN}분 동안 게임을 시작하지 않아서 방이 닫혔어요.`, 'warning');
      else toast(byMe ? '방을 없앴어요.' : '방장이 방을 없앴어요.', byMe ? 'success' : 'warning');
      return;
    }
    const kicked = !!v?.kicked?.[playerId];
    if (!v || !v.players?.[playerId]?.name || kicked) {
      leaveLocal();
      toast(kicked ? '방장이 방에서 내보냈어요.' : v ? '방에서 나왔어요.' : '방이 사라졌어요.', 'warning');
      return;
    }
    const prevPhase = phase();
    room = {
      code,
      ...cleanRoom(v),
      // 이름이 없는 항목은 내보낸 사람의 연결 끊김 기록이 남은 것이므로 무시
      players: Object.entries(v.players || {}).filter(([, p]) => p?.name).map(([id, p]) => cleanPlayer(id, p)),
    };
    room.ghosts = Object.entries(v.players || {}).filter(([id, p]) => !p?.name || v.kicked?.[id]).map(([id]) => id);
    if (prevPhase === 'countdown' && phase() === 'playing') toast('출발! 링크만 타고 목표 문서까지 가세요.', 'success');
    if ((prevPhase === 'countdown' || prevPhase === 'playing') && phase() === 'results') showEnd();
    announceArrivals();
    submitDailyIfDone();
    claimRoundRewards();
    recordQuestRound();
    render();
    maintain();
  });
}

// 게임이 끝나면 화면 가운데에 '게임 완료!' 알림
function showEnd() {
  const dlgEnd = $('#end-dialog');
  if (room.daily) {
    const mine = me();
    $('#end-winner').innerHTML = mine?.status === 'finished' ? `도전 완료! <b>${fmtTimePrecise(mine.elapsed)}</b>` : '도착하지 못했어요';
    const msg = dailyMsg.key === `${room.code}/${room.round}` ? dailyMsg.text : '기록을 확인하는 중…';
    $('#end-sub').textContent = mine?.status === 'finished' ? msg : '다시 도전해 보세요!';
    $('#end-podium').innerHTML = '';
    if (dlg.open) dlg.close();
    if (!$('#end-dialog').open) $('#end-dialog').showModal();
    return;
  }
  const finished = ranking(room).filter((p) => p.status === 'finished');
  const winner = finished[0];
  const myRank = finished.findIndex((p) => p.id === playerId) + 1;
  const score = (p) => (room.mode === 'clicks' ? `${p.clicks}클릭 · ${fmtTimePrecise(p.elapsed)}` : `${fmtTimePrecise(p.elapsed)} · ${p.clicks}클릭`);
  const mine = me();
  const myStage = mine?.status && mine.status !== 'finished' && room.mode === 'relay' ? `나는 ${mine.leg || 0}/${targetsOf(room).length}단계` : '';
  if (!winner) {
    $('#end-winner').textContent = '도착한 사람이 없어요';
    $('#end-sub').textContent = room.timeLimitMin ? '제한 시간이 끝났어요.' : '';
  } else if (myRank) {
    $('#end-winner').innerHTML = `축하해요! <b>${myRank}등</b>이에요 ${myRank === 1 ? '🎉' : '👏'}`;
    $('#end-sub').textContent = finished.length > 1 ? '' : score(winner);
  } else {
    $('#end-winner').innerHTML = `1등 <b>${esc(winner.name)}</b>`;
    $('#end-sub').textContent = finished.length > 1 ? myStage : [score(winner), myStage].filter(Boolean).join(' · ');
  }
  // 2명 이상 도착했으면 3등까지 순위 표시
  const medal = ['🥇', '🥈', '🥉'];
  $('#end-podium').innerHTML = finished.length > 1
    ? finished.slice(0, 3).map((p, i) => `<li class="${p.id === playerId ? 'me' : ''}"><span>${medal[i]}</span><span class="nm">${esc(p.name)}</span><span class="sc">${score(p)}</span></li>`).join('')
    : '';
  if (dlg.open) dlg.close();
  if (!dlgEnd.open) dlgEnd.showModal();
}

// 릴레이 단계 표시: 지난 목표는 초록 점, 지금 찾는 목표는 파란 테두리
function legDots(p, total) {
  const leg = p.status === 'finished' ? total : p.leg || 0;
  const dots = Array.from({ length: total }, (_, i) => `<i class="${i < leg ? 'on' : i === leg && p.status === 'playing' ? 'cur' : ''}"></i>`).join('');
  return `<span class="legs" title="${leg}/${total}단계">${dots}</span>`;
}

// 게임 화면에서도 다른 사람이 도착하면 알림
let arrivalsSeen = { key: null, ids: new Set() };
function announceArrivals() {
  const key = raceKey();
  const finished = room.players.filter((p) => p.status === 'finished');
  const legs = new Map(room.players.map((p) => [p.id, p.leg || 0]));
  if (arrivalsSeen.key !== key) {
    arrivalsSeen = { key, ids: new Set(finished.map((p) => p.id)), legs };
    return;
  }
  if (room.state !== 'playing') return;
  // 릴레이: 다른 사람이 중간 목표를 지나면 알림
  if (room.mode === 'relay') {
    const total = targetsOf(room).length;
    for (const p of room.players) {
      const leg = p.leg || 0;
      if (p.id !== playerId && p.status === 'playing' && leg > (arrivalsSeen.legs.get(p.id) || 0) && leg < total) {
        toast(`${p.name}님이 ${leg}번째 목표를 지났어요! (${leg}/${total})`, 'info');
      }
    }
    arrivalsSeen.legs = legs;
  }
  for (const p of finished) {
    if (arrivalsSeen.ids.has(p.id)) continue;
    arrivalsSeen.ids.add(p.id);
    if (p.id !== playerId) toast(`${p.name}님 도착! (${fmtTimePrecise(p.elapsed)} · ${p.clicks}클릭)`, 'success');
  }
}

// 접속 상태 표시: 연결이 끊기면 서버가 자동으로 online=false 처리
function setupPresence() {
  if (!currentCode) return;
  onDisconnect(roomRef(currentCode, 'players', playerId, 'online')).set(false);
  onDisconnect(roomRef(currentCode, 'players', playerId, 'offlineSince')).set(serverTimestamp());
}
onValue(ref(db, '.info/connected'), async (s) => {
  if (!s.val() || !currentCode) return;
  setupPresence();
  const snap = await get(roomRef(currentCode, 'players', playerId));
  if (snap.exists()) update(roomRef(currentCode, 'players', playerId), { online: true, offlineSince: null });
});

async function leaveRoom() {
  const code = currentCode;
  const r = room;
  leaveLocal();
  if (!code) return;
  const others = (r?.players || []).filter((p) => p.id !== playerId);
  if (others.length === 0) {
    await update(ref(db), { [`rooms/${code}`]: null, [`lobbies/${code}`]: null, [`roomIndex/${code}`]: null, [`roomPw/${code}`]: null, [`roomKeys/${code}`]: null });
    return;
  }
  const updates = { [`players/${playerId}`]: null };
  if (r.hostId === playerId) updates.hostId = (others.find((p) => p.online) || others[0]).id;
  await update(roomRef(code), updates);
}

function leaveLocal() {
  showReadyBar(false);
  unsubscribeRoom?.();
  unsubscribeRoom = null;
  if (currentCode) {
    onDisconnect(roomRef(currentCode, 'players', playerId, 'online')).cancel();
    onDisconnect(roomRef(currentCode, 'players', playerId, 'offlineSince')).cancel();
  }
  room = null;
  currentCode = null;
  store.del('nr.room', ss);
  history.replaceState(null, '', location.pathname);
  if ($('#arrive-dialog').open) $('#arrive-dialog').close();
  plaza?.pause();
  showHome();
}

// ---------- 방장 동작 ----------
function startRound() {
  if (!isHost()) return;
  if (!extOk()) { toast(extMsg(), 'warning'); return; }
  if (!room.daily && !allReady()) { toast(`아직 준비하지 않은 사람이 있어요: ${notReady().map((p) => p.name).join(', ')}`, 'warning'); return; }
  const relay = room.mode === 'relay';
  const picked = room.daily?.start ? { ...room.daily, target: room.daily.targets[room.daily.targets.length - 1] }
    : pickKeywords(room.round ? room : null, relay ? (room.legs || 2) : 1);
  const { start } = picked;
  let { target, targets } = picked;
  // 릴레이 '시작 문서로 돌아오기': 마지막 목표로 시작 문서를 한 번 더 넣음
  if (relay && room.roundTrip) { targets = [...targets, start]; target = start; }
  const updates = {
    state: 'playing',
    round: (room.round || 0) + 1,
    start,
    target,
    targets: relay ? targets : null,
    startAt: now() + COUNTDOWN_MS,
  };
  for (const p of room.players) {
    // 연결이 끊긴 사람은 이번 판에서 제외 (안 그러면 게임이 끝나지 않음)
    updates[`players/${p.id}/status`] = p.online ? 'playing' : 'waiting';
    updates[`players/${p.id}/elapsed`] = null;
    updates[`players/${p.id}/clicks`] = null;
    updates[`players/${p.id}/path`] = null;
    updates[`players/${p.id}/steps`] = null;
    updates[`players/${p.id}/violations`] = null;
    updates[`players/${p.id}/auto`] = null;
    updates[`players/${p.id}/leg`] = null;
    updates[`players/${p.id}/hints`] = null;
    updates[`players/${p.id}/dq`] = null;
    updates[`players/${p.id}/ready`] = null; // 새 판이 시작되면 준비가 풀림
    updates[`players/${p.id}/away`] = null;
    updates[`players/${p.id}/returns`] = null;
    updates[`players/${p.id}/legTimes`] = null;
  }
  update(roomRef(room.code), updates);
}

// 방장: 참가자 내보내기 (다시 들어오지 못하게 kicked에 기록)
function kickPlayer(id) {
  const p = room?.players.find((x) => x.id === id);
  if (!isHost() || !p || id === playerId) return;
  if (!confirm(`${p.name}님을 방에서 내보낼까요?`)) return;
  update(roomRef(room.code), { [`players/${id}`]: null, [`kicked/${id}`]: true })
    .then(() => toast(`${p.name}님을 내보냈어요.`, 'success'));
}
for (const sel of ['#lobby-players', '#play-players']) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('[data-kick]');
    if (b) kickPlayer(b.dataset.kick);
  });
}

function endRound() {
  if (room?.state === 'playing') update(roomRef(room.code), { state: 'results', endedAt: serverTimestamp() });
}

// 누구나 실행해도 결과가 같은(멱등) 정리 작업: 라운드 종료, 방장 넘기기
// 방장은 시작 화면의 '열려 있는 방' 목록에 방 요약을 올림 (30초마다 갱신)
const LOBBY_BEAT_MS = 30 * 1000;
const LOBBY_FRESH_MS = 90 * 1000; // 이 시간 동안 갱신이 없으면 목록에서 숨김
let lobbySent = { key: null, at: 0 };
function publishLobby() {
  if (!room || !isHost()) return;
  const lobbyRef = ref(db, `lobbies/${room.code}`);
  if (room.public === false) {
    if (lobbySent.key !== 'hidden') { lobbySent = { key: 'hidden', at: Date.now() }; remove(lobbyRef).catch(() => {}); }
    return;
  }
  const host = room.players.find((p) => p.id === room.hostId);
  const summary = {
    name: host?.name || '',
    e: host ? charOf(host).e : '',
    a: host ? charOf(host).a : '',
    count: room.players.length,
    state: room.state,
    mode: room.mode,
    locked: room.locked ? true : null,
  };
  const key = JSON.stringify(summary);
  if (key === lobbySent.key && Date.now() - lobbySent.at < LOBBY_BEAT_MS) return;
  lobbySent = { key, at: Date.now() };
  set(lobbyRef, { ...summary, updatedAt: serverTimestamp() }).catch((e) => console.warn('[방 목록]', e.message));
}

// 게임을 시작하지 않고 30분이 지나면 방을 자동으로 닫음 (방을 만든 뒤, 또는 마지막 판이 끝난 뒤부터)
const IDLE_CLOSE_MIN = 30;
const IDLE_WARN_MIN = 5; // 닫히기 몇 분 전부터 안내
let idleClosing = null;
const idleSince = (r) => Math.max(r.createdAt || 0, r.startAt || 0, r.endedAt || 0);
function idleLeftMs() {
  if (!room || room.state === 'playing') return Infinity;
  const since = idleSince(room);
  if (!since) return Infinity;
  return since + IDLE_CLOSE_MIN * 60000 - now();
}
function checkIdle() {
  const left = idleLeftMs();
  // 안내: 닫히기 5분 전부터 대기실·결과 화면에
  const warn = left <= IDLE_WARN_MIN * 60000;
  const mins = Math.max(1, Math.ceil(left / 60000));
  $$('.idle-warn').forEach((el) => {
    el.classList.toggle('hidden', !warn);
    if (warn) el.querySelector('span').textContent = `${mins}분 안에 게임을 시작하지 않으면 방이 자동으로 닫혀요.`
      + (isHost() ? ' 게임을 시작하면 다시 30분이 늘어나요.' : ' 방장에게 시작해 달라고 말해 보세요!');
  });
  if (left <= 0 && isHost() && idleClosing !== room.code) {
    idleClosing = room.code;
    destroyRoom('idle').catch((e) => { console.warn('[자동 닫기]', e); idleClosing = null; });
  }
}

let roomBeat = { code: null, at: 0 };
function maintain() {
  if (!room) return;
  publishLobby();
  checkIdle();
  // 방장이 1분마다 '마지막 활동 시각' 갱신 → 2시간 넘게 활동 없는 방은 자동 정리
  if (isHost() && (roomBeat.code !== room.code || Date.now() - roomBeat.at > 60 * 1000)) {
    roomBeat = { code: room.code, at: Date.now() };
    set(ref(db, `roomIndex/${room.code}`), { lastActive: serverTimestamp() }).catch(() => {});
  }
  cleanupGoneGuests();
  if (isHost() && room.ghosts?.length) {
    const fix = {};
    for (const id of room.ghosts) fix[`players/${id}`] = null;
    update(roomRef(room.code), fix);
  }
  if (room.state === 'playing' && now() >= room.startAt) {
    const allDone = !room.players.some((p) => p.status === 'playing');
    const timeUp = room.timeLimitMin > 0 && now() >= room.startAt + room.timeLimitMin * 60000;
    // 타임어택·릴레이는 설정한 등수(1~3등)까지 순위가 확정되면 게임 종료
    // (힌트 페널티가 붙은 기록은 그 시간이 실제로 지나야 확정 → hintWait)
    const fin = room.mode !== 'clicks' ? podiumFinishers() : [];
    const winner = fin.length >= (room.winners || 1) && !hintWait();
    if (allDone || timeUp || winner) endRound();
  }
  const host = room.players.find((p) => p.id === room.hostId);
  const hostGone = !host || (!host.online && now() - (host.offlineSince || 0) > HOST_TIMEOUT_MS);
  if (hostGone) {
    // 접속 중인 사람 중 가장 먼저 들어온 사람이 방장을 이어받음
    const next = room.players.filter((p) => p.online).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
    if (next?.id === playerId) {
      const oldHost = room.hostId;
      runTransaction(roomRef(room.code, 'hostId'), (cur) => (cur === oldHost ? playerId : undefined));
    }
  }
}

// ---------- 시작 화면: 열려 있는 방 ----------
let lobbies = {};
let unsubLobbies = null;
let lobbyTimer = null;
function watchLobbies() {
  if (unsubLobbies) return;
  unsubLobbies = onValue(ref(db, 'lobbies'), (snap) => {
    lobbies = snap.val() || {};
    renderLobbies();
  }, (err) => {
    console.warn('[방 목록]', err.message);
    unsubLobbies = null;
    $('#open-rooms').innerHTML = '<li class="empty">방 목록을 불러오지 못했어요. 방 코드로 참가해 주세요.</li>';
  });
  lobbyTimer = setInterval(renderLobbies, 15000); // 오래된 방이 목록에서 사라지도록
}
function unwatchLobbies() {
  unsubLobbies?.();
  unsubLobbies = null;
  clearInterval(lobbyTimer);
}
const STATE_TAG = {
  lobby: '<span class="tag tag-success">대기 중</span>',
  playing: '<span class="tag tag-processing">게임 중</span>',
  results: '<span class="tag tag-warning">결과 보는 중</span>',
};
function renderLobbies() {
  const t = now();
  const all = Object.entries(lobbies);
  // 하루 넘게 방치된 항목은 정리
  for (const [code, l] of all) if (t - (l?.updatedAt || 0) > 24 * 3600 * 1000) remove(ref(db, `lobbies/${code}`)).catch(() => {});
  const open = all
    .filter(([, l]) => l && t - (l.updatedAt || 0) < LOBBY_FRESH_MS && l.count > 0)
    .sort(([, a], [, b]) => (a.state === 'lobby' ? 0 : 1) - (b.state === 'lobby' ? 0 : 1) || (b.updatedAt || 0) - (a.updatedAt || 0));
  $('#open-rooms-count').textContent = open.length ? `${open.length}개` : '';
  $('#open-rooms').innerHTML = open.length
    ? open.map(([code, l]) => {
      const full = l.count >= MAX_PLAYERS;
      // 방장이 지금 쓰는 캐릭터 (방장 화면이 예전 버전이어도 보이도록 직접 읽어 옴)
      const a = animalOf(userAnimal(roomHost(code, renderLobbies), renderLobbies))?.id || animalOf(l.a)?.id;
      const face = a
        ? `<span class="avatar avatar-animal"><img src="${animalImg(a, 'icon')}" alt="${animalOf(a).label}"></span>`
        : '<span class="avatar avatar-animal"></span>';
      return `<li>${face}`
        + `<div class="info"><span class="title">${l.locked ? '<span class="lock" title="비밀번호가 걸린 방">🔒</span>' : ''}${esc(maskBad(l.name || '이름 없음'))}님의 방</span>`
        + `<span class="meta">${STATE_TAG[l.state] || ''}<span class="tag">${esc(modeLabel(l.mode))}</span>${l.count}명 · ${code}</span></div>`
        + `<button class="btn btn-primary" data-join="${esc(code)}" ${full ? 'disabled' : ''}>${full ? '가득 참' : '참가하기'}</button></li>`;
    }).join('')
    : '<li class="empty">지금 열려 있는 방이 없어요. 방을 만들어 보세요!</li>';
}
$('#open-rooms').addEventListener('click', (e) => {
  const b = e.target.closest('[data-join]');
  if (!b) return;
  const name = getName();
  if (name) guarded(b, () => joinRoom(b.dataset.join, name));
});

// ---------- 오늘의 챔피언 ----------
// 한국 시간 기준 날짜 (예: 2026-11-05)
const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
// 날짜로 정해지는 난수 → 같은 날엔 누구나 같은 문제
function seededPick(seed, n) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rand = () => {
    h = (h + 0x6D2B79F5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  while (out.length < n) {
    const k = KEYWORDS[Math.floor(rand() * KEYWORDS.length)];
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
const dailyRef = (date, ...rest) => ref(db, ['daily', date, ...rest].join('/'));
// 오늘의 문제: 처음 본 사람이 DB에 고정 (키워드 목록이 바뀌어도 그날 문제는 그대로)
async function ensureDailyPuzzle(date) {
  const [start, t1, t2] = seededPick(`namu-race/${date}`, 3);
  const res = await runTransaction(dailyRef(date, 'puzzle'), (cur) => cur || { start, targets: [t1, t2] });
  return res.snapshot.val();
}

let daily = { date: null, puzzle: null, best: {}, unsub: [] };
function watchDaily() {
  const date = todayKey();
  if (daily.date === date && daily.unsub.length) return;
  unwatchDaily();
  daily = { date, puzzle: null, best: {}, unsub: [] };
  $('#daily-date').textContent = date.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => `${Number(m)}월 ${Number(d)}일`);
  ensureDailyPuzzle(date).catch((e) => console.warn('[오늘의 챔피언]', e.message));
  const fail = (e) => {
    console.warn('[오늘의 챔피언]', e.message);
    $('#daily-route').textContent = '오늘의 문제를 불러오지 못했어요.';
    $('#btn-daily').disabled = true;
  };
  daily.unsub.push(onValue(dailyRef(date, 'puzzle'), (s) => { daily.puzzle = s.val(); renderDaily(); }, fail));
  daily.unsub.push(onValue(dailyRef(date, 'best'), (s) => { daily.best = s.val() || {}; lookCache.clear(); renderDaily(); }, fail));
}
function unwatchDaily() {
  daily.unsub.forEach((u) => u());
  daily.unsub = [];
}
function dailyRanking() {
  return Object.entries(daily.best || {})
    .filter(([, r]) => typeof r?.ms === 'number')
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => a.ms - b.ms || (a.at || 0) - (b.at || 0));
}
// 오늘의 챔피언 옆 캐릭터: 그 사람이 지금 쓰는 동물 (계정에서 읽어 옴, 한 번 읽으면 기억)
// 다른 사람 정보를 한 번 읽으면 1분 동안 기억 (읽는 중이면 null, 다 읽으면 onLoaded로 다시 그림)
const LOOKUP_MS = 60 * 1000;
function cachedLookup(cache, key, path, pick, onLoaded) {
  if (key == null) return null;
  const c = cache.get(key);
  if (c && (c.loading || Date.now() - c.at < LOOKUP_MS)) return c.val;
  cache.set(key, { loading: true, val: c?.val ?? null, at: 0 });
  get(ref(db, path))
    .then((s) => { cache.set(key, { val: pick(s.val()), at: Date.now() }); onLoaded?.(); })
    .catch(() => cache.set(key, { val: c?.val ?? null, at: Date.now() }));
  return c?.val ?? null;
}
const lookCache = new Map(); // uid → 동물 id
const hostCache = new Map(); // 방 코드 → 방장 uid
function userAnimal(uid, onLoaded) {
  if (uid && uid === playerId && profile) return myLook().a;
  return cachedLookup(lookCache, uid, `users/${uid}/look/a`, (v) => animalOf(v)?.id || 'cat', onLoaded);
}
const roomHost = (code, onLoaded) => cachedLookup(hostCache, code, `rooms/${code}/hostId`, (v) => v || null, onLoaded);
// 오늘의 챔피언 옆 캐릭터: 그 사람이 지금 쓰는 동물
function championFace(r) {
  const id = animalOf(userAnimal(r.id, renderDaily))?.id;
  if (id) return `<img class="face" src="${animalImg(id, 'icon')}" alt="${animalOf(id).label}">`;
  return '<span class="face"></span>';
}
function renderDaily() {
  renderQuests();
  const pz = daily.puzzle;
  $('#btn-daily').disabled = !pz;
  const lock = `<span class="lock">${icon('lock')}공개 전</span>`;
  $('#daily-route').innerHTML = pz
    ? `<span>${esc(pz.start)}</span>${icon('right', 'sep')}${lock}${icon('right', 'sep')}${lock}`
    : '불러오는 중…';
  const list = dailyRanking();
  const medal = ['🥇', '🥈', '🥉'];
  $('#daily-top').innerHTML = list.length
    ? list.slice(0, 3).map((r, i) => `<li class="${r.id === playerId ? 'me' : ''}"><span class="md">${medal[i]}</span>`
      + `${championFace(r)}<span class="nm">${esc(maskBad(r.name))}</span><span class="tm">${fmtTimePrecise(r.ms)}</span></li>`).join('')
    : '<li class="empty">아직 기록이 없어요. 첫 챔피언이 되어 보세요!</li>';
  const myIdx = list.findIndex((r) => r.id === playerId);
  $('#daily-mine').textContent = myIdx >= 0 ? `내 최고 기록 ${fmtTimePrecise(list[myIdx].ms)} · ${list.length}명 중 ${myIdx + 1}등` : '';
}

// 도전하기: 나 혼자 쓰는 비공개 릴레이 방을 만들고 바로 시작
async function startDaily(name) {
  const date = todayKey();
  const pz = daily.puzzle?.start ? daily.puzzle : await ensureDailyPuzzle(date);
  let code;
  for (let i = 0; i < 10; i++) {
    code = makeCode();
    if (!(await get(roomRef(code))).exists()) break;
  }
  await createRoomData(code, {
    hostId: playerId,
    mode: 'relay',
    legs: 2,
    timeLimitMin: 0,
    state: 'lobby',
    round: 0,
    public: false,
    daily: { date, start: pz.start, targets: pz.targets },
    createdAt: serverTimestamp(),
    players: { [playerId]: { name, status: 'waiting', online: true, joinedAt: serverTimestamp(), char: myLook(), ...guestMark() } },
  });
  dailyAutoStart = code;
  enterRoom(code);
}
let dailyAutoStart = null;
let dailySubmitted = null;
let dailyMsg = { key: null, text: '' }; // 기록 저장 결과 (게임 완료 창에 표시)

// 내가 도착하면 오늘의 기록에 저장 (더 빠를 때만 갱신)
function submitDailyIfDone() {
  if (dailyAutoStart && room?.code === dailyAutoStart && room.state === 'lobby' && isHost()) {
    dailyAutoStart = null;
    startRound();
    return;
  }
  const my = me();
  if (!room?.daily || my?.status !== 'finished') return;
  const key = `${room.code}/${room.round}`;
  if (dailySubmitted === key) return;
  dailySubmitted = key;
  const setSub = (text) => {
    dailyMsg = { key, text };
    if ($('#end-dialog').open && room?.daily) $('#end-sub').textContent = text;
  };
  if (!my.auto) { setTimeout(() => setSub('수동 기록은 오늘의 챔피언 순위에 오르지 않아요. 확장 프로그램으로 도전해 주세요.'), 300); return; }
  if (my.violations) { setTimeout(() => setSub(`링크 클릭이 아닌 이동이 ${my.violations}번 있어서 순위에 오르지 않았어요.`), 300); return; }
  const ms = my.elapsed;
  let improved = false;
  let prev = null;
  runTransaction(dailyRef(room.daily.date, 'best', playerId), (cur) => {
    prev = cur?.ms ?? null;
    if (cur && typeof cur.ms === 'number' && cur.ms <= ms) { improved = false; return undefined; }
    improved = true;
    return { name: my.name, e: charOf(my).e, ms, clicks: my.clicks ?? null, at: serverTimestamp() };
  }).then(async () => {
    const snap = await get(dailyRef(room?.daily?.date || todayKey(), 'best'));
    const all = Object.entries(snap.val() || {}).map(([id, r]) => ({ id, ...r })).sort((a, b) => a.ms - b.ms);
    const rank = all.findIndex((r) => r.id === playerId) + 1;
    setSub(improved
      ? `${prev == null ? '첫 기록 저장!' : `기록 갱신! (이전 ${fmtTimePrecise(prev)})`} 오늘 ${all.length}명 중 ${rank}등`
      : `최고 기록 ${fmtTimePrecise(prev)}보다 느려서 갱신되지 않았어요. 지금 ${rank}등`);
  }).catch((e) => setSub(`기록을 저장하지 못했어요. (${e.message})`));
}

$('#btn-daily').onclick = (e) => {
  if (!extOk()) { toast(extMsg(), 'warning'); return; }
  const name = getName();
  if (name) guarded(e.currentTarget, () => startDaily(name));
};

// ---------- 홈 이벤트 ----------
// 게임에서 쓰는 이름 = 회원 닉네임
function getName() {
  if (!profile?.approved) { setHomeError('로그인이 필요해요.'); return null; }
  return profile.nick;
}
async function guarded(btn, fn) {
  btn.disabled = true;
  setHomeError('');
  try { await fn(); }
  catch (e) {
    console.error(e);
    setHomeError(/permission.denied/i.test(`${e.code} ${e.message}`) ?'데이터베이스 권한이 없어요. 규칙 설정을 확인해주세요.' : e.message || '오류가 발생했어요.');
  } finally { btn.disabled = false; }
}
$('#btn-create').onclick = (e) => {
  const name = getName();
  if (name) guarded(e.currentTarget, () => createRoom(name));
};
function joinInvite() {
  const name = getName();
  if (name && inviteCode) guarded($('#btn-invite'), () => joinRoom(inviteCode, name));
}
$('#btn-invite').onclick = joinInvite;

$$('.btn-leave').forEach((b) => (b.onclick = () => {
  const racing = room?.state === 'playing' && me()?.status === 'playing';
  if (confirm(racing ? '게임 중이에요. 나가면 이번 판 기록이 남지 않아요. 방에서 나갈까요?' : '방에서 나갈까요?')) leaveRoom();
}));
// 방장: 방 없애기 (모든 참가자가 방에서 나가고 방이 지워짐)
$$('.btn-destroy').forEach((b) => (b.onclick = () => {
  if (!isHost()) return;
  if (confirm('방을 없앨까요?\n모든 참가자가 방에서 나가게 되고, 되돌릴 수 없어요.')) destroyRoom().catch((e) => { console.error(e); toast('방을 없애지 못했어요.', 'error'); });
}));
async function destroyRoom(reason = 'host') {
  const code = currentCode;
  if (!code || !isHost()) return;
  // 먼저 '없앰' 표시 → 모든 참가자 화면이 방에서 나감, 그다음 방을 지움
  await update(ref(db), { [`rooms/${code}/closed`]: reason === 'idle' ? 'idle' : true, [`lobbies/${code}`]: null });
  // 다른 사람들이 '없앰' 표시를 받을 시간을 잠깐 준 뒤 지움
  await new Promise((r) => setTimeout(r, 1500));
  await update(ref(db), { [`rooms/${code}`]: null, [`roomIndex/${code}`]: null, [`roomPw/${code}`]: null, [`roomKeys/${code}`]: null });
}

// ---------- 로비 이벤트 ----------
$$('#mode-seg button').forEach((b) => (b.onclick = () => isHost() && update(roomRef(room.code), { mode: b.dataset.mode })));
$('#time-limit').onchange = (e) => isHost() && update(roomRef(room.code), { timeLimitMin: Number(e.target.value) });
$('#public-room').onclick = () => isHost() && update(roomRef(room.code), { public: room.public === false });
$('#winners').onchange = (e) => isHost() && update(roomRef(room.code), { winners: Number(e.target.value) });
$('#legs').onchange = (e) => isHost() && update(roomRef(room.code), { legs: Number(e.target.value) });
$('#round-trip').onclick = () => isHost() && update(roomRef(room.code), { roundTrip: !room.roundTrip });

// ---------- 준비(레디) ----------
// 방장이 아닌 접속 중인 사람이 모두 준비해야 방장이 게임을 시작할 수 있음. 새 판이 시작되면 준비가 풀림
const AUTO_READY_KEY = 'nr.autoReady';
const autoReady = () => store.get(AUTO_READY_KEY) === '1';
const mustReady = () => (room?.players || []).filter((p) => p.id !== room.hostId && p.online);
const notReady = () => mustReady().filter((p) => !p.ready);
const allReady = () => notReady().length === 0;
let readySending = false;
function setReady(on) {
  if (!room || !me() || isHost() || readySending) return;
  if (on && !extOk()) { toast(extMsg(), 'warning'); return; }
  readySending = true;
  update(roomRef(room.code, 'players', playerId), { ready: on ? true : null })
    .catch((e) => console.warn('[준비]', e.message))
    .finally(() => { readySending = false; });
}
function renderReady() {
  const ph = phase();
  if (!room || (ph !== 'lobby' && ph !== 'results')) return;
  const host = isHost();
  const my = me();
  // 자동 준비: 대기실·결과 화면에서 준비가 안 되어 있으면 바로 준비
  if (!host && my && !my.ready && autoReady() && extOk()) setReady(true);
  const need = mustReady();
  const waiting = notReady();
  const done = need.length - waiting.length;
  const ok = allReady();
  const bar = $('#ready-bar');
  showReadyBar(true);
  bar.querySelector('.ready-count').textContent = need.length ? `준비 ${done} / ${need.length}명` : '함께할 사람을 기다리는 중';
  bar.querySelector('.ready-wait').textContent = !extOk() ? (ext.ready ? `확장 프로그램을 새 버전(${EXT_MIN})으로 다시 설치해야 참가할 수 있어요.` : '자동 기록 확장 프로그램이 있어야 참가할 수 있어요.')
    : waiting.length ? `아직: ${waiting.map((p) => p.name).join(', ')}` : need.length ? '모두 준비 완료!' : '';
  bar.classList.toggle('no-ext', !extOk());
  bar.classList.toggle('all', need.length > 0 && ok);
  // 참가자: 준비 버튼 + 자동 준비
  const btn = bar.querySelector('.ready-btn');
  const on = !!my?.ready;
  btn.classList.toggle('hidden', host);
  bar.querySelector('.ready-auto').classList.toggle('hidden', host);
  btn.textContent = on ? '✓ 준비 완료' : extOk() ? '준비하기' : ext.ready ? '확장 프로그램 업데이트 필요' : '확장 프로그램 필요';
  btn.title = on ? '한 번 더 누르면 준비를 취소해요' : extOk() ? '' : extMsg();
  btn.classList.toggle('btn-primary', !on);
  btn.classList.toggle('btn-success', on);
  bar.querySelector('.ready-auto-input').checked = autoReady();
  // 방장: 시작 버튼 (모두 준비해야 켜짐)
  const start = bar.querySelector('.ready-start');
  start.classList.toggle('hidden', !host);
  start.innerHTML = ph === 'lobby' ? `${icon('play')}게임 시작` : `${icon('redo')}${room.daily ? '다시 도전' : '다음 판'}`;
  start.disabled = !extOk() || (!ok && !room.daily);
  start.title = !extOk() ? extMsg() : start.disabled ? '모두 준비해야 시작할 수 있어요.' : '';
  // 방장: 모두 준비해야 시작 가능
  for (const id of ['#btn-start', '#btn-again']) {
    const b = $(id);
    if (!b) continue;
    b.disabled = host && (!extOk() || (!ok && !room.daily));
    b.title = !b.disabled ? '' : !extOk() ? extMsg() : '모두 준비해야 시작할 수 있어요.';
  }
}
function showReadyBar(on) {
  $('#ready-bar').classList.toggle('hidden', !on);
  document.body.classList.toggle('has-ready-bar', on);
}
$$('.ready-btn').forEach((b) => (b.onclick = () => setReady(!me()?.ready)));
$('#ready-bar .ready-start').onclick = () => startRound();
$$('.ready-auto-input').forEach((c) => (c.onchange = (e) => {
  store.set(AUTO_READY_KEY, e.target.checked ? '1' : '0');
  if (e.target.checked && me() && !me().ready) setReady(true);
  renderReady();
}));

$('#btn-start').onclick = startRound;
$('#btn-copy').onclick = async () => {
  const url = location.origin + location.pathname + '?room=' + room.code;
  try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요!', 'success'); }
  catch { prompt('이 링크를 복사해서 보내세요', url); }
};

// ---------- 대기실 광장 이벤트 ----------
$('#btn-char').onclick = (e) => {
  const open = $('#char-picker').classList.toggle('hidden') === false;
  e.currentTarget.setAttribute('aria-expanded', String(open));
  e.currentTarget.textContent = open ? '닫기' : '내 캐릭터 고르기';
};
$('#char-picker').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled || !room || !me()) return;
  if (b.dataset.a) equip({ a: b.dataset.a });
  else if (b.dataset.acc) toggleAcc(b.dataset.acc);
});
let lastChatAt = 0;
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  if (sendChat(input.value)) input.value = '';
});
// 채팅 보내기 (대기실 채팅창, 나무위키 탭의 채팅창 공용). 보냈으면 true
function sendChat(raw) {
  const text = maskBad(String(raw || '').replace(/\s+/g, ' ').trim()).slice(0, 100); // 부적절한 단어는 ***로
  if (!text || !room || !me()) return false;
  if (Date.now() - lastChatAt < 600) return false; // 도배 방지
  lastChatAt = Date.now();
  push(roomRef(room.code, 'chat'), { pid: playerId, name: me().name, e: charOf(me()).e, text, t: serverTimestamp() });
  // 오래된 대화는 정리 (최근 60개만 남김)
  const all = chatList();
  if (all.length > 80) {
    const old = {};
    for (const m of all.slice(0, all.length - 60)) old[`chat/${m.id}`] = null;
    update(roomRef(room.code), old);
  }
  return true;
}

// ---------- 게임 이벤트 ----------
$('#btn-giveup').onclick = () => {
  if (confirm('정말 포기할까요?') && me()?.status === 'playing') update(roomRef(room.code, 'players', playerId), { status: 'gaveup' });
};
$('#btn-end').onclick = () => confirm('게임을 끝내고 결과를 볼까요?') && endRound();
$('#btn-again').onclick = startRound;
$('#btn-lobby').onclick = () => {
  if (!isHost()) return;
  const updates = { state: 'lobby' };
  for (const p of room.players) updates[`players/${p.id}/status`] = 'waiting';
  update(roomRef(room.code), updates);
};

// 게임이 시작되면 시작 문서를 새 탭에서 자동으로 열기 (판마다 한 번, 새로고침해도 다시 열지 않음)
// - 확장 프로그램이 있으면 확장 프로그램이 레이스 탭을 열어서 팝업 차단에 걸리지 않음
// - 없으면 브라우저가 팝업을 막을 수 있어서, 막히면 버튼을 누르라고 안내
function autoOpenStart() {
  const key = raceKey();
  if (!key || store.get('nr.autoOpened', ss) === key) return;
  store.set('nr.autoOpened', key, ss);
  if (ext.ready) {
    if (extRaceIsCurrent() && ext.race.hasTab) return; // 이미 레이스 탭이 있음
    syncExt();
    toExt('OPEN_START');
    return;
  }
  const w = window.open(namuUrl(room.start), '_blank');
  if (!w) toast('브라우저가 새 창을 막았어요. 아래 "나무위키에서 열기"를 눌러주세요.', 'warning');
}

// 확장 프로그램이 있으면 확장 프로그램이 '레이스 탭'을 열어서 그 탭의 이동만 기록
$('#play-start-link').addEventListener('click', (e) => {
  if (!ext.ready) return;
  e.preventDefault();
  syncExt();
  toExt('OPEN_START');
});

const dlg = $('#arrive-dialog');
const pathArea = $('#arrive-path');
const parsePath = () => pathArea.value.split('\n').map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 100);
const updateArriveCount = () => { $('#arrive-count').textContent = `총 ${parsePath().length + 1}클릭`; };
pathArea.addEventListener('input', updateArriveCount);
$('#btn-arrive').onclick = () => {
  const t = now(); // 기록 시간은 이 버튼을 누른 순간 기준
  const my = me();
  const targets = targetsOf(room);
  const leg = my?.leg || 0;
  // 릴레이의 중간 목표: 확인만 받고 다음 목표 공개
  if (room.mode === 'relay' && leg < targets.length - 1) {
    if (!confirm(`'${targets[leg]}' 문서에 도착했나요?`) || me()?.status !== 'playing') return;
    update(roomRef(room.code, 'players', playerId), {
      leg: leg + 1,
      legTimes: [...(my.legTimes || []), Math.max(0, t - room.startAt)],
      auto: false,
    });
    toast(`${leg + 1}번째 목표 도착! 다음 목표: ${targets[leg + 1]}`, 'success');
    return;
  }
  arrivedAt = t;
  $('#arrive-start').textContent = room.start;
  $('#arrive-target').textContent = room.target;
  $('#arrive-error').textContent = '';
  $('#arrive-clicks-note').textContent = {
    clicks: '최소 클릭 모드에서는 적은 문서 수로 클릭 수를 계산해요. 정확하게 적어주세요!',
    relay: `중간 목표(${targets.slice(0, -1).join(', ')})도 경로에 함께 적어주세요. 시간은 도착 버튼을 누른 순간으로 기록돼요.`,
  }[room.mode] || '타임어택 모드에서 경로는 선택이에요. 시간은 도착 버튼을 누른 순간으로 기록돼요.';
  updateArriveCount();
  dlg.showModal();
  pathArea.focus();
};
dlg.addEventListener('close', () => { if (me()?.status === 'playing') arrivedAt = null; });
$('#arrive-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  if (room?.state !== 'playing' || me()?.status !== 'playing') {
    $('#arrive-error').textContent = '지금은 도착 처리를 할 수 없어요.';
    return;
  }
  const steps = parsePath();
  if (room.mode === 'clicks' && steps.length === 0
      && !confirm(`'${room.start}'에서 바로 '${room.target}'(으)로 1클릭 만에 도착한 게 맞나요?`)) return;
  const path = [room.start, ...steps, room.target];
  const elapsed = Math.max(0, (arrivedAt ?? now()) - room.startAt);
  $('#arrive-submit').disabled = true;
  try {
    await update(roomRef(room.code, 'players', playerId), {
      ...(room.mode === 'relay' ? { leg: targetsOf(room).length, legTimes: [...(me().legTimes || []), elapsed] } : {}),
      status: 'finished',
      elapsed,
      clicks: path.length - 1,
      path,
      steps: null,
      auto: false,
    });
    pathArea.value = '';
    dlg.close();
  } catch (err) {
    $('#arrive-error').textContent = '기록 제출에 실패했어요. 다시 시도해주세요.';
  } finally {
    $('#arrive-submit').disabled = false;
  }
});

// ---------- 렌더링 ----------
// 이름으로 정해지는 아바타 색 (antd 프리셋 색상)
const AVATAR_COLORS = ['#1677ff', '#13c2c2', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1', '#2f54eb', '#faad14', '#f5222d', '#a0d911'];
// ---------- 캐릭터 ----------
// 목록에 저장된 대표 이모지는 짧은 글자만 사용
const safeGlyph = (e, fallback = '') => (typeof e === 'string' && e.length > 0 && e.length <= 4 ? e : fallback);
const hashOf = (id, salt = 0) => {
  let h = salt;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};
// 캐릭터 = 동물 하나 + 부위별 액세서리. 고르지 않았으면 고양이. e는 목록에 쓰는 이모지
function charOf(p) {
  const look = cleanLook(p?.char);
  const animal = animalOf(look.a);
  return { ...look, e: animal.emoji, label: animal.label };
}
// 내가 착용 중인 모습 (가진 것만)
const myLook = () => cleanLook(profile?.look, profile);

// 착용 바꾸기: 내 계정에 저장하고, 방에 있으면 방에도 반영
async function equip(patch) {
  if (!authUser || !profile) return;
  const look = cleanLook({ ...myLook(), ...patch }, profile);
  const updates = { [`users/${authUser.uid}/look`]: look };
  if (room && me()) updates[`rooms/${room.code}/players/${playerId}/char`] = look;
  try { await update(ref(db), updates); } catch (e) { toast('바꾸지 못했어요. 다시 시도해주세요.', 'error'); console.warn(e); }
}
const NO_ACC_MSG = (a) => `${animalOf(a)?.label || '이 캐릭터'}는 액세서리를 착용할 수 없어요. 다른 캐릭터로 바꾸면 착용할 수 있어요.`;
function toggleAcc(id) {
  const it = accOf(id);
  if (!it || !ownsAcc(profile, id)) return;
  if (!canWearAcc(myLook().a)) { toast(NO_ACC_MSG(myLook().a), 'error'); return; }
  equip({ [it.slot]: myLook()[it.slot] === id ? null : id }); // 같은 걸 다시 누르면 벗기
}

// 캐릭터 그림 + 액세서리 (상점 미리보기 등)
function lookFigure(look, view = 'front') {
  return `<div class="charfig"><img src="${animalImg(look.a, view)}" alt="${animalOf(look.a).label}"><div class="accs">${lookAccHtml(look, view)}</div></div>`;
}
function animalIcon(p, cls = '') {
  const { a, label } = charOf(p);
  return `<img class="${cls}" src="${animalImg(a, 'icon')}" alt="${label}">`;
}
// 광장 위치 (0~1, 배경 그림 기준, y는 발 위치). 아직 안 움직였으면 아이디로 정해지는 자리
// 광장 밖 좌표(예전 3D 광장 위치 등)는 광장이 바닥 안쪽으로 맞춤
function posOf(p) {
  const ok = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  if (ok(p?.pos?.x) && ok(p?.pos?.y)) return p.pos;
  return { x: 0.25 + ((hashOf(p.id, 3) % 1000) / 1000) * 0.5, y: 0.52 + ((hashOf(p.id, 5) % 1000) / 1000) * 0.26 };
}

function avatar(p) {
  return `<span class="avatar avatar-animal">${animalIcon(p)}`
    + `<span class="badge-dot ${p.online ? '' : 'off'}" title="${p.online ? '접속 중' : '연결 끊김'}"></span></span>`;
}

// ---------- 대기실 광장 ----------
const BUBBLE_MS = 6000;
// 받은 채팅도 부적절한 단어를 가림 (예전 화면에서 보낸 것까지)
const chatList = () => Object.entries(room?.chat || {}).sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([id, m]) => ({ id, ...m, text: maskBad(m?.text), name: m?.name == null ? m?.name : maskBad(m.name) }));

// 광장: 배경 그림 위를 동물이 걸어다님 (plaza2d.js)
let plaza = null;
function renderPlaza() {
  if (!plaza) {
    plaza = createPlaza($('#plaza'), {
      onMove: (x, y, run) => room && me() && update(roomRef(room.code, 'players', playerId), { pos: { x, y, run: !!run } }),
      onJump: () => room && me() && update(roomRef(room.code, 'players', playerId), { jumpAt: serverTimestamp() }),
    });
  }
  plaza.resume();
  applyTheme();
  plaza.update(room.players.map((p) => ({
    id: p.id, name: p.name, ...charOf(p), ...posOf(p), run: !!p.pos?.run,
    jumpAt: p.jumpAt || null, jumpAgo: p.jumpAt ? now() - p.jumpAt : Infinity,
    online: p.online, me: p.id === playerId,
  })));
  renderBubbles();
}

// 최근 6초 안에 한 말을 머리 위 말풍선으로
function renderBubbles() {
  if (!room) return;
  const latest = new Map();
  const cutoff = now() - BUBBLE_MS;
  for (const m of chatList()) if (typeof m.t === 'number' && m.t >= cutoff) latest.set(m.pid, m.text);
  plaza?.setBubbles(latest);
}

let chatSig = null;
function renderChat() {
  const msgs = chatList().slice(-50);
  const last = msgs[msgs.length - 1];
  const sig = `${msgs.length}/${last?.id || ''}/${last?.t || ''}/${room.players.map((p) => charOf(p).a).join(',')}`;
  if (sig === chatSig) return;
  chatSig = sig;
  const log = $('#chat-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = msgs.map((m) => {
    const p = room.players.find((x) => x.id === m.pid);
    const e = p ? animalIcon(p, 'em-img') : esc(safeGlyph(m.e));
    return `<li class="${m.pid === playerId ? 'me' : ''}"><span class="who"><span class="em">${e}</span>${esc(p?.name || m.name)}</span><span class="txt">${esc(m.text)}</span></li>`;
  }).join('');
  if (nearBottom || last?.pid === playerId) log.scrollTop = log.scrollHeight;
}

// 대기실의 캐릭터 고르기: 가진 것만 고를 수 있고, 잠긴 것은 자물쇠 + 가격
let pickerSig = null;
function renderPicker() {
  const mine = charOf(me());
  const sig = JSON.stringify([mine, profile?.owned || null]);
  if (sig === pickerSig) return;
  pickerSig = sig;
  $('#char-animals').innerHTML = ANIMALS.map((a) => {
    const own = ownsAnimal(profile, a.id);
    return `<button type="button" data-a="${a.id}" class="${mine.a === a.id ? 'active' : ''} ${own ? '' : 'locked'}" ${own ? '' : 'disabled'} aria-label="${a.label}${own ? '' : ' (잠김)'}">`
      + `<img src="${animalImg(a.id, 'icon')}" alt=""><span>${a.label}</span></button>`;
  }).join('');
  const wear = canWearAcc(mine.a);
  $('#char-no-acc').classList.toggle('hidden', wear);
  $('#char-no-acc').textContent = wear ? '' : NO_ACC_MSG(mine.a);
  $('#char-accs').innerHTML = ACCESSORIES.map((it) => {
    const own = ownsAcc(profile, it.id);
    const ok = own && wear;
    return `<button type="button" data-acc="${it.id}" class="${wear && mine[it.slot] === it.id ? 'active' : ''} ${ok ? '' : 'locked'}" ${ok ? '' : 'disabled'} aria-label="${it.label}${own ? (wear ? '' : ' (착용 불가)') : ' (잠김)'}">`
      + `${accHtml(it, 'acc-ico')}<span>${it.label}</span></button>`;
  }).join('');
}

// 대기실 광장 배경: 각자 고른 테마로 (다른 사람에겐 그 사람 테마가 보임)
let themeShown = null;
function applyTheme() {
  const src = themeImg(myThemeId(profile));
  if (src === themeShown) return;
  themeShown = src;
  $('#plaza').style.backgroundImage = `url('${src}')`;
}
async function useTheme(id) {
  if (!authUser || !profile || !themeOf(id) || !ownsTheme(profile, id)) return;
  try {
    await update(ref(db, `users/${authUser.uid}`), { theme: id === DEFAULT_THEME ? null : id });
    toast(`광장 테마를 '${themeOf(id).label}'(으)로 바꿨어요.`, 'success');
  } catch (e) { toast('바꾸지 못했어요. 다시 시도해주세요.', 'error'); console.warn(e); }
}

// ---------- 상점 ----------
let shopOpen = false;
let shopTab = 'animals';
function openShop() { shopOpen = true; showHome(); window.scrollTo(0, 0); }
function closeShop() { shopOpen = false; showHome(); }
function renderShop() {
  const pts = profile?.points || 0;
  const look = myLook();
  $('#shop-points').textContent = `${pts.toLocaleString()}P`;
  $('#shop-preview').innerHTML = lookFigure(look);
  $$('#shop-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === shopTab));
  $('#shop-list').classList.toggle('themes', shopTab === 'themes');
  const wear = canWearAcc(look.a);
  const card = ({ key, kind, label, art, price, own, on }) => {
    let act;
    if (kind === 'acc' && own && !wear) act = '<span class="tag">착용 불가</span>';
    else if (on) act = kind === 'acc' ? `<button class="btn btn-sm" data-unequip="${key}">벗기</button>` : '<span class="tag tag-success">사용 중</span>';
    else if (own && kind === 'theme') act = `<button class="btn btn-sm btn-primary" data-theme="${key}">사용하기</button>`;
    else if (own) act = `<button class="btn btn-sm btn-primary" data-equip="${key}" data-kind="${kind}">${kind === 'acc' ? '착용하기' : '사용하기'}</button>`;
    else act = `<button class="btn btn-sm ${pts >= price ? 'btn-primary' : ''}" data-buy="${key}" data-kind="${kind}" ${pts >= price ? '' : 'disabled'}>${pts >= price ? `${price}P 구매` : `${price}P · 포인트 부족`}</button>`;
    return `<li class="shop-item ${own ? 'own' : 'locked'} ${on ? 'on' : ''}"><div class="art">${art}${own ? '' : `<span class="lockmark">${icon('lock')}</span>`}</div>`
      + `<div class="nm">${label}</div><div class="act">${act}</div></li>`;
  };
  if (shopTab === 'animals') {
    $('#shop-list').innerHTML = ANIMALS.map((a) => card({
      key: a.id, kind: 'animal', label: a.label, art: `<img src="${animalImg(a.id, 'front')}" alt="">`,
      price: ANIMAL_PRICE, own: ownsAnimal(profile, a.id), on: look.a === a.id,
    })).join('');
  } else if (shopTab === 'themes') {
    const cur = myThemeId(profile);
    $('#shop-list').innerHTML = THEMES.map((t) => card({
      key: t.id, kind: 'theme', label: t.label, art: `<img class="theme-art" src="${themeImg(t.id)}" alt="" loading="lazy">`,
      price: THEME_PRICE, own: ownsTheme(profile, t.id), on: cur === t.id,
    })).join('') + (THEMES.length < 2 ? '<li class="shop-soon text-tertiary">새 테마를 준비하고 있어요.</li>' : '');
  } else {
    $('#shop-list').innerHTML = SLOTS.map((s) => `<li class="shop-slot">${s.label}</li>` + ACCESSORIES.filter((it) => it.slot === s.key).map((it) => card({
      key: it.id, kind: 'acc', label: it.label, art: accHtml(it, 'acc-art'),
      price: ACC_PRICE, own: ownsAcc(profile, it.id), on: wear && look[it.slot] === it.id,
    })).join('')).join('');
    if (!wear) $('#shop-list').insertAdjacentHTML('afterbegin', `<li class="shop-soon text-secondary">${NO_ACC_MSG(look.a)}</li>`);
  }
}
async function buyItem(kind, id) {
  const uid = authUser?.uid;
  if (!uid || !profile) return;
  if (kind === 'theme') return buyTheme(id);
  const isAnimal = kind === 'animal';
  const item = isAnimal ? animalOf(id) : accOf(id);
  if (!item) return;
  if (isAnimal ? ownsAnimal(profile, id) : ownsAcc(profile, id)) return;
  const price = isAnimal ? ANIMAL_PRICE : ACC_PRICE;
  const pts = profile.points || 0;
  if (pts < price) { toast('포인트가 부족해요.', 'error'); return; }
  if (!confirm(`${item.label}을(를) ${price}P에 살까요?\n지금 ${pts.toLocaleString()}P → 구매 후 ${(pts - price).toLocaleString()}P`)) return;
  // 포인트 차감 + 구매 기록 + 바로 착용 (서버 규칙이 가격만큼 줄었는지 확인)
  const owned = { ...profile.owned, [isAnimal ? 'animals' : 'acc']: { ...(profile.owned?.[isAnimal ? 'animals' : 'acc'] || {}), [id]: true } };
  const look = cleanLook({ ...myLook(), ...(isAnimal ? { a: id } : { [item.slot]: id }) }, { owned });
  try {
    await update(ref(db), {
      [`users/${uid}/points`]: pts - price,
      [`users/${uid}/owned/${isAnimal ? 'animals' : 'acc'}/${id}`]: true,
      [`users/${uid}/look`]: look,
    });
    toast(`${item.label}을(를) 샀어요! (-${price}P)`, 'success');
  } catch (e) {
    console.warn(e);
    toast('구매하지 못했어요. 잠시 후 다시 시도해주세요.', 'error');
  }
}
// 테마 사기: 포인트 차감 + 구매 기록 + 바로 사용 (서버 규칙이 1000P 줄었는지 확인)
async function buyTheme(id) {
  const uid = authUser?.uid;
  const t = themeOf(id);
  if (!uid || !profile || !t || ownsTheme(profile, id)) return;
  const pts = profile.points || 0;
  if (pts < THEME_PRICE) { toast('포인트가 부족해요.', 'error'); return; }
  if (!confirm(`'${t.label}' 테마를 ${THEME_PRICE}P에 살까요?\n지금 ${pts.toLocaleString()}P → 구매 후 ${(pts - THEME_PRICE).toLocaleString()}P`)) return;
  try {
    await update(ref(db), {
      [`users/${uid}/points`]: pts - THEME_PRICE,
      [`users/${uid}/owned/themes/${id}`]: true,
      [`users/${uid}/theme`]: id,
    });
    toast(`'${t.label}' 테마를 샀어요! 대기실 광장 배경이 바뀌어요. (-${THEME_PRICE}P)`, 'success');
  } catch (e) {
    console.warn(e);
    toast('구매하지 못했어요. 잠시 후 다시 시도해주세요.', 'error');
  }
}
$('#btn-shop').onclick = openShop;
$('#btn-shop-back').onclick = closeShop;
$('#shop-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  shopTab = b.dataset.tab;
  renderShop();
});
$('#shop-list').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.buy) guarded(b, () => buyItem(b.dataset.kind, b.dataset.buy));
  else if (b.dataset.theme) guarded(b, () => useTheme(b.dataset.theme));
  else if (b.dataset.equip) {
    if (b.dataset.kind === 'animal') equip({ a: b.dataset.equip });
    else toggleAcc(b.dataset.equip);
  } else if (b.dataset.unequip) toggleAcc(b.dataset.unequip);
});
function playerRow(p, extra = '') {
  const tags = [];
  if (p.id === room.hostId) tags.push('<span class="tag tag-warning">방장</span>');
  else if (phase() === 'lobby' || phase() === 'results') tags.push(p.ready ? '<span class="tag tag-success">준비</span>' : '<span class="tag">대기</span>');
  if (p.id === playerId) tags.push('<span class="tag tag-blue">나</span>');
  const kick = isHost() && p.id !== playerId
    ? `<button class="kick" data-kick="${esc(p.id)}" title="${esc(p.name)}님 내보내기" aria-label="${esc(p.name)}님 내보내기">${icon('kick')}</button>` : '';
  return `<li>${avatar(p)}<span class="name">${esc(p.name)}</span><span class="tags">${tags.join('')}${extra}</span>${kick}</li>`;
}

function render() {
  const ph = phase();
  lastPhase = ph;
  syncPresence();
  $('#ext-installed').classList.toggle('hidden', !extOk());
  $('#ext-old').classList.toggle('hidden', !ext.ready || extOk());
  $('#ext-old-ver').textContent = ext.version || '알 수 없음';
  if (ph !== 'lobby') plaza?.pause();
  if (ph !== 'lobby' && ph !== 'results') showReadyBar(false);
  if (ph === 'home') { syncExt(); return showHome(); }
  unwatchLobbies();
  $$('.btn-destroy').forEach((b) => b.classList.toggle('hidden', !isHost()));
  unwatchDaily();
  const host = isHost();
  const my = me();

  if (ph === 'lobby') {
    show('lobby');
    $('#lobby-code').textContent = room.code;
    $$('#mode-seg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === room.mode);
      b.disabled = !host;
    });
    $('#mode-desc').textContent = modeDesc(room.mode, room.winners);
    $('#winners-item').classList.toggle('hidden', room.mode === 'clicks');
    $('#winners').value = String(room.winners || 1);
    $('#winners').disabled = !host;
    $('#public-room').setAttribute('aria-checked', String(room.public !== false));
    $('#public-room').disabled = !host;
    $('#room-lock').setAttribute('aria-checked', String(!!room.locked));
    $('#room-lock').disabled = !host;
    if (!host || !room.locked) {
      if (!host) $('#room-pw-box').classList.add('hidden');
      if (!room.locked && document.activeElement !== $('#room-pw') && $('#room-pw-box').classList.contains('hidden')) $('#room-pw').value = '';
    } else $('#room-pw-box').classList.remove('hidden');
    $('#room-pw-desc').textContent = host
      ? (room.locked ? '새로 들어오는 사람은 이 비밀번호를 입력해야 해요. 바꾸려면 새 숫자를 넣고 저장하세요.' : '켜면 새로 들어오는 사람은 숫자 4자리 비밀번호를 입력해야 해요. 이미 방에 있는 사람은 그대로예요.')
      : (room.locked ? '🔒 비밀번호가 걸린 방이에요.' : '비밀번호가 걸려 있지 않아요.');
    loadRoomPw();
    $('#legs-item').classList.toggle('hidden', room.mode !== 'relay');
    $('#legs').value = String(room.legs || 2);
    $('#legs').disabled = !host;
    $('#round-trip').setAttribute('aria-checked', String(!!room.roundTrip));
    $('#round-trip').disabled = !host;
    const n = room.legs || 2;
    $('#round-trip-desc').classList.toggle('hidden', !room.roundTrip);
    $('#round-trip-desc').textContent = `시작 → ${Array.from({ length: n }, (_, i) => `목표 ${i + 1}`).join(' → ')} → 다시 시작 문서로 돌아오면 끝나요.`;
    $('#time-limit').value = String(room.timeLimitMin || 0);
    $('#time-limit').disabled = !host;
    $('#host-only').classList.toggle('hidden', host);
    const sorted = [...room.players].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    $('#lobby-count').textContent = `${room.players.length}명`;
    $('#lobby-players').innerHTML = sorted.map((p) => playerRow(p)).join('');
    renderPlaza();
    renderChat();
    renderPicker();
    $('#btn-start').classList.toggle('hidden', !host);
    $('#wait-host').classList.toggle('hidden', host);
    renderReady();
  } else if (ph === 'countdown') {
    show('countdown');
  } else if (ph === 'playing') {
    show('play');
    $('#play-mode').textContent = modeLabel(room.mode) + (room.mode !== 'clicks' && room.winners > 1 ? ` · ${room.winners}등까지` : '') + (room.timeLimitMin ? ` · ${room.timeLimitMin}분 제한` : '');
    $('#play-start').textContent = room.start;
    $('#play-start-link').href = namuUrl(room.start);
    const status = my?.status;
    renderTargets(my);
    const targets = targetsOf(room);
    const relayMid = room.mode === 'relay' && (my?.leg || 0) < targets.length - 1;
    $('#btn-arrive').textContent = relayMid ? `${(my?.leg || 0) + 1}번째 목표 도착했어요!` : '도착했어요!';
    $('#auto-hint span').textContent = room.mode === 'relay'
      ? '목표 문서에 들어가면 자동으로 도착 처리되고 다음 목표가 공개돼요. 나무위키 탭에서 링크만 눌러 이동하세요!'
      : '목표 문서에 들어가면 자동으로 도착 처리돼요. 나무위키 탭에서 링크만 눌러 이동하세요!';
    $('#play-actions').classList.toggle('hidden', status !== 'playing');
    // 확장 프로그램이 있으면 도착은 자동, 없으면 수동 입력
    $('#btn-arrive').classList.toggle('hidden', ext.ready);
    $('#auto-hint').classList.toggle('hidden', !ext.ready);
    $('#ext-missing').classList.toggle('hidden', ext.ready || status !== 'playing');
    $('#play-start-link').innerHTML = (ext.ready && extRaceIsCurrent() && ext.race.steps.length ? '나무위키 탭으로 돌아가기' : '나무위키에서 열기') + icon('export');
    if (status === 'playing') autoOpenStart();
    renderProgress();
    $('#play-spectator').classList.toggle('hidden', status !== 'waiting');
    const done = $('#play-done');
    done.classList.toggle('hidden', status !== 'finished' && status !== 'gaveup');
    if (status === 'finished') {
      const rank = room.mode === 'clicks' ? 0 : ranking(room).filter((p) => p.status === 'finished').findIndex((p) => p.id === playerId) + 1;
      const wait = (my.hints && room.mode !== 'clicks' ? `힌트 페널티(${hintPenaltyText(room.mode, my.hints)})가 포함된 기록이라, 그 시간 안에 다른 사람이 도착하면 순위가 바뀔 수 있어요. ` : '')
        + (room.mode !== 'clicks' && (room.winners || 1) > 1 ? `${room.winners}등까지 나오면 게임이 끝나요.` : '다른 사람들이 끝나길 기다리는 중…');
      done.innerHTML = `<div class="card done-box ok">${icon('check')}<div><p class="done-title">${rank ? `${rank}등으로 도착!` : '도착 완료!'} ${fmtTimePrecise(my.elapsed)} · ${my.clicks}클릭</p><p class="text-tertiary">${wait}</p></div></div>`;
    } else if (status === 'gaveup') {
      done.innerHTML = `<div class="card done-box out">${icon('close')}<div><p class="done-title">${my.dq ? `실격됐어요 (규칙 위반 ${my.violations || 2}회)` : '포기했어요'}</p><p class="text-tertiary">다른 사람들이 끝나길 기다리는 중…</p></div></div>`;
    }
    const ranked = ranking(room);
    const spectators = room.players.filter((p) => !ranked.includes(p));
    $('#play-players').innerHTML = [...ranked, ...spectators].map((p) => {
      const relay = room.mode === 'relay';
      const run = [relay ? `${p.leg || 0}/${targets.length}` : '', p.auto && p.clicks != null ? `${p.clicks}클릭째` : ''].filter(Boolean).join(' · ') || '출발';
      let tag = `<span class="tag tag-processing">${run}</span>`;
      if (p.status === 'finished') tag = `<span class="tag tag-success">${room.mode === 'clicks' ? p.clicks + '클릭 · ' : ''}${fmtTimePrecise(p.elapsed)}</span>`;
      else if (p.status === 'gaveup') tag = `<span class="tag tag-error">${p.dq ? '실격' : '포기'}</span>`;
      else if (p.status === 'waiting') tag = '<span class="tag">관전</span>';
      if (relay && p.status !== 'waiting') tag = legDots(p, targets.length) + tag;
      return playerRow(p, tag);
    }).join('');
    $('#btn-end').classList.toggle('hidden', !host);
  } else if (ph === 'results') {
    if (dlg.open) dlg.close();
    show('results');
    renderResults(host);
  }
  syncExt();
  tick();
}

// 게임 화면의 목표 단계: 도착한 목표(초록), 지금 목표(파랑), 아직 안 보이는 목표(자물쇠)
function renderTargets(my) {
  const targets = targetsOf(room);
  const relay = room.mode === 'relay';
  const leg = relay ? (my?.status === 'finished' ? targets.length : my?.leg || 0) : 0;
  const box = $('#play-steps');
  box.querySelectorAll('.race-step.tgt').forEach((el) => el.remove());
  const html = targets.map((t, i) => {
    const back = relay && i === targets.length - 1 && t === room.start;
    const label = relay ? `목표 ${i + 1}/${targets.length}${back ? ' · 시작 문서로 돌아오기' : ''}` : '목표 문서';
    if (relay && i < leg) {
      const lt = my?.legTimes?.[i];
      return `<div class="race-step tgt"><span class="race-dot done">${icon('check')}</span><div class="race-step-body"><div class="statistic-title">${label} · 도착 ${fmtTimePrecise(lt)}</div><div class="doc-title done">${esc(t)}</div></div></div>`;
    }
    if (relay && i > leg) {
      return `<div class="race-step tgt"><span class="race-dot locked">${icon('lock')}</span><div class="race-step-body"><div class="statistic-title">${label}</div><div class="doc-title locked">앞 목표에 도착하면 공개돼요</div></div></div>`;
    }
    return `<div class="race-step tgt"><span class="race-dot target">${icon('aim')}</span><div class="race-step-body"><div class="statistic-title">${label}</div><div class="doc-title target">${esc(t)}</div></div></div>`;
  }).join('');
  box.insertAdjacentHTML('beforeend', html);
}

function renderResults(host) {
  const targets = targetsOf(room);
  const relay = room.mode === 'relay';
  $('#res-route').innerHTML = [room.start, ...targets].map((t) => `<b>${esc(t)}</b>`).join(' → ');
  $('#res-mode').textContent = modeLabel(room.mode);
  let rank = 0;
  const items = ranking(room).map((p) => {
    const finished = p.status === 'finished';
    if (finished) rank += 1;
    const rankStr = `<span class="rank-badge ${finished && rank <= 3 ? 'r' + rank : ''}">${finished ? rank : '-'}</span>`;
    let score;
    if (!finished) score = `<span class="muted">${p.dq ? '실격' : p.status === 'gaveup' ? '포기' : '미도착'}${relay ? `<small>${legDots(p, targets.length)} ${p.leg || 0}/${targets.length}단계</small>` : ''}</span>`;
    else if (room.mode === 'clicks') score = `${p.clicks}클릭<small>${fmtTimePrecise(p.elapsed)}</small>`;
    else score = `${fmtTimePrecise(p.elapsed)}<small>${p.clicks}클릭</small>`;
    // 자동 기록이면 각 이동이 링크 클릭이었는지 표시, 수동 기록이면 적은 경로만 표시
    const steps = Array.isArray(p.steps) ? p.steps : Array.isArray(p.path) ? p.path.map((title, i) => ({ title, cp: relay && i > 0 && targets.includes(title) })) : [];
    const badMark = { back: '뒤로가기', other: '링크 클릭 아님' };
    const cls = (s) => (badMark[s.h] ? ` class="bad" title="${badMark[s.h]}"`
      : s.h === 'return' ? ' class="ret" title="이전 문서로 되돌아가기"'
        : s.cp ? ' class="cp" title="목표 도착"' : '');
    const path = steps.length
      ? `<div class="path">${steps.map((s) => `<a href="${namuUrl(s.title)}" target="_blank" rel="noopener"${cls(s)}>${esc(s.title)}</a>`).join(icon('right', 'sep'))}</div>`
      : '';
    const flags = [];
    // 릴레이: 목표마다 도착 시간
    if (relay && p.legTimes?.length) {
      flags.push(...p.legTimes.map((t, i) => `<span class="tag tag-success">${i + 1}. ${esc(targets[i])} ${fmtTimePrecise(t)}</span>`));
    }
    if (finished && p.auto === false) flags.push('<span class="tag tag-warning">수동 기록</span>');
    if (p.hints) flags.push(`<span class="tag tag-warning">💡 힌트 ${p.hints}회 (${hintPenaltyText(room.mode, p.hints)})</span>`);
    if (p.returns) flags.push(`<span class="tag">↩ 되돌아가기 ${p.returns}회</span>`);
    if (p.dq) flags.push(`<span class="tag tag-error">🚫 실격 (규칙 위반 ${p.violations || 2}회)</span>`);
    else if (p.violations) flags.push(`<span class="tag tag-error">규칙 위반 ${p.violations}회</span>`);
    if (p.away) flags.push(`<span class="tag tag-warning">👀 다른 탭 ${p.away}회</span>`);
    const mine = p.id === playerId ? ' <span class="tag tag-blue">나</span>' : '';
    return `<li class="${finished && rank === 1 ? 'first' : ''}"><div class="head">${rankStr}<span class="name">${esc(p.name)}${mine}</span><span class="score">${score}</span></div>${path}${flags.length ? `<div class="flags">${flags.join('')}</div>` : ''}</li>`;
  });
  $('#res-list').innerHTML = items.join('') || '<li class="text-tertiary center">참가자가 없어요.</li>';
  $('#res-host').classList.toggle('hidden', !host);
  $('#res-wait').classList.toggle('hidden', host);
  renderReady();
  $('#btn-again').innerHTML = `${icon('redo')}${room.daily ? '다시 도전 (같은 문제)' : '다음 판 (새 키워드)'}`;
  $('#btn-lobby').classList.toggle('hidden', !!room.daily);
  $('#res-mode').textContent = room.daily ? `오늘의 챔피언 · ${room.daily.date}` : modeLabel(room.mode);
}

// 타이머 / 카운트다운 / 단계 전환
function tick() {
  if (!room) return;
  const ph = phase();
  if (ph !== lastPhase) { render(); maintain(); return; }
  if (ph === 'lobby') renderBubbles();
  if (ph === 'countdown') {
    $('#countdown').textContent = Math.max(1, Math.ceil((room.startAt - now()) / 1000));
  } else if (ph === 'playing') {
    const hw = $('#play-hintwait').classList.contains('hidden') ? null : true;
    renderHintWait();
    // 카운트다운이 끝나면 바로 게임 종료 확인
    if (hw && $('#play-hintwait').classList.contains('hidden')) maintain();
    const elapsed = now() - room.startAt;
    const timer = $('#play-timer');
    if (room.timeLimitMin) {
      const left = room.timeLimitMin * 60000 - elapsed;
      timer.textContent = fmtTime(left + 999);
      $('#play-timer-label').textContent = '남은 시간';
      timer.classList.toggle('warn', left < 60000);
      if (left <= 0) maintain();
    } else {
      timer.textContent = fmtTime(elapsed);
      $('#play-timer-label').textContent = '경과 시간';
      timer.classList.remove('warn');
    }
  }
}
setInterval(tick, 200);
setInterval(maintain, 5000);


// ---------- 계정: 로그인 / 회원가입 (가입하면 바로 이용) ----------
const auth = getAuth(firebaseApp);
const ID_RE = /^[a-z0-9_]{4,16}$/;
const EMAIL_DOMAIN = 'namurace.app'; // 아이디를 Firebase 로그인용 이메일로 바꿀 때 쓰는 가짜 도메인
const idToEmail = (id) => `${id}@${EMAIL_DOMAIN}`;
// 예전 방식(아이디만으로 로그인)의 자동 비밀번호. 비밀번호를 아직 만들지 않은 예전 계정이 한 번 들어와서
// 새 비밀번호를 만들 때만 씀 (users/<uid>/pwSet이 true가 되면 이 비밀번호는 더 이상 맞지 않음)
const idToPassword = (id) => `namurace-${id}-login`;
const PW_MIN = 6;
// 손님(로그인 없이): Firebase 익명 로그인. 이름 뒤에 '(손님)'이 붙고, 포인트·상점·퀘스트·오늘의 챔피언은 못 씀
const GUEST_TAG = '(손님)';
const GUEST_KEY = 'nr.guestName';
const isGuest = () => !!authUser?.isAnonymous;
const guestMark = () => (isGuest() ? { guest: true } : {});
// 손님은 1시간까지: 시간이 지나면 손님 화면이 스스로 방에서 나가고 손님 계정을 지움 (게임 중이면 판이 끝난 뒤)
const GUEST_LIMIT_MS = 60 * 60 * 1000;
const GUEST_WARN_MS = 5 * 60 * 1000;
const GUEST_START_KEY = 'nr.guestStart';
// 연결이 끊긴 손님은 방장이 방에서 지움 (창을 닫은 손님의 캐릭터가 남지 않게). 새로고침은 금방 다시 연결되니 여유를 둠
const GUEST_GONE_MS = 5 * 1000;
const GUEST_GONE_PLAYING_MS = 60 * 1000;
const guestStart = () => Number(store.get(GUEST_START_KEY, ss)) || Date.now();
const guestLeftMs = () => guestStart() + GUEST_LIMIT_MS - Date.now();
let guestWarned = false;
let guestEnding = false;
async function checkGuestTime() {
  if (!isGuest() || guestEnding) return;
  const left = guestLeftMs();
  if (left <= GUEST_WARN_MS && !guestWarned) {
    guestWarned = true;
    toast(`손님 시간이 ${Math.max(1, Math.ceil(left / 60000))}분 남았어요. 계속 하려면 회원가입해 주세요.`, 'warning');
  }
  const note = $('#guest-left');
  if (note) note.textContent = left > 0 ? `남은 시간 ${Math.ceil(left / 60000)}분` : '';
  if (left > 0) return;
  const ph = phase();
  if (ph === 'countdown' || (ph === 'playing' && me()?.status === 'playing')) return; // 달리는 중이면 판이 끝난 뒤
  guestEnding = true;
  try {
    if (room) await leaveRoom().catch(() => {});
    store.del(GUEST_START_KEY, ss);
    const u = auth.currentUser;
    if (u?.isAnonymous) await deleteUser(u).catch(() => signOut(auth));
    setTimeout(() => toast('손님 시간(1시간)이 끝났어요. 회원가입하면 계속 할 수 있어요.', 'info'), 300);
  } finally {
    guestEnding = false;
    guestWarned = false;
  }
}
setInterval(checkGuestTime, 15000);
// 방장: 창을 닫고 나간 손님 정리
let guestCleanupTimer = null;
let guestCleanupAt = 0;
function cleanupGoneGuests() {
  if (!room || !isHost()) return;
  const limit = room.state === 'playing' ? GUEST_GONE_PLAYING_MS : GUEST_GONE_MS;
  const off = room.players.filter((p) => p.guest && p.id !== playerId && !p.online && p.offlineSince);
  const gone = off.filter((p) => now() - p.offlineSince > limit);
  // 아직 시간이 안 된 손님은 시간이 되자마자 다시 확인 (5초마다 도는 정리를 기다리지 않음)
  const wait = off.filter((p) => !gone.includes(p)).map((p) => p.offlineSince + limit - now());
  if (wait.length) {
    const at = Date.now() + Math.max(200, Math.min(...wait) + 200);
    // 더 빨리 확인해야 하는 손님이 생기면 타이머를 앞당김
    if (!guestCleanupTimer || at < guestCleanupAt - 100) {
      clearTimeout(guestCleanupTimer);
      guestCleanupAt = at;
      guestCleanupTimer = setTimeout(() => { guestCleanupTimer = null; cleanupGoneGuests(); }, at - Date.now());
    }
  }
  if (!gone.length) return;
  const fix = {};
  for (const p of gone) fix[`players/${p.id}`] = null;
  update(roomRef(room.code), fix).catch((e) => console.warn('[손님 정리]', e.message));
}
store.del(GUEST_KEY); // 예전에 브라우저에 남겨 둔 손님 이름 정리
// 손님 로그인과 이름은 그 탭(창)에만 남음: 새로고침하면 그대로, 창을 닫으면 사라짐
function guestProfile() {
  let name = store.get(GUEST_KEY, ss) || '';
  if (!name) { name = `손님${Math.floor(100 + Math.random() * 900)}`; store.set(GUEST_KEY, name, ss); }
  return { nick: `${name}${GUEST_TAG}`, approved: true, pwSet: true, rcv: 'guest', rcvV: RCV_VER, points: 0, stats: {}, guest: true };
}
let authUser = null;
let profile = null; // users/<uid>
let isAdmin = false;
let profileUnsubs = [];
let authReady = false;
let profileLoaded = false; // users/<uid>를 한 번이라도 받았는지

function authMessage(e) {
  const code = e?.code || '';
  if (/email-already-in-use/.test(code)) return '이미 사용 중인 아이디예요.';
  if (/invalid-credential|wrong-password|user-not-found|invalid-email|missing-password/.test(code)) return '아이디 또는 비밀번호가 맞지 않아요.';
  if (/requires-recent-login/.test(code)) return '다시 로그인한 뒤에 해주세요.';
  if (code === 'recover/wrong') return '아이디, 질문, 답 중에 맞지 않는 것이 있어요.';
  if (code === 'recover/qa' || code === 'recover/no-slot') return e.message;
  if (code === 'recover/bad-keys' || code === 'recover/no-keys') return '비밀번호 찾기 정보를 열지 못했어요. 찾기 질문을 다시 만들어 주세요.';
  if (/weak-password/.test(code)) return '비밀번호는 6자 이상이어야 해요.';
  if (/too-many-requests/.test(code)) return '시도가 너무 많아요. 잠시 후 다시 해주세요.';
  if (/operation-not-allowed|configuration-not-found/.test(code)) return 'Firebase에서 이메일/비밀번호 로그인이 꺼져 있어요. 관리자에게 알려주세요.';
  if (/network/.test(code)) return '인터넷 연결을 확인해주세요.';
  if (/permission.denied/i.test(`${code} ${e?.message}`)) return '권한이 없어요. 데이터베이스 규칙을 확인해주세요.';
  return e?.message || '오류가 발생했어요.';
}

// 로그인 / 회원가입 탭
$$('#auth-tabs button').forEach((b) => (b.onclick = () => {
  $$('#auth-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('#login-form').classList.toggle('hidden', b.dataset.tab !== 'login');
  $('#signup-form').classList.toggle('hidden', b.dataset.tab !== 'signup');
  $('#recover-form').classList.add('hidden');
  $('#auth-error').textContent = '';
}));

async function authGuard(form, fn) {
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    await setPersistence(auth, browserLocalPersistence).catch(() => {}); // 회원은 창을 닫아도 로그인 유지
    await fn();
  } catch (e) { console.warn(e); $('#auth-error').textContent = authMessage(e); }
  finally { btn.disabled = false; }
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#login-id').value.trim().toLowerCase();
  const pw = $('#login-pw').value;
  if (!ID_RE.test(id)) { $('#auth-error').textContent = '아이디를 확인해주세요. (영어 소문자, 숫자, _ 로 4~16자)'; return; }
  authGuard(e.currentTarget, async () => {
    try {
      if (!pw) throw Object.assign(new Error('no password'), { code: 'auth/missing-password' });
      const cred = await signInWithEmailAndPassword(auth, idToEmail(id), pw);
      rememberPassword(cred.user.uid, pw);
    } catch (err) {
      // 비밀번호를 아직 만들지 않은 예전 계정: 예전 방식으로 들어온 뒤 '비밀번호 만들기' 화면으로
      if (!/invalid-credential|wrong-password|missing-password|invalid-login/.test(err?.code || '')) throw err;
      try { await signInWithEmailAndPassword(auth, idToEmail(id), idToPassword(id)); } catch { throw err; }
    }
    $('#login-pw').value = '';
  });
});

// ---------- 비밀번호 찾기 질문 (recovery.js) ----------
const QA_OPTS = '<option value="">질문 고르기</option>' + QUESTIONS.map((q) => `<option value="${q.id}">${esc(q.q)}</option>`).join('');
function mountQA(box) {
  box.innerHTML = Array.from({ length: QA_COUNT }, () => '<div class="qa-row">'
    + `<select class="input select qa-q" aria-label="비밀번호 찾기 질문">${QA_OPTS}</select>`
    + '<input class="input qa-a" maxlength="40" placeholder="답" autocomplete="off" aria-label="답"></div>').join('');
}
const readQA = (box) => [...box.querySelectorAll('.qa-row')].map((r) => ({ qid: r.querySelector('.qa-q').value, answer: r.querySelector('.qa-a').value }));
function clearQA(box) {
  box.querySelectorAll('.qa-row').forEach((r) => { r.querySelector('.qa-q').value = ''; r.querySelector('.qa-a').value = ''; });
}
['#su-qa', '#setpw-qa', '#rc-qa', '#dlg-qa'].forEach((s) => mountQA($(s)));
// 찾기 질문 저장 (본 계정으로 로그인한 상태에서): 처음 만들기 또는 바꾸기
async function saveRecovery(password, qa, extra = {}) {
  const uid = authUser.uid;
  let oldRcv = null;
  if (profile?.rcv) {
    const box = (await get(ref(db, `keys/${uid}`))).val();
    oldRcv = box ? await unlockKeys(uid, password, box).catch(() => null) : null;
  }
  const updates = await makeRecovery({ uid, id: profile.id, domain: EMAIL_DOMAIN, password, qa, oldRcv });
  await update(ref(db), { ...updates, ...extra });
}

// 비밀번호 찾기 화면
const showAuthForm = (name) => {
  ['login', 'signup', 'recover'].forEach((n) => $(`#${n}-form`).classList.toggle('hidden', n !== name));
  $('#auth-tabs').classList.toggle('hidden', name === 'recover');
  $('#auth-error').textContent = '';
};
$('#btn-forgot').onclick = () => { $('#rc-id').value = $('#login-id').value.trim().toLowerCase(); showAuthForm('recover'); };
$('#btn-forgot-back').onclick = () => showAuthForm('login');
$('#recover-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#rc-id').value.trim().toLowerCase();
  const qa = readQA($('#rc-qa'));
  const pw = $('#rc-pw').value;
  const err = (m) => { $('#auth-error').textContent = m; };
  if (!ID_RE.test(id)) return err('아이디를 확인해주세요. (영어 소문자, 숫자, _ 로 4~16자)');
  const qaErr = checkQA(qa);
  if (qaErr) return err(qaErr);
  if (pw.length < PW_MIN) return err(`새 비밀번호는 ${PW_MIN}자 이상이어야 해요.`);
  if (pw !== $('#rc-pw2').value) return err('새 비밀번호 확인이 다르게 입력됐어요.');
  if (pw === id) return err('아이디와 다른 비밀번호를 써 주세요.');
  authGuard(e.currentTarget, async () => {
    const found = await recoverPassword({ id, domain: EMAIL_DOMAIN, qa });
    const cred = await signInWithEmailAndPassword(auth, idToEmail(id), found.password);
    await updatePassword(cred.user, pw);
    rememberPassword(found.uid, pw);
    await update(ref(db), { ...(await relock({ uid: found.uid, password: pw, keysObj: found.keysObj })), [`users/${found.uid}/pwSet`]: true });
    $('#rc-pw').value = ''; $('#rc-pw2').value = ''; clearQA($('#rc-qa'));
    showAuthForm('login');
    toast('비밀번호를 바꿨어요. 다음부터 새 비밀번호로 로그인해요.', 'success');
  });
});

// 프로필: 비밀번호 바꾸기 / 찾기 질문 바꾸기
$$('.dlg-cancel').forEach((b) => (b.onclick = () => b.closest('dialog').close()));
$('#btn-pw').onclick = () => {
  ['#pw-cur', '#pw-new', '#pw-new2'].forEach((s) => { $(s).value = ''; });
  $('#pw-dialog .pw-user').value = profile?.id || '';
  $('#pw-error').textContent = '';
  $('#pw-dialog').showModal();
  $('#pw-cur').focus();
};
$('#pw-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const cur = $('#pw-cur').value;
  const pw = $('#pw-new').value;
  const errEl = $('#pw-error');
  errEl.textContent = '';
  if (!cur) { errEl.textContent = '지금 비밀번호를 입력해 주세요.'; return; }
  if (pw.length < PW_MIN) { errEl.textContent = `새 비밀번호는 ${PW_MIN}자 이상이어야 해요.`; return; }
  if (pw !== $('#pw-new2').value) { errEl.textContent = '새 비밀번호 확인이 다르게 입력됐어요.'; return; }
  if (pw === profile.id) { errEl.textContent = '아이디와 다른 비밀번호를 써 주세요.'; return; }
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const user = auth.currentUser;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, cur));
    // 찾기 정보가 있으면 새 비밀번호로 다시 잠금 (먼저 열어 봄: 못 열면 비밀번호를 바꾸지 않음)
    let keysObj = null;
    if (profile.rcv) {
      const box = (await get(ref(db, `keys/${user.uid}`))).val();
      keysObj = box ? await unlockKeys(user.uid, cur, box).catch(() => null) : null;
    }
    await updatePassword(user, pw);
    rememberPassword(user.uid, pw);
    if (keysObj) await update(ref(db), await relock({ uid: user.uid, password: pw, keysObj }));
    $('#pw-dialog').close();
    toast(profile.rcv && !keysObj ? '비밀번호를 바꿨어요. 비밀번호 찾기 질문은 다시 만들어 주세요.' : '비밀번호를 바꿨어요.', profile.rcv && !keysObj ? 'warning' : 'success');
  } catch (err) {
    errEl.textContent = /invalid-credential|wrong-password/.test(err?.code || '') ? '지금 비밀번호가 맞지 않아요.' : authMessage(err);
  } finally {
    btn.disabled = false;
  }
});
let qaRemembered = null; // 이 기기에 기억된 비밀번호 (찾기 질문 바꿀 때 묻지 않으려고)
$('#btn-qa').onclick = async () => {
  clearQA($('#dlg-qa'));
  $('#qa-cur').value = '';
  $('#qa-error').textContent = '';
  qaRemembered = authUser ? await recallPassword(authUser.uid) : null;
  $('#qa-cur-item').classList.toggle('hidden', !!qaRemembered);
  $('#qa-dialog').showModal();
};
$('#qa-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const qa = readQA($('#dlg-qa'));
  const cur = $('#qa-cur').value || qaRemembered || '';
  const errEl = $('#qa-error');
  errEl.textContent = checkQA(qa) || (cur ? '' : '지금 비밀번호를 입력해 주세요.');
  if (errEl.textContent) return;
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const user = auth.currentUser;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, cur));
    await saveRecovery(cur, qa);
    $('#qa-dialog').close();
    toast('비밀번호 찾기 질문을 저장했어요.', 'success');
  } catch (err) {
    const badPw = /invalid-credential|wrong-password/.test(err?.code || '');
    if (badPw && !$('#qa-cur').value && qaRemembered) {
      // 다른 기기에서 비밀번호를 바꿔서 기억된 비밀번호가 맞지 않음 → 한 번 입력받음
      qaRemembered = null;
      $('#qa-cur-item').classList.remove('hidden');
      errEl.textContent = '비밀번호가 바뀌었어요. 지금 비밀번호를 한 번 입력해 주세요.';
    } else errEl.textContent = badPw ? '지금 비밀번호가 맞지 않아요.' : authMessage(err);
  } finally {
    btn.disabled = false;
  }
});

// 손님으로 하기
$('#guest-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = cleanName($('#guest-name').value);
  const errEl = $('#guest-error');
  errEl.textContent = '';
  if (!name) { errEl.textContent = '이름을 입력해 주세요.'; return; }
  if (nickLen(name) > NICK_MAX) { errEl.textContent = `이름은 ${NICK_MAX}글자까지 쓸 수 있어요.`; return; }
  if (hasBad(name)) { errEl.textContent = '이름에 쓸 수 없는 말이 들어 있어요.'; return; }
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    store.set(GUEST_KEY, name, ss);
    await setPersistence(auth, browserSessionPersistence); // 창을 닫으면 손님 로그인 기록이 사라짐
    store.set(GUEST_START_KEY, String(Date.now()), ss);
    await signInAnonymously(auth);
  } catch (err) {
    console.warn('[손님]', err);
    errEl.textContent = /operation-not-allowed|admin-restricted/.test(err?.code || '') ? '지금은 손님으로 할 수 없어요. 관리자에게 알려 주세요. (Firebase 익명 로그인이 꺼져 있음)' : authMessage(err);
  } finally {
    btn.disabled = false;
  }
});
// 손님 → 로그인/회원가입 화면으로 (손님 계정은 지움)
async function leaveGuest() {
  if (room) return;
  await stopPresence();
  const u = auth.currentUser;
  store.del(GUEST_START_KEY, ss);
  if (u?.isAnonymous) await deleteUser(u).catch(() => signOut(auth));
  else await signOut(auth);
}
$$('.guest-join').forEach((b) => (b.onclick = leaveGuest));

// 비밀번호 만들기 (예전 계정)
$('#setpw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#setpw-pw').value;
  const errEl = $('#setpw-error');
  errEl.textContent = '';
  if (pw.length < PW_MIN) { errEl.textContent = `비밀번호는 ${PW_MIN}자 이상이어야 해요.`; return; }
  if (pw !== $('#setpw-pw2').value) { errEl.textContent = '비밀번호 확인이 다르게 입력됐어요.'; return; }
  const user = auth.currentUser;
  if (!user || !profile) return;
  if (pw === profile.id || pw === idToPassword(profile.id)) { errEl.textContent = '아이디와 다른 비밀번호를 써 주세요.'; return; }
  const qa = readQA($('#setpw-qa'));
  const qaErr = checkQA(qa);
  if (qaErr) { errEl.textContent = qaErr; return; }
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    try {
      await updatePassword(user, pw);
    } catch (err) {
      // 오래전에 로그인한 상태면 예전 방식으로 한 번 더 확인한 뒤 바꿈
      if (!/requires-recent-login/.test(err?.code || '')) throw err;
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, idToPassword(profile.id)));
      await updatePassword(user, pw);
    }
    // 찾기 질문을 먼저 저장하고 pwSet을 함께 켬 (실패하면 비밀번호만 바뀐 상태 → 화면은 그대로, 다시 시도 가능)
    rememberPassword(user.uid, pw);
    await saveRecovery(pw, qa, { [`users/${user.uid}/pwSet`]: true });
    $('#setpw-pw').value = ''; $('#setpw-pw2').value = ''; clearQA($('#setpw-qa'));
    toast('비밀번호를 만들었어요. 다음부터 아이디와 비밀번호로 로그인해요.', 'success');
  } catch (err) {
    console.warn('[비밀번호]', err);
    errEl.textContent = authMessage(err);
  } finally {
    btn.disabled = false;
  }
});

$('#signup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#su-name').value.replace(/\s+/g, ' ').trim().slice(0, 20);
  const nick = cleanName($('#su-nick').value);
  const id = $('#su-id').value.trim().toLowerCase();
  const err = (m) => { $('#auth-error').textContent = m; };
  if (!name) return err('이름을 입력해주세요.');
  if (!nick) return err('닉네임을 입력해주세요.');
  if (nickLen(nick) > NICK_MAX) return err(`닉네임은 ${NICK_MAX}글자까지 쓸 수 있어요.`);
  if (hasBad(nick)) return err('닉네임에 쓸 수 없는 말이 들어 있어요. 다른 닉네임을 써 주세요.');
  if (nick.includes('손님')) return err("닉네임에 '손님'은 쓸 수 없어요.");
  if (!ID_RE.test(id)) return err('아이디는 영어 소문자, 숫자, _ 로 4~16자예요.');
  const pw = $('#su-pw').value;
  if (pw.length < PW_MIN) return err(`비밀번호는 ${PW_MIN}자 이상이어야 해요.`);
  if (pw !== $('#su-pw2').value) return err('비밀번호 확인이 다르게 입력됐어요.');
  if (pw === id) return err('아이디와 다른 비밀번호를 써 주세요.');
  const qa = readQA($('#su-qa'));
  const qaErr = checkQA(qa);
  if (qaErr) return err(qaErr);
  authGuard(e.currentTarget, async () => {
    signingUp = true;
    // 닉네임 중복은 계정을 만든 뒤 확인 (닉네임 목록은 로그인해야 읽을 수 있음). 겹치면 만든 계정을 지움
    let cred;
    try { cred = await createUserWithEmailAndPassword(auth, idToEmail(id), pw); } catch (ce) { signingUp = false; throw ce; }
    rememberPassword(cred.user.uid, pw);
    $('#su-pw').value = ''; $('#su-pw2').value = '';
    const uid = cred.user.uid;
    try {
      if (await nickTakenBy(nick, uid)) throw new Error('이미 다른 사람이 쓰는 닉네임이에요. 다른 닉네임을 골라 주세요.');
      await update(ref(db), {
        [`ids/${id}`]: uid,
        [`users/${uid}`]: {
          id, nick, approved: true, points: 0, createdAt: serverTimestamp(), pwSet: true,
          stats: { games: 0, win1: 0, win2: 0, win3: 0, daily1: 0 },
        },
        [`private/${uid}`]: { name },
        [`nicks/${nickKey(nick)}`]: uid,
      });
      try {
        await update(ref(db), await makeRecovery({ uid, id, domain: EMAIL_DOMAIN, password: pw, qa }));
        clearQA($('#su-qa'));
      } catch (rcvErr) {
        console.warn('[비밀번호 찾기]', rcvErr);
        setTimeout(() => toast('비밀번호 찾기 질문을 저장하지 못했어요. 프로필의 "찾기 질문 바꾸기"에서 다시 만들어 주세요.', 'warning'), 1500);
      }
    } catch (dbErr) {
      // 데이터 저장에 실패하면 만든 로그인 계정도 지워서 다시 가입할 수 있게 함
      await cred.user.delete().catch(() => {});
      throw dbErr;
    } finally {
      signingUp = false;
    }
    watchProfile(uid);
  });
});
let signingUp = false;

$$('.btn-logout').forEach((b) => (b.onclick = async () => {
  if (room) return;
  await stopPresence();
  await forgetPasswords(); // 이 기기에 기억한 비밀번호도 지움 (같이 쓰는 컴퓨터 대비)
  if (isGuest()) { await leaveGuest(); return; }
  await signOut(auth);
}));

// ---------- 접속 현황 (관리자 화면에서 봄) ----------
// presence/<uid>/conns/<창마다 하나> = { where, room, at }: 연결이 끊기면 서버가 자동으로 지움
// presence/<uid>/lastSeen = 마지막으로 나간 시각
let presenceRef = null;
let presenceUid = null;
let presenceSent = null;
let netConnected = false;
function presenceInfo() {
  const ph = phase();
  const where = ph === 'home' ? (shopOpen ? 'shop' : 'home') : ph === 'countdown' ? 'playing' : ph;
  return { where, room: room?.code || null, daily: room?.daily ? true : null };
}
function armPresence() {
  onDisconnect(presenceRef).remove();
  onDisconnect(ref(db, `presence/${presenceUid}/lastSeen`)).set(serverTimestamp());
}
function syncPresence() {
  if (isGuest()) return; // 손님은 회원 전용 기능을 쓰지 않음
  const uid = authUser?.uid;
  if (!uid || !netConnected || !profile?.approved) return;
  if (!presenceRef || presenceUid !== uid) {
    presenceUid = uid;
    presenceRef = push(ref(db, `presence/${uid}/conns`));
    presenceSent = null;
    armPresence();
  }
  const info = presenceInfo();
  const json = JSON.stringify(info);
  if (json === presenceSent) return;
  presenceSent = json;
  set(presenceRef, { ...info, at: serverTimestamp() }).catch((e) => { presenceSent = null; console.warn('[접속 현황]', e.message); });
}
async function stopPresence() {
  if (!presenceRef) return;
  const r = presenceRef;
  const uid = presenceUid;
  presenceRef = null;
  presenceUid = null;
  presenceSent = null;
  try {
    await onDisconnect(r).cancel();
    await onDisconnect(ref(db, `presence/${uid}/lastSeen`)).cancel();
    await update(ref(db), { [`presence/${uid}/conns/${r.key}`]: null, [`presence/${uid}/lastSeen`]: serverTimestamp() });
  } catch (e) { console.warn('[접속 현황]', e.message); }
}
onValue(ref(db, '.info/connected'), (s) => {
  netConnected = !!s.val();
  if (!netConnected) return;
  // 다시 연결되면(끊긴 사이에 서버가 지웠으니) 다시 올림
  if (presenceRef) { armPresence(); presenceSent = null; }
  syncPresence();
});

// 닉네임 목록에 내 닉네임 올리기 (처음 한 번), 같은 닉네임이 먼저 있으면 바꿔 달라고 안내
let nickConflict = false;
let nickCheckedFor = null;
async function checkMyNick() {
  if (isGuest()) return; // 손님은 회원 전용 기능을 쓰지 않음
  const uid = authUser?.uid;
  if (!uid || !profile?.nick || !profile.approved) return;
  const sig = `${uid}/${nickKey(profile.nick)}`;
  if (nickCheckedFor === sig) return;
  nickCheckedFor = sig;
  try {
    const owner = await nickOwner(profile.nick);
    if (!owner) await set(ref(db, `nicks/${nickKey(profile.nick)}`), uid);
    nickConflict = !!owner && owner !== uid;
  } catch (e) {
    console.warn('[닉네임]', e.message);
    nickCheckedFor = null;
  }
  renderProfile();
}

// ---------- 공지 (관리자가 올림) ----------
// 시작 화면에 있을 때 띄움 (방 안이면 나왔을 때). 닫기 = 이번 접속에서만 닫음, 더 이상 보지 않기 = 이 공지는 다시 안 띄움
let notice = null;
const NOTICE_HIDE = 'nr.noticeHidden';
const NOTICE_CLOSED = 'nr.noticeClosed';
function maybeShowNotice() {
  const dlg = $('#notice-dialog');
  if (!notice?.id || dlg.open) return;
  if (room || !profile?.approved || shopOpen) return;
  const id = String(notice.id);
  if (store.get(NOTICE_HIDE) === id || store.get(NOTICE_CLOSED, ss) === id) return;
  if (document.querySelector('dialog[open]')) return; // 다른 창이 떠 있으면 나중에
  $('#notice-title').textContent = notice.title || '공지';
  $('#notice-body').textContent = notice.body || '';
  $('#notice-date').textContent = typeof notice.at === 'number' ? new Date(notice.at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  dlg.dataset.id = id;
  dlg.showModal();
}
$('#notice-close').onclick = () => { store.set(NOTICE_CLOSED, $('#notice-dialog').dataset.id, ss); $('#notice-dialog').close(); };
$('#notice-hide').onclick = () => { store.set(NOTICE_HIDE, $('#notice-dialog').dataset.id); $('#notice-dialog').close(); };
$('#notice-dialog').addEventListener('cancel', () => store.set(NOTICE_CLOSED, $('#notice-dialog').dataset.id, ss)); // Esc = 닫기

function watchProfile(uid) {
  profileUnsubs.forEach((u) => u());
  profileUnsubs = [
    onValue(ref(db, 'notice'), (s) => {
      notice = s.val();
      // 공지를 내렸거나 바뀌었으면 떠 있는 창도 정리
      const dlg = $('#notice-dialog');
      if (dlg.open && dlg.dataset.id !== String(notice?.id)) dlg.close();
      maybeShowNotice();
    }, (e) => console.warn('[공지]', e.message)),
    onValue(ref(db, `users/${uid}`), (s) => {
      const prev = profile;
      profile = s.val();
      profileLoaded = true;
      checkMyNick();
      if (room) { applyTheme(); renderPicker(); } // 방 안에서 가진 것이 바뀌어도 고르기 목록에 바로 반영
      showHome();
    }, (e) => { console.warn('[계정]', e.message); }),
    onValue(ref(db, `admins/${uid}`), (s) => { isAdmin = s.val() === true; renderHeaderUser(); }, () => {}),
  ];
}

onAuthStateChanged(auth, (user) => {
  authUser = user;
  authReady = true;
  profileUnsubs.forEach((u) => u());
  profileUnsubs = [];
  profile = null;
  profileLoaded = false;
  shopOpen = false;
  isAdmin = false;
  if (!user) {
    document.body.classList.remove('guest');
    presenceRef = null; // 로그아웃 뒤엔 쓸 수 없음 (연결이 끊기면 서버가 지움)
    playerId = null;
    if (room) leaveLocal();
    unwatchLobbies();
    unwatchDaily();
    showHome();
    return;
  }
  playerId = user.uid;
  document.body.classList.toggle('guest', !!user.isAnonymous);
  if (user.isAnonymous) {
    // 손님: 계정 정보가 없으므로 이 기기에서만 쓰는 프로필 (공지는 받음)
    profileUnsubs = [onValue(ref(db, 'notice'), (s) => { notice = s.val(); maybeShowNotice(); }, () => {})];
    profile = guestProfile();
    profileLoaded = true;
    if (!store.get(GUEST_START_KEY, ss)) store.set(GUEST_START_KEY, String(Date.now()), ss);
    showHome();
    checkGuestTime();
    return;
  }
  if (!signingUp) watchProfile(user.uid);
});

function renderHeaderUser() {
  const on = !!(profile && profile.approved);
  $('#hdr-user').classList.toggle('hidden', !on);
  if (on) $('#hdr-user').innerHTML = profile.guest ? esc(profile.nick) : `${esc(profile.nick)} · <b>${(profile.points || 0).toLocaleString()}P</b>`;
  $('#hdr-admin').classList.toggle('hidden', !isAdmin);
}

// 로그인 상태에 맞는 첫 화면 (방에 들어가 있지 않을 때)
let rejoinTried = false;
function showHome() {
  renderHeaderUser();
  if (room) return;
  showReadyBar(false); // 방에서 나오면 준비 막대 숨김
  if (!authReady) return show('loading');
  if (!authUser) return show('auth');
  if (!profileLoaded) return show('loading');
  if (!profile) {
    if (signingUp) return show('loading');
    // 가입 정보가 없음 (거절되었거나 지워짐)
    show('auth');
    $('#auth-error').textContent = '가입 정보가 없어요. 관리자가 삭제했을 수 있어요.';
    return;
  }
  if (!profile.approved) {
    // 예전 방식으로 가입해서 승인을 기다리던 계정은 스스로 승인 (정지된 계정은 제외)
    if (!profile.suspended) {
      update(ref(db, `users/${authUser.uid}`), { approved: true }).catch((e) => console.warn('[계정]', e.message));
      return show('loading');
    }
    $('#pending-who').textContent = `${profile.nick} (@${profile.id})`;
    return show('pending');
  }
  // 예전에 아이디만으로 가입한 계정: 비밀번호를 만들어야 게임을 할 수 있음
  if (profile.pwSet !== true) {
    $('#setpw-user').value = profile.id || '';
    return show('setpw');
  }
  syncPresence();
  if (shopOpen) { show('shop'); renderShop(); return; }
  show('home');
  maybeShowNotice();
  renderProfile();
  renderQuests();
  watchLobbies();
  watchDaily();
  payDailyChampions();
  cleanupStaleRooms();
  // 새로고침했으면 같은 방으로 자동 복귀
  if (!rejoinTried) {
    rejoinTried = true;
    const savedCode = store.get('nr.room', ss);
    if (savedCode) {
      joinRoom(savedCode, profile.nick).catch(() => {
        store.del('nr.room', ss);
        toast('이전 방에 다시 들어가지 못했어요.', 'warning');
      });
    }
  }
}

const AVATAR_BG = (uid) => AVATAR_COLORS[hashOf(uid, 7) % AVATAR_COLORS.length];
function renderProfile() {
  if (!profile) return;
  const st = profile.stats || {};
  const look = myLook();
  $('#pf-avatar').style.background = 'transparent';
  $('#pf-avatar').innerHTML = `<img src="${animalImg(look.a, 'icon')}" alt="${animalOf(look.a).label}">`;
  $('#pf-nick').textContent = profile.nick;
  const qaOld = !!profile.rcv && profile.rcvV !== RCV_VER;
  $('#qa-missing').classList.toggle('hidden', !!profile.rcv && !qaOld);
  $('#qa-missing-text').innerHTML = qaOld
    ? '비밀번호 찾기 방식이 바뀌었어요. <b>찾기 질문 바꾸기</b>에서 질문을 다시 만들어 주세요.'
    : '비밀번호 찾기 질문이 없어요. 비밀번호를 잊으면 찾을 수 없으니 <b>찾기 질문 바꾸기</b>에서 만들어 주세요.';
  $('#pf-id').textContent = `@${profile.id}`;
  $('#pf-points').textContent = `${(profile.points || 0).toLocaleString()} 포인트`;
  const cell = (n, label) => `<div><b>${n || 0}</b><span>${label}</span></div>`;
  $('#pf-stats').innerHTML = cell(st.games, '게임') + cell(st.win1, '🥇 1등') + cell(st.win2, '🥈 2등') + cell(st.win3, '🥉 3등') + cell(st.daily1, '👑 오늘의 챔피언');
  $('#btn-nick').disabled = !nickConflict && (profile.points || 0) < 300;
  $('#nick-cost').textContent = nickConflict ? '무료' : '300P';
  $('#nick-conflict').classList.toggle('hidden', !nickConflict);
}

// ---------- 닉네임 변경 (300포인트) ----------
$('#btn-nick').onclick = () => {
  $('#nick-desc').innerHTML = nickConflict ? '같은 닉네임을 쓰는 사람이 있어서 <b>무료로</b> 바꿀 수 있어요.'
    : `300포인트를 써서 닉네임을 바꿔요. 지금 <b>${(profile.points || 0).toLocaleString()}P</b> 있어요.`;
  $('#nick-submit').textContent = nickConflict ? '무료로 변경' : '300P 쓰고 변경';
  $('#nick-new').value = '';
  $('#nick-error').textContent = '';
  $('#nick-dialog').showModal();
  $('#nick-new').focus();
};
$('#nick-cancel').onclick = () => $('#nick-dialog').close();
$('#nick-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const nick = cleanName($('#nick-new').value);
  if (!nick) { $('#nick-error').textContent = '새 닉네임을 입력해주세요.'; return; }
  if (nickLen(nick) > NICK_MAX) { $('#nick-error').textContent = `닉네임은 ${NICK_MAX}글자까지 쓸 수 있어요.`; return; }
  if (hasBad(nick)) { $('#nick-error').textContent = '닉네임에 쓸 수 없는 말이 들어 있어요. 다른 닉네임을 써 주세요.'; return; }
  if (nick.includes('손님')) { $('#nick-error').textContent = "닉네임에 '손님'은 쓸 수 없어요."; return; }
  if (nick === profile.nick) { $('#nick-error').textContent = '지금 닉네임과 같아요.'; return; }
  const cost = nickConflict ? 0 : 300;
  if ((profile.points || 0) < cost) { $('#nick-error').textContent = '포인트가 부족해요.'; return; }
  $('#nick-submit').disabled = true;
  try {
    const uid = authUser.uid;
    const newKey = nickKey(nick);
    const oldKey = nickKey(profile.nick);
    const [newOwner, oldOwner, taken] = await Promise.all([nickOwner(nick), nickOwner(profile.nick), nickTakenBy(nick, uid)]);
    if (taken) { $('#nick-error').textContent = '이미 다른 사람이 쓰는 닉네임이에요.'; return; }
    if (!$('#nick-dialog').open) return; // 확인하는 사이에 취소했으면 바꾸지 않음
    const updates = { [`users/${uid}/nick`]: nick };
    if (cost) updates[`users/${uid}/points`] = profile.points - cost;
    if (newOwner !== uid) updates[`nicks/${newKey}`] = uid;
    if (oldKey !== newKey && oldOwner === uid) updates[`nicks/${oldKey}`] = null; // 예전 닉네임은 다른 사람이 쓸 수 있게
    await update(ref(db), updates);
    nickConflict = false;
    $('#nick-dialog').close();
    toast(`닉네임을 '${nick}'(으)로 바꿨어요.${cost ? ` (-${cost}P)` : ''}`, 'success');
  } catch (err) {
    $('#nick-error').textContent = authMessage(err);
  } finally {
    $('#nick-submit').disabled = false;
  }
});

// ---------- 승리 포인트: 참가 인원에 따라 ----------
// 2명: 1등 30 / 3명: 1등 50, 2등 30 / 4명 이상: 1등 100, 2등 50, 3등 30
const PRIZE = [200, 150, 100]; // 오늘의 챔피언 1·2·3등
const prizesFor = (n) => (n >= 4 ? [100, 50, 30] : n === 3 ? [50, 30] : n === 2 ? [30] : []);
let claimedKey = null;
async function claimRoundRewards() {
  if (isGuest()) return; // 손님은 회원 전용 기능을 쓰지 않음
  if (!room || room.state !== 'results' || room.daily || !authUser) return;
  const key = `${room.code}/${room.round}`;
  if (claimedKey === key) return;
  const my = me();
  if (!my || !my.status || my.status === 'waiting') return;
  claimedKey = key;
  const code = room.code;
  const round = room.round;
  const participants = room.players.filter((p) => p.status && p.status !== 'waiting').length;
  const finished = ranking(room).filter((p) => p.status === 'finished');
  const rank = finished.findIndex((p) => p.id === playerId) + 1;
  try {
    const prof = (await get(ref(db, `users/${authUser.uid}`))).val();
    if (!prof) return;
    const updates = {};
    const lastGame = prof.lastGame;
    // 게임 수는 목표까지 도착(완주)한 판만 셈 (포기·실격·미도착·중간에 나간 판은 안 셈)
    if (my.status === 'finished' && !(lastGame && lastGame.code === code && lastGame.round === round)) {
      updates[`users/${authUser.uid}/lastGame`] = { code, round };
      updates[`users/${authUser.uid}/stats/games`] = (prof.stats?.games || 0) + 1;
    }
    const amt = rank >= 1 ? prizesFor(participants)[rank - 1] || 0 : 0;
    // 승리 보상은 하루 WIN_CAP번까지 (database.rules.json의 lastWin 규칙과 같아야 함)
    const qday = questDay();
    const winN = prof.lastWin?.day === qday ? (prof.lastWin.n || 0) + 1 : 1;
    if (amt && winN > WIN_CAP) toast(`오늘 받을 수 있는 순위 보상(${WIN_CAP}번)을 모두 받았어요. 내일 다시 받을 수 있어요.`, 'info');
    if (amt && winN <= WIN_CAP) {
      const rid = room.rid || code; // 예전 방은 고유 번호가 없어서 코드로
      const claimed = (await get(ref(db, `claims/${rid}/${authUser.uid}`))).val();
      if (!(typeof claimed === 'number' && claimed >= round)) {
        updates[`users/${authUser.uid}/points`] = (prof.points || 0) + amt;
        updates[`users/${authUser.uid}/lastWin`] = { code, rid, round, amt, day: qday, n: winN };
        updates[`users/${authUser.uid}/stats/win${rank}`] = (prof.stats?.[`win${rank}`] || 0) + 1;
        updates[`claims/${rid}/${authUser.uid}`] = round;
      }
    }
    if (!Object.keys(updates).length) return;
    await update(ref(db), updates);
    if (Object.keys(updates).some((k) => k.startsWith('claims/'))) {
      toast(`${rank}등! +${amt} 포인트`, 'success');
      const sub = $('#end-sub');
      if ($('#end-dialog').open && !sub.textContent.includes('포인트')) sub.textContent = [sub.textContent, `+${amt} 포인트`].filter(Boolean).join(' · ');
    }
  } catch (e) {
    console.warn('[포인트]', e.message);
  }
}


// ---------- 오늘의 퀘스트 ----------
// 매일 자정(한국 시간)에 난이도별로 정해짐: ★ 2개(30P) + ★★ 1개(50P) + ★★★ 1개(80P) (모두 같은 퀘스트)
// 고르는 방법은 database.rules.json의 lastQuest 규칙과 똑같아야 해요 (서버가 오늘의 퀘스트인지 확인)
// 출석하기: 매일 맨 위에 항상 있음, 들어오기만 하면 받을 수 있음 (30P)
const QUEST_ATTEND = { id: 'attend', title: '출석하기', target: 1, amt: 30, sub: '오늘 들어오면 바로 받아요', attend: true };
const QUEST_STAR1 = [
  { id: 'games3', title: '오늘 3판 하기', target: 3, amt: 30, star: 1 },
  { id: 'dailytry', title: '오늘의 문제 도착하기', target: 1, amt: 30, sub: '오늘의 챔피언', star: 1 },
  { id: 'relay1', title: '릴레이 모드 완주하기', target: 1, amt: 30, star: 1 },
  { id: 'nohint1', title: '힌트 없이 완주하기', target: 1, amt: 30, star: 1 },
  { id: 'clicks1', title: '최소 클릭 모드 완주하기', target: 1, amt: 30, star: 1 },
  { id: 'time1', title: '타임어택 모드 완주하기', target: 1, amt: 30, star: 1 },
  { id: 'fast5', title: '5분 안에 도착하기', target: 1, amt: 30, sub: '힌트 페널티 포함', star: 1 },
];
const QUEST_STAR2 = [
  { id: 'win1', title: '1등 하기', target: 1, amt: 50, sub: '3명 이상인 방', star: 2 },
  { id: 'games5', title: '오늘 5판 하기', target: 5, amt: 50, star: 2 },
  { id: 'allmodes', title: '세 모드 모두 완주하기', target: 3, amt: 50, sub: '타임어택·최소 클릭·릴레이', star: 2 },
  { id: 'fast3', title: '3분 안에 도착하기', target: 1, amt: 50, sub: '힌트 페널티 포함', star: 2 },
];
const QUEST_STAR3 = [
  { id: 'win3', title: '1등 3번 하기', target: 3, amt: 80, sub: '3명 이상인 방', star: 3 },
  { id: 'dailytop3', title: '오늘의 챔피언 3등 안에 들기', target: 1, amt: 80, star: 3 },
  { id: 'games10', title: '오늘 10판 하기', target: 10, amt: 80, star: 3 },
  { id: 'fast2', title: '2분 안에 도착하기', target: 1, amt: 80, sub: '힌트 페널티 포함', star: 3 },
];
// ★ 7개 중 2개 (21가지)
const QUEST_PAIRS = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [2, 3], [2, 4], [2, 5], [2, 6], [3, 4], [3, 5], [3, 6], [4, 5], [4, 6], [5, 6]];
const QUEST_FAST = { fast5: 5 * 60000, fast3: 3 * 60000, fast2: 2 * 60000 }; // 도착 시간 퀘스트 기준 (기록 = 힌트 페널티 포함)
const QUEST_WIN_MIN = 3;
const WIN_CAP = 20; // 순위 보상(1~3등 포인트)은 하루 20번까지 // 1등 퀘스트는 이 인원 이상인 방에서만
const questDay = () => Math.floor((now() + 9 * 3600000) / 86400000); // 한국 시간 기준 날짜 번호
// ★ 짝은 날짜 % 21, ★★는 날짜 % 4, ★★★는 (날짜 / 4의 몫 + 날짜) % 4 → 매일 모두 바뀌고 ★★·★★★는 16일마다 모든 조합
function todaysQuests(day = questDay()) {
  const e = QUEST_PAIRS[day % 21];
  return [QUEST_ATTEND, QUEST_STAR1[e[0]], QUEST_STAR1[e[1]], QUEST_STAR2[day % 4], QUEST_STAR3[(Math.floor(day / 4) + day) % 4]];
}
// 난이도 표시: ★☆☆ / ★★☆ / ★★★
const questStars = (n) => `<span aria-label="난이도 ${n}">${'★'.repeat(n)}<span class="qoff">${'★'.repeat(3 - n)}</span></span>`;
// 오늘 진행 상황 (users/{uid}/quest, 날짜가 바뀌면 처음부터)
const questProg = (day = questDay()) => (profile?.quest?.day === day ? profile.quest : { day });
function questValue(q, prog) {
  switch (q.id) {
    case 'attend': return 1;
    case 'games3': case 'games5': case 'games10': return prog.games || 0;
    case 'nohint1': return prog.nohint || 0;
    case 'clicks1': return prog.modes?.clicks ? 1 : 0;
    case 'time1': return prog.modes?.time ? 1 : 0;
    case 'allmodes': return ['time', 'clicks', 'relay'].filter((m) => prog.modes?.[m]).length;
    case 'fast5': case 'fast3': case 'fast2': return prog.best != null && prog.best <= QUEST_FAST[q.id] ? 1 : 0;
    case 'win1': case 'win3': return prog.wins || 0;
    case 'relay1': return prog.relay || 0;
    case 'dailytry': return prog.daily ? 1 : 0;
    case 'dailytop3': {
      const i = dailyRanking().findIndex((r) => r.id === playerId);
      return i >= 0 && i < 3 ? 1 : 0;
    }
    default: return 0;
  }
}
const questClaimed = (q, day = questDay()) => profile?.questClaims?.[q.id] === day;

function renderQuests() {
  const list = $('#quest-list');
  if (!list || !profile) return;
  const day = questDay();
  const prog = questProg(day);
  const qs = todaysQuests(day);
  let got = 0;
  list.innerHTML = qs.map((q) => {
    const v = Math.min(q.target, questValue(q, prog));
    const done = v >= q.target;
    const claimed = questClaimed(q, day);
    if (claimed) got += q.amt;
    const act = claimed ? '<span class="tag tag-success">받음</span>'
      : `<button class="btn btn-sm ${done ? 'btn-primary' : ''}" data-quest="${q.id}" ${done ? '' : 'disabled'}>${done ? `${q.amt}P 받기` : `${q.amt}P`}</button>`;
    return `<li class="quest ${claimed ? 'claimed' : done ? 'ready' : ''}">`
      + `<span class="tag ${q.attend ? 'tag-success' : 'tag-warning'} qlv">${q.attend ? '출석' : questStars(q.star)}</span>`
      + `<div class="qinfo"><div class="qtitle">${q.title}${q.sub ? `<span class="qsub">${q.sub}</span>` : ''}</div>`
      + `<div class="qbar" role="progressbar" aria-valuemin="0" aria-valuemax="${q.target}" aria-valuenow="${v}"><i style="width:${(v / q.target) * 100}%"></i></div>`
      + `<div class="qnum">${v} / ${q.target}</div></div>`
      + `<div class="qact">${act}</div></li>`;
  }).join('');
  const total = qs.reduce((s, q) => s + q.amt, 0);
  $('#quest-sum').textContent = `${got} / ${total}P`;
}
$('#quest-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-quest]');
  if (b && !b.disabled) guarded(b, () => claimQuest(b.dataset.quest));
});
async function claimQuest(id) {
  const uid = authUser?.uid;
  if (!uid || !profile) return;
  const day = questDay();
  const q = todaysQuests(day).find((x) => x.id === id);
  if (!q || questClaimed(q, day) || questValue(q, questProg(day)) < q.target) return;
  try {
    await update(ref(db), {
      [`users/${uid}/points`]: (profile.points || 0) + q.amt,
      [`users/${uid}/lastQuest`]: { id: q.id, day, amt: q.amt },
      [`users/${uid}/questClaims/${q.id}`]: day,
    });
    toast(q.attend ? `출석 완료! +${q.amt} 포인트` : `퀘스트 완료! +${q.amt} 포인트`, 'success');
  } catch (e) {
    console.warn('[퀘스트]', e.message);
    toast('포인트를 받지 못했어요. 새로고침한 뒤 다시 시도해주세요.', 'error');
  }
}

// 판이 끝나면 퀘스트 진행 기록 (끝까지 참가한 판만, 한 판에 한 번)
let questRoundKey = null;
function recordQuestRound() {
  if (isGuest()) return; // 손님은 회원 전용 기능을 쓰지 않음
  if (!room || room.state !== 'results' || !authUser) return;
  const key = `${room.rid || room.code}/${room.round}`;
  if (questRoundKey === key) return;
  const my = me();
  if (!my || !my.status || my.status === 'waiting') return;
  questRoundKey = key;
  if (my.status !== 'finished') return; // 완주한 판만 셈 (포기·실격·미도착은 세지 않음)
  const participants = room.players.filter((p) => p.status && p.status !== 'waiting').length;
  const finished = ranking(room).filter((p) => p.status === 'finished');
  const won = finished[0]?.id === playerId && participants >= QUEST_WIN_MIN;
  const arrived = my.status === 'finished';
  const day = questDay();
  const before = todaysQuests(day).filter((q) => questValue(q, questProg(day)) >= q.target).map((q) => q.id);
  runTransaction(ref(db, `users/${authUser.uid}/quest`), (cur) => {
    const p = cur?.day === day ? cur : { day };
    if (p.last === key) return undefined; // 이미 센 판 (다른 탭 등)
    return {
      ...p,
      last: key,
      games: (p.games || 0) + 1,
      wins: (p.wins || 0) + (won ? 1 : 0),
      relay: (p.relay || 0) + (room.mode === 'relay' && arrived ? 1 : 0),
      nohint: (p.nohint || 0) + (my.hints ? 0 : 1),
      best: typeof my.elapsed === 'number' ? Math.min(p.best ?? Infinity, my.elapsed) : (p.best ?? null),
      modes: room.daily ? (p.modes || null) : { ...(p.modes || {}), [room.mode]: true },
      daily: p.daily || (!!room.daily && arrived),
    };
  }).then((res) => {
    if (!res.committed) return;
    const prog = res.snapshot.val() || { day };
    const fresh = todaysQuests(day).filter((q) => !before.includes(q.id) && !questClaimed(q, day) && questValue(q, prog) >= q.target);
    if (fresh.length) setTimeout(() => toast(`퀘스트 달성: ${fresh.map((q) => q.title).join(', ')} · 시작 화면에서 포인트를 받으세요!`, 'success'), 2500);
  }).catch((e) => console.warn('[퀘스트]', e.message));
}

// ---------- 오늘의 챔피언 포인트: 하루가 지나면 그날 1·2·3등에게 지급 ----------
function prevDateKey(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
let dailyPayChecked = null;
async function payDailyChampions() {
  if (isGuest()) return; // 손님은 회원 전용 기능을 쓰지 않음
  const date = prevDateKey(todayKey());
  if (dailyPayChecked === date) return;
  dailyPayChecked = date;
  try {
    if ((await get(ref(db, `dailyPaid/${date}`))).exists()) return;
    const best = (await get(dailyRef(date, 'best'))).val() || {};
    // 그날(한국 시간) 안에 세운 기록만 인정
    const [y, m, d] = date.split('-').map(Number);
    const dayStart = Date.UTC(y, m - 1, d) - 9 * 3600 * 1000;
    const dayEnd = dayStart + 24 * 3600 * 1000;
    const top = Object.entries(best)
      .filter(([, r]) => typeof r?.ms === 'number' && typeof r.at === 'number' && r.at >= dayStart && r.at < dayEnd)
      .sort(([, a], [, b]) => a.ms - b.ms || (a.at || 0) - (b.at || 0))
      .slice(0, 3);
    const updates = { [`dailyPaid/${date}`]: { by: authUser.uid, at: serverTimestamp() } };
    for (const [i, [uid]] of top.entries()) {
      const u = (await get(ref(db, `users/${uid}`))).val();
      if (!u) continue; // 회원이 아닌 예전 기록은 건너뜀
      updates[`users/${uid}/points`] = (u.points || 0) + PRIZE[i];
      updates[`users/${uid}/lastDaily`] = { date, amt: PRIZE[i] };
      if (i === 0) updates[`users/${uid}/stats/daily1`] = (u.stats?.daily1 || 0) + 1;
    }
    await update(ref(db), updates);
  } catch (e) {
    // 다른 사람이 먼저 지급했으면 실패해도 괜찮음
    console.warn('[오늘의 챔피언 지급]', e.message);
  }
}

// ---------- 데이터 정리: 오래 활동이 없는 방 지우기 ----------
// 시작 화면에 들어온 사람의 브라우저가 대신 정리 (모두 합쳐 30분에 한 번만)
const STALE_ROOM_MS = 2 * 3600 * 1000;
const CLEANUP_EVERY_MS = 30 * 60 * 1000;
let cleanupTried = false;
async function cleanupStaleRooms() {
  if (isGuest()) return; // 손님은 회원 전용 기능을 쓰지 않음
  if (cleanupTried) return;
  cleanupTried = true;
  try {
    // 30분 안에 누가 이미 정리했으면 건너뜀 (동시에 여러 명이 정리하지 않도록 트랜잭션으로 차례 정하기)
    let mine = false;
    await runTransaction(ref(db, 'maint/lastCleanup'), (cur) => {
      if (typeof cur === 'number' && now() - cur < CLEANUP_EVERY_MS) { mine = false; return undefined; }
      mine = true;
      return serverTimestamp();
    });
    if (!mine) return;
    const [roomsSnap, idx, lob] = await Promise.all([
      get(ref(db, 'rooms')).catch(() => null), get(ref(db, 'roomIndex')), get(ref(db, 'lobbies')),
    ]);
    const cutoff = now() - STALE_ROOM_MS;
    const updates = {};
    const drop = (code) => { updates[`rooms/${code}`] = null; updates[`lobbies/${code}`] = null; updates[`roomIndex/${code}`] = null; updates[`roomPw/${code}`] = null; updates[`roomKeys/${code}`] = null; };
    const index = idx.val() || {};
    for (const [code, v] of Object.entries(index)) {
      if (!(typeof v?.lastActive === 'number' && v.lastActive > cutoff)) drop(code);
    }
    // 방 목록을 읽을 수 있으면: 활동 기록이 없는 방, 닫힌 방, 방장·상태가 없는 빈 방도 정리
    for (const [code, r] of Object.entries(roomsSnap?.val() || {})) {
      if (updates[`rooms/${code}`] === null) continue;
      const last = index[code]?.lastActive;
      const anyoneOnline = Object.values(r?.players || {}).some((p) => p?.online);
      const broken = !r?.hostId || !r?.state; // 지워진 뒤 늦게 도착한 쓰기로 남은 조각
      const closed = !!r?.closed;
      const noBeat = typeof last !== 'number' && !anyoneOnline && (r?.createdAt || 0) < cutoff;
      if (broken || closed || noBeat) drop(code);
    }
    // 목록에만 남은 오래된 항목도 정리
    for (const [code, v] of Object.entries(lob.val() || {})) {
      if (!(typeof v?.updatedAt === 'number' && v.updatedAt > cutoff)) updates[`lobbies/${code}`] = null;
    }
    if (Object.keys(updates).length) {
      await update(ref(db), updates);
      console.info(`[데이터 정리] 오래된 방 ${Object.keys(updates).filter((k) => k.startsWith('rooms/')).length}개를 지웠어요.`);
    }
  } catch (e) {
    console.warn('[데이터 정리]', e.message);
  }
}

// ---------- 시작 ----------
show('loading');
