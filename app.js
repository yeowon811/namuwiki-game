import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, get, set, update, remove, onValue, onDisconnect, serverTimestamp, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import KEYWORDS from './keywords.js';

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
let playerId = store.get('nr.playerId');
if (!playerId) { playerId = newId(); store.set('nr.playerId', playerId); }

// ---------- Firebase ----------
const db = getDatabase(initializeApp(firebaseConfig));
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
    ext.race = msg.race;
    render();
    syncExt();
  } else if (msg.type === 'STATE') {
    ext.race = msg.race;
    onExtState();
  } else if (msg.type === 'ERROR') {
    console.warn('[확장 프로그램]', msg.message);
  }
});
// 확장 프로그램의 내용 스크립트가 늦게 준비될 수 있으니 응답이 올 때까지 몇 번 물어봄
[0, 300, 1000, 2500, 5000].forEach((ms) => setTimeout(() => { if (!ext.ready) toExt('PING'); }, ms));

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
      clicks: p.clicks ?? null, elapsed: p.elapsed ?? null, leg: p.leg || 0,
    })),
    total: targetsOf(room).length,
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
  const key = `${raceKey()}/${r.steps.length}/${r.finished}/${r.leg}`;
  if (ext.writtenKey === key) return;
  const prevLeg = me()?.leg || 0;
  ext.writtenKey = key;
  const data = {
    auto: true,
    steps: r.steps,
    path: r.steps.map((s) => s.title),
    clicks: r.clicks,
    violations: r.violations,
  };
  if (relay) {
    data.leg = r.leg;
    data.legTimes = r.legT.map((t) => Math.max(0, t + clockOffset - room.startAt));
    const targets = targetsOf(room);
    if (!r.finished && r.leg > prevLeg) toast(`${r.leg}번째 목표 도착! 다음 목표: ${targets[r.leg]}`, 'success');
  }
  if (r.finished) {
    data.status = 'finished';
    data.elapsed = Math.max(0, r.finishT + clockOffset - room.startAt);
  }
  update(roomRef(room.code, 'players', playerId), data).catch((e) => console.error(e));
  if (r.finished) toast('도착! 기록이 저장됐어요.', 'success');
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
    + (r.violations ? `<br><span class="warn">링크 클릭이 아닌 이동 ${r.violations}회</span>` : '');
}

const nameInput = $('#name');
nameInput.value = store.get('nr.name') || '';
const params = new URLSearchParams(location.search);
if (params.get('room')) $('#code').value = params.get('room').toUpperCase();

// ---------- 유틸 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const namuUrl = (t) => 'https://namu.wiki/w/' + encodeURIComponent(t);
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16);
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
const modeDesc = (m) => MODE_DESC[m] || MODE_DESC.time;
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

async function createRoom(name) {
  let code;
  for (let i = 0; i < 10; i++) {
    code = makeCode();
    if (!(await get(roomRef(code))).exists()) break;
  }
  await set(roomRef(code), {
    hostId: playerId,
    mode: 'time',
    timeLimitMin: 0,
    state: 'lobby',
    round: 0,
    createdAt: serverTimestamp(),
    players: { [playerId]: { name, status: 'waiting', online: true, joinedAt: serverTimestamp() } },
  });
  enterRoom(code);
}

async function joinRoom(code, name) {
  const snap = await get(roomRef(code));
  if (!snap.exists()) throw new Error('존재하지 않는 방 코드예요.');
  const players = snap.val().players || {};
  if (snap.val().kicked?.[playerId]) throw new Error('방장이 이 방에서 내보냈어요.');
  if (players[playerId]?.name) {
    const patch = { online: true, offlineSince: null };
    if (name) patch.name = name;
    await update(roomRef(code, 'players', playerId), patch);
  } else {
    if (!name) throw new Error('닉네임을 입력해주세요.');
    if (Object.keys(players).length >= MAX_PLAYERS) throw new Error(`방이 가득 찼어요. (최대 ${MAX_PLAYERS}명)`);
    // 게임 도중에 들어오면 'waiting'(관전) 상태로 있다가 다음 판부터 참가
    await set(roomRef(code, 'players', playerId), { name, status: 'waiting', online: true, joinedAt: serverTimestamp() });
  }
  enterRoom(code);
}

function enterRoom(code) {
  currentCode = code;
  store.set('nr.room', code, ss);
  history.replaceState(null, '', '?room=' + code);
  setupPresence();
  unsubscribeRoom?.();
  unsubscribeRoom = onValue(roomRef(code), (snap) => {
    const v = snap.val();
    const kicked = !!v?.kicked?.[playerId];
    if (!v || !v.players?.[playerId]?.name || kicked) {
      leaveLocal();
      toast(kicked ? '방장이 방에서 내보냈어요.' : v ? '방에서 나왔어요.' : '방이 사라졌어요.', 'warning');
      return;
    }
    const prevPhase = phase();
    room = {
      code,
      ...v,
      // 이름이 없는 항목은 내보낸 사람의 연결 끊김 기록이 남은 것이므로 무시
      players: Object.entries(v.players || {}).filter(([, p]) => p?.name).map(([id, p]) => ({ id, ...p })),
    };
    room.ghosts = Object.entries(v.players || {}).filter(([id, p]) => !p?.name || v.kicked?.[id]).map(([id]) => id);
    if (prevPhase === 'countdown' && phase() === 'playing') toast('출발! 링크만 타고 목표 문서까지 가세요.', 'success');
    if ((prevPhase === 'countdown' || prevPhase === 'playing') && phase() === 'results') showEnd();
    announceArrivals();
    render();
    maintain();
  });
}

// 게임이 끝나면 화면 가운데에 '게임 완료!' 알림
function showEnd() {
  const dlgEnd = $('#end-dialog');
  const winner = ranking(room).find((p) => p.status === 'finished');
  const score = (p) => (room.mode === 'clicks' ? `${p.clicks}클릭 · ${fmtTimePrecise(p.elapsed)}` : `${fmtTimePrecise(p.elapsed)} · ${p.clicks}클릭`);
  if (!winner) {
    $('#end-winner').textContent = '도착한 사람이 없어요';
    $('#end-sub').textContent = room.timeLimitMin ? '제한 시간이 끝났어요.' : '';
  } else if (winner.id === playerId) {
    $('#end-winner').innerHTML = '축하해요! <b>1등</b>이에요 🎉';
    $('#end-sub').textContent = score(winner);
  } else {
    $('#end-winner').innerHTML = `1등 <b>${esc(winner.name)}</b>`;
    const mine = me();
    $('#end-sub').textContent = score(winner) + (mine?.status === 'finished' ? '' : room.mode === 'relay' && mine?.status ? ` · 나는 ${mine.leg || 0}/${targetsOf(room).length}단계` : '');
  }
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
    await remove(roomRef(code));
    return;
  }
  const updates = { [`players/${playerId}`]: null };
  if (r.hostId === playerId) updates.hostId = (others.find((p) => p.online) || others[0]).id;
  await update(roomRef(code), updates);
}

function leaveLocal() {
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
  show('home');
}

// ---------- 방장 동작 ----------
function startRound() {
  if (!isHost()) return;
  const relay = room.mode === 'relay';
  const picked = pickKeywords(room.round ? room : null, relay ? (room.legs || 2) : 1);
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
  if (room?.state === 'playing') update(roomRef(room.code), { state: 'results' });
}

// 누구나 실행해도 결과가 같은(멱등) 정리 작업: 라운드 종료, 방장 넘기기
function maintain() {
  if (!room) return;
  if (isHost() && room.ghosts?.length) {
    const fix = {};
    for (const id of room.ghosts) fix[`players/${id}`] = null;
    update(roomRef(room.code), fix);
  }
  if (room.state === 'playing' && now() >= room.startAt) {
    const allDone = !room.players.some((p) => p.status === 'playing');
    const timeUp = room.timeLimitMin > 0 && now() >= room.startAt + room.timeLimitMin * 60000;
    // 타임어택은 1등이 나오는 순간 게임 종료
    const winner = room.mode !== 'clicks' && room.players.some((p) => p.status === 'finished');
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

// ---------- 홈 이벤트 ----------
function getName() {
  const n = cleanName(nameInput.value);
  if (!n) { setHomeError('닉네임을 입력해주세요.'); nameInput.focus(); return null; }
  store.set('nr.name', n);
  return n;
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
function join() {
  const name = getName();
  const code = $('#code').value.trim().toUpperCase();
  if (!name) return;
  if (!/^[A-Z0-9]{4}$/.test(code)) { setHomeError('4자리 방 코드를 입력해주세요.'); return; }
  guarded($('#btn-join'), () => joinRoom(code, name));
}
$('#btn-join').onclick = join;
$('#code').addEventListener('keydown', (e) => e.key === 'Enter' && join());
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($('#code').value.trim() ? join() : $('#btn-create').click());
});
$$('.btn-leave').forEach((b) => (b.onclick = () => confirm('방에서 나갈까요?') && leaveRoom()));

// ---------- 로비 이벤트 ----------
$$('#mode-seg button').forEach((b) => (b.onclick = () => isHost() && update(roomRef(room.code), { mode: b.dataset.mode })));
$('#time-limit').onchange = (e) => isHost() && update(roomRef(room.code), { timeLimitMin: Number(e.target.value) });
$('#legs').onchange = (e) => isHost() && update(roomRef(room.code), { legs: Number(e.target.value) });
$('#round-trip').onclick = () => isHost() && update(roomRef(room.code), { roundTrip: !room.roundTrip });
$('#btn-start').onclick = startRound;
$('#btn-copy').onclick = async () => {
  const url = location.origin + location.pathname + '?room=' + room.code;
  try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요!', 'success'); }
  catch { prompt('이 링크를 복사해서 보내세요', url); }
};

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
function avatar(p) {
  let h = 0;
  for (const ch of p.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initial = [...(p.name || '?')][0].toUpperCase();
  return `<span class="avatar" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}">${esc(initial)}`
    + `<span class="badge-dot ${p.online ? '' : 'off'}" title="${p.online ? '접속 중' : '연결 끊김'}"></span></span>`;
}
function playerRow(p, extra = '') {
  const tags = [];
  if (p.id === room.hostId) tags.push('<span class="tag tag-warning">방장</span>');
  if (p.id === playerId) tags.push('<span class="tag tag-blue">나</span>');
  const kick = isHost() && p.id !== playerId
    ? `<button class="kick" data-kick="${esc(p.id)}" title="${esc(p.name)}님 내보내기" aria-label="${esc(p.name)}님 내보내기">${icon('kick')}</button>` : '';
  return `<li>${avatar(p)}<span class="name">${esc(p.name)}</span><span class="tags">${tags.join('')}${extra}</span>${kick}</li>`;
}

function render() {
  const ph = phase();
  lastPhase = ph;
  $('#ext-installed').classList.toggle('hidden', !ext.ready);
  if (ph === 'home') { syncExt(); return show('home'); }
  const host = isHost();
  const my = me();

  if (ph === 'lobby') {
    show('lobby');
    $('#lobby-code').textContent = room.code;
    $$('#mode-seg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === room.mode);
      b.disabled = !host;
    });
    $('#mode-desc').textContent = modeDesc(room.mode);
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
    $('#btn-start').classList.toggle('hidden', !host);
    $('#wait-host').classList.toggle('hidden', host);
  } else if (ph === 'countdown') {
    show('countdown');
  } else if (ph === 'playing') {
    show('play');
    $('#play-mode').textContent = modeLabel(room.mode) + (room.timeLimitMin ? ` · ${room.timeLimitMin}분 제한` : '');
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
    renderProgress();
    $('#play-spectator').classList.toggle('hidden', status !== 'waiting');
    const done = $('#play-done');
    done.classList.toggle('hidden', status !== 'finished' && status !== 'gaveup');
    if (status === 'finished') {
      done.innerHTML = `<div class="card done-box ok">${icon('check')}<div><p class="done-title">도착 완료! ${fmtTimePrecise(my.elapsed)} · ${my.clicks}클릭</p><p class="text-tertiary">다른 사람들이 끝나길 기다리는 중…</p></div></div>`;
    } else if (status === 'gaveup') {
      done.innerHTML = `<div class="card done-box out">${icon('close')}<div><p class="done-title">포기했어요</p><p class="text-tertiary">다른 사람들이 끝나길 기다리는 중…</p></div></div>`;
    }
    const ranked = ranking(room);
    const spectators = room.players.filter((p) => !ranked.includes(p));
    $('#play-players').innerHTML = [...ranked, ...spectators].map((p) => {
      const relay = room.mode === 'relay';
      const legStr = relay ? ` · ${p.leg || 0}/${targets.length}단계` : '';
      let tag = `<span class="tag tag-processing">달리는 중${legStr}${p.auto && p.clicks != null ? ` · ${p.clicks}클릭째` : ''}</span>`;
      if (p.status === 'finished') tag = `<span class="tag tag-success">${room.mode === 'clicks' ? p.clicks + '클릭 · ' : ''}${fmtTimePrecise(p.elapsed)}</span>`;
      else if (p.status === 'gaveup') tag = '<span class="tag tag-error">포기</span>';
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
    if (!finished) score = `<span class="muted">${p.status === 'gaveup' ? '포기' : '미도착'}${relay ? `<small>${legDots(p, targets.length)} ${p.leg || 0}/${targets.length}단계</small>` : ''}</span>`;
    else if (room.mode === 'clicks') score = `${p.clicks}클릭<small>${fmtTimePrecise(p.elapsed)}</small>`;
    else score = `${fmtTimePrecise(p.elapsed)}<small>${p.clicks}클릭</small>`;
    // 자동 기록이면 각 이동이 링크 클릭이었는지 표시, 수동 기록이면 적은 경로만 표시
    const steps = Array.isArray(p.steps) ? p.steps : Array.isArray(p.path) ? p.path.map((title, i) => ({ title, cp: relay && i > 0 && targets.includes(title) })) : [];
    const badMark = { back: '뒤로가기', other: '링크 클릭 아님' };
    const cls = (s) => (badMark[s.h] ? ` class="bad" title="${badMark[s.h]}"` : s.cp ? ' class="cp" title="목표 도착"' : '');
    const path = steps.length
      ? `<div class="path">${steps.map((s) => `<a href="${namuUrl(s.title)}" target="_blank" rel="noopener"${cls(s)}>${esc(s.title)}</a>`).join(icon('right', 'sep'))}</div>`
      : '';
    const flags = [];
    // 릴레이: 목표마다 도착 시간
    if (relay && p.legTimes?.length) {
      flags.push(...p.legTimes.map((t, i) => `<span class="tag tag-success">${i + 1}. ${esc(targets[i])} ${fmtTimePrecise(t)}</span>`));
    }
    if (finished && p.auto === false) flags.push('<span class="tag tag-warning">수동 기록</span>');
    if (p.violations) flags.push(`<span class="tag tag-error">규칙 위반 의심 ${p.violations}회</span>`);
    const mine = p.id === playerId ? ' <span class="tag tag-blue">나</span>' : '';
    return `<li class="${finished && rank === 1 ? 'first' : ''}"><div class="head">${rankStr}<span class="name">${esc(p.name)}${mine}</span><span class="score">${score}</span></div>${path}${flags.length ? `<div class="flags">${flags.join('')}</div>` : ''}</li>`;
  });
  $('#res-list').innerHTML = items.join('') || '<li class="text-tertiary center">참가자가 없어요.</li>';
  $('#res-host').classList.toggle('hidden', !host);
  $('#res-wait').classList.toggle('hidden', host);
}

// 타이머 / 카운트다운 / 단계 전환
function tick() {
  if (!room) return;
  const ph = phase();
  if (ph !== lastPhase) { render(); maintain(); return; }
  if (ph === 'countdown') {
    $('#countdown').textContent = Math.max(1, Math.ceil((room.startAt - now()) / 1000));
  } else if (ph === 'playing') {
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

// ---------- 시작: 새로고침했으면 같은 방으로 자동 복귀 ----------
show('home');
const savedCode = store.get('nr.room', ss);
if (savedCode) {
  joinRoom(savedCode, store.get('nr.name') || '').catch(() => {
    store.del('nr.room', ss);
    toast('이전 방에 다시 들어가지 못했어요.', 'warning');
  });
}
