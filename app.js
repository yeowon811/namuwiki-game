import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getDatabase, ref, get, set, update, remove, push, onValue, onDisconnect, serverTimestamp, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import KEYWORDS from './keywords.js';
import { SLOTS, cleanAcc, glyphOf } from './accessories.js';

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

const params = new URLSearchParams(location.search);
// 초대 링크(?room=ABCD)로 들어오면 '초대받은 방 참가하기' 버튼을 보여줌
const inviteCode = /^[A-Z0-9]{4}$/i.test(params.get('room') || '') ? params.get('room').toUpperCase() : null;
if (inviteCode) {
  $('#btn-invite').textContent = `초대받은 방 (${inviteCode}) 참가하기`;
  $('#btn-invite').classList.remove('hidden');
}

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
    submitDailyIfDone();
    claimRoundRewards();
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
    await remove(roomRef(code));
    remove(ref(db, `lobbies/${code}`)).catch(() => {});
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
  plaza3d?.pause();
  showHome();
}

// ---------- 방장 동작 ----------
function startRound() {
  if (!isHost()) return;
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
    count: room.players.length,
    state: room.state,
    mode: room.mode,
  };
  const key = JSON.stringify(summary);
  if (key === lobbySent.key && Date.now() - lobbySent.at < LOBBY_BEAT_MS) return;
  lobbySent = { key, at: Date.now() };
  set(lobbyRef, { ...summary, updatedAt: serverTimestamp() }).catch((e) => console.warn('[방 목록]', e.message));
}

function maintain() {
  if (!room) return;
  publishLobby();
  if (isHost() && room.ghosts?.length) {
    const fix = {};
    for (const id of room.ghosts) fix[`players/${id}`] = null;
    update(roomRef(room.code), fix);
  }
  if (room.state === 'playing' && now() >= room.startAt) {
    const allDone = !room.players.some((p) => p.status === 'playing');
    const timeUp = room.timeLimitMin > 0 && now() >= room.startAt + room.timeLimitMin * 60000;
    // 타임어택은 1등이 나오는 순간 게임 종료
    // 타임어택·릴레이는 설정한 등수(1~3등)까지 나오면 게임 종료
    const winner = room.mode !== 'clicks'
      && room.players.filter((p) => p.status === 'finished').length >= (room.winners || 1);
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
      const e = esc(safeGlyph(l.e, '🏁'));
      return `<li><span class="avatar" style="background:var(--color-primary-bg);font-size:18px">${e}</span>`
        + `<div class="info"><span class="title">${esc(l.name || '이름 없음')}님의 방</span>`
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
  daily.unsub.push(onValue(dailyRef(date, 'best'), (s) => { daily.best = s.val() || {}; renderDaily(); }, fail));
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
function renderDaily() {
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
      + `<span class="nm">${safeGlyph(r.e) ? esc(r.e) + ' ' : ''}${esc(r.name)}</span><span class="tm">${fmtTimePrecise(r.ms)}</span></li>`).join('')
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
  await set(roomRef(code), {
    hostId: playerId,
    mode: 'relay',
    legs: 2,
    timeLimitMin: 0,
    state: 'lobby',
    round: 0,
    public: false,
    daily: { date, start: pz.start, targets: pz.targets },
    createdAt: serverTimestamp(),
    players: { [playerId]: { name, status: 'waiting', online: true, joinedAt: serverTimestamp() } },
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

$$('.btn-leave').forEach((b) => (b.onclick = () => confirm('방에서 나갈까요?') && leaveRoom()));

// ---------- 로비 이벤트 ----------
$$('#mode-seg button').forEach((b) => (b.onclick = () => isHost() && update(roomRef(room.code), { mode: b.dataset.mode })));
$('#time-limit').onchange = (e) => isHost() && update(roomRef(room.code), { timeLimitMin: Number(e.target.value) });
$('#public-room').onclick = () => isHost() && update(roomRef(room.code), { public: room.public === false });
$('#winners').onchange = (e) => isHost() && update(roomRef(room.code), { winners: Number(e.target.value) });
$('#legs').onchange = (e) => isHost() && update(roomRef(room.code), { legs: Number(e.target.value) });
$('#round-trip').onclick = () => isHost() && update(roomRef(room.code), { roundTrip: !room.roundTrip });
$('#btn-start').onclick = startRound;
$('#btn-copy').onclick = async () => {
  const url = location.origin + location.pathname + '?room=' + room.code;
  try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요!', 'success'); }
  catch { prompt('이 링크를 복사해서 보내세요', url); }
};

// ---------- 대기실 광장 이벤트 ----------
$('#plaza').addEventListener('click', (e) => {
  if (!room || !me() || plaza3d) return;
  const r = e.currentTarget.getBoundingClientRect();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const x = Math.round(clamp((e.clientX - r.left) / r.width, 0.06, 0.94) * 1000) / 1000;
  const y = Math.round(clamp((e.clientY - r.top) / r.height, 0.22, 0.86) * 1000) / 1000;
  update(roomRef(room.code, 'players', playerId), { pos: { x, y } });
});
$('#btn-char').onclick = (e) => {
  const open = $('#char-picker').classList.toggle('hidden') === false;
  e.currentTarget.setAttribute('aria-expanded', String(open));
  e.currentTarget.textContent = open ? '닫기' : '내 캐릭터 꾸미기';
};
$('#char-picker').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !room || !me()) return;
  const cur = charOf(me());
  const next = { c: cur.c, ...cur.acc };
  if (b.dataset.c) next.c = b.dataset.c;
  if (b.dataset.slot) next[b.dataset.slot] = cur.acc[b.dataset.slot] === b.dataset.id ? null : (b.dataset.id || null); // 한 번 더 누르면 벗기
  update(roomRef(room.code, 'players', playerId), { char: next });
});
let lastChatAt = 0;
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!text || !room || !me()) return;
  if (Date.now() - lastChatAt < 600) return; // 도배 방지
  lastChatAt = Date.now();
  input.value = '';
  push(roomRef(room.code, 'chat'), { pid: playerId, name: me().name, e: charOf(me()).e, text, t: serverTimestamp() });
  // 오래된 대화는 정리 (최근 60개만 남김)
  const all = chatList();
  if (all.length > 80) {
    const old = {};
    for (const m of all.slice(0, all.length - 60)) old[`chat/${m.id}`] = null;
    update(roomRef(room.code), old);
  }
});

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
// ---------- 캐릭터 ----------
// 목록에 저장된 대표 이모지는 짧은 글자만 사용
const safeGlyph = (e, fallback = '') => (typeof e === 'string' && e.length > 0 && e.length <= 4 ? e : fallback);
const hashOf = (id, salt = 0) => {
  let h = salt;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};
// 고른 캐릭터가 없으면 아이디로 정해지는 기본 캐릭터
// 캐릭터 = 몸 색 + 액세서리(머리, 눈, 얼굴, 목). e는 목록에 쓰는 대표 이모지
function charOf(p) {
  const c = AVATAR_COLORS.includes(p?.char?.c) ? p.char.c : AVATAR_COLORS[hashOf(p?.id, 7) % AVATAR_COLORS.length];
  const acc = cleanAcc(p?.char);
  return { c, acc, e: glyphOf(acc) };
}
// 광장 위치 (0~1). 아직 안 움직였으면 아이디로 정해지는 자리
function posOf(p) {
  const ok = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  if (ok(p?.pos?.x) && ok(p?.pos?.y)) return p.pos;
  return { x: 0.12 + ((hashOf(p.id, 3) % 1000) / 1000) * 0.76, y: 0.3 + ((hashOf(p.id, 5) % 1000) / 1000) * 0.45 };
}

function avatar(p) {
  const { e, c } = charOf(p);
  return `<span class="avatar" style="background:${c};font-size:18px">${e}`
    + `<span class="badge-dot ${p.online ? '' : 'off'}" title="${p.online ? '접속 중' : '연결 끊김'}"></span></span>`;
}

// ---------- 대기실 광장 ----------
const BUBBLE_MS = 6000;
const chatList = () => Object.entries(room?.chat || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, m]) => ({ id, ...m }));

// 3D 광장: three.js를 불러올 수 있고 WebGL이 되면 3D, 아니면 아래 2D 광장
let plaza3d = null;
let plaza3dState = 'idle'; // idle → loading → ready | failed
function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
function loadPlaza3D() {
  if (plaza3dState !== 'idle') return;
  if (!webglOk()) { plaza3dState = 'failed'; return; }
  plaza3dState = 'loading';
  import('./plaza3d.js?v=6')
    .then(({ createPlaza3D }) => {
      const el = $('#plaza');
      plaza3d = createPlaza3D(el, {
        onMove: (x, y, run) => room && me() && update(roomRef(room.code, 'players', playerId), { pos: { x, y, run: !!run } }),
        onJump: () => room && me() && update(roomRef(room.code, 'players', playerId), { jumpAt: serverTimestamp() }),
      });
      el.classList.add('is-3d');
      el.querySelectorAll('.pz').forEach((n) => el.removeChild(n));
      plaza3dState = 'ready';
      if (room && phase() === 'lobby') renderPlaza();
      else plaza3d.pause();
    })
    .catch((e) => {
      console.warn('3D 광장을 불러오지 못해 2D로 표시해요.', e);
      plaza3dState = 'failed';
    });
}

function renderPlaza() {
  const el = $('#plaza');
  loadPlaza3D();
  if (plaza3d) {
    plaza3d.resume();
    plaza3d.update(room.players.map((p) => ({
      id: p.id, name: p.name, ...charOf(p), ...posOf(p), run: !!p.pos?.run,
      jumpAt: p.jumpAt || null, jumpAgo: p.jumpAt ? now() - p.jumpAt : Infinity,
      online: p.online, me: p.id === playerId,
    })));
    renderBubbles();
    return;
  }
  const keep = new Set();
  for (const p of room.players) {
    keep.add(p.id);
    let node = [...el.querySelectorAll('.pz')].find((n) => n.dataset.pid === p.id);
    if (!node) {
      node = document.createElement('div');
      node.className = 'pz';
      node.dataset.pid = p.id;
      node.innerHTML = '<div class="bubble"></div><div class="body"></div><div class="nm"></div>';
      el.appendChild(node);
    }
    const { e, c } = charOf(p);
    const { x, y } = posOf(p);
    node.classList.toggle('me', p.id === playerId);
    node.classList.toggle('off', !p.online);
    const body = node.querySelector('.body');
    body.textContent = e;
    body.style.background = c;
    node.querySelector('.nm').textContent = p.name;
    const key = `${x},${y}`;
    if (node.dataset.pos && node.dataset.pos !== key) {
      node.classList.remove('walk');
      void node.offsetWidth;
      node.classList.add('walk');
    }
    node.dataset.pos = key;
    node.style.left = `${x * 100}%`;
    node.style.top = `${y * 100}%`;
  }
  // 나간 사람의 캐릭터는 광장에서 치움
  el.querySelectorAll('.pz').forEach((n) => { if (!keep.has(n.dataset.pid)) el.removeChild(n); });
  renderBubbles();
}

// 최근 6초 안에 한 말을 머리 위 말풍선으로
function renderBubbles() {
  if (!room) return;
  const latest = new Map();
  const cutoff = now() - BUBBLE_MS;
  for (const m of chatList()) if (typeof m.t === 'number' && m.t >= cutoff) latest.set(m.pid, m.text);
  if (plaza3d) { plaza3d.setBubbles(latest); return; }
  $$('#plaza .pz').forEach((n) => {
    const text = latest.get(n.dataset.pid) || '';
    const b = n.querySelector('.bubble');
    if (b.textContent !== text) b.textContent = text;
  });
}

let chatSig = null;
function renderChat() {
  const msgs = chatList().slice(-50);
  const last = msgs[msgs.length - 1];
  const sig = `${msgs.length}/${last?.id || ''}/${last?.t || ''}/${room.players.map((p) => charOf(p).e).join('')}`;
  if (sig === chatSig) return;
  chatSig = sig;
  const log = $('#chat-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = msgs.map((m) => {
    const p = room.players.find((x) => x.id === m.pid);
    const e = p ? charOf(p).e : esc(safeGlyph(m.e));
    return `<li class="${m.pid === playerId ? 'me' : ''}"><span class="who"><span class="em">${e}</span>${esc(p?.name || m.name)}</span><span class="txt">${esc(m.text)}</span></li>`;
  }).join('');
  if (nearBottom || last?.pid === playerId) log.scrollTop = log.scrollHeight;
}

function renderPicker() {
  const mine = charOf(me());
  const box = $('#char-acc');
  if (!box.children.length) {
    $('#char-colors').innerHTML = AVATAR_COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c}" aria-label="몸 색 ${c}"></button>`).join('');
    box.innerHTML = SLOTS.map((s) => `<div class="acc-slot"><div class="form-label">${s.label}</div><div class="acc-grid">`
      + `<button type="button" data-slot="${s.key}" data-id="">없음</button>`
      + s.items.map((it) => `<button type="button" data-slot="${s.key}" data-id="${it.id}"><span class="em">${it.emoji}</span>${it.label}</button>`).join('')
      + '</div></div>').join('');
  }
  $$('#char-colors button').forEach((b) => b.classList.toggle('active', b.dataset.c === mine.c));
  $$('#char-acc button').forEach((b) => b.classList.toggle('active', (mine.acc[b.dataset.slot] || '') === b.dataset.id));
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
  if (ph !== 'lobby') plaza3d?.pause();
  if (ph === 'home') { syncExt(); return showHome(); }
  unwatchLobbies();
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
    renderProgress();
    $('#play-spectator').classList.toggle('hidden', status !== 'waiting');
    const done = $('#play-done');
    done.classList.toggle('hidden', status !== 'finished' && status !== 'gaveup');
    if (status === 'finished') {
      const rank = room.mode === 'clicks' ? 0 : ranking(room).filter((p) => p.status === 'finished').findIndex((p) => p.id === playerId) + 1;
      const wait = room.mode !== 'clicks' && (room.winners || 1) > 1 ? `${room.winners}등까지 나오면 게임이 끝나요.` : '다른 사람들이 끝나길 기다리는 중…';
      done.innerHTML = `<div class="card done-box ok">${icon('check')}<div><p class="done-title">${rank ? `${rank}등으로 도착!` : '도착 완료!'} ${fmtTimePrecise(my.elapsed)} · ${my.clicks}클릭</p><p class="text-tertiary">${wait}</p></div></div>`;
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


// ---------- 계정: 로그인 / 회원가입 / 승인 ----------
const auth = getAuth(firebaseApp);
const ID_RE = /^[a-z0-9_]{4,16}$/;
const EMAIL_DOMAIN = 'namurace.app'; // 아이디를 Firebase 로그인용 이메일로 바꿀 때 쓰는 가짜 도메인
const idToEmail = (id) => `${id}@${EMAIL_DOMAIN}`;
// 비밀번호 없이 아이디만으로 로그인: Firebase 로그인에 필요한 비밀번호는 아이디로 자동으로 만듦
const idToPassword = (id) => `namurace-${id}-login`;
let authUser = null;
let profile = null; // users/<uid>
let isAdmin = false;
let profileUnsubs = [];
let authReady = false;
let profileLoaded = false; // users/<uid>를 한 번이라도 받았는지

function authMessage(e) {
  const code = e?.code || '';
  if (/email-already-in-use/.test(code)) return '이미 사용 중인 아이디예요.';
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(code)) return '가입되지 않은 아이디예요. (예전에 비밀번호로 가입한 계정은 다시 가입해야 해요)';
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
  $('#auth-error').textContent = '';
}));

async function authGuard(form, fn) {
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try { await fn(); } catch (e) { console.warn(e); $('#auth-error').textContent = authMessage(e); }
  finally { btn.disabled = false; }
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#login-id').value.trim().toLowerCase();
  if (!ID_RE.test(id)) { $('#auth-error').textContent = '아이디를 확인해주세요. (영어 소문자, 숫자, _ 로 4~16자)'; return; }
  authGuard(e.currentTarget, () => signInWithEmailAndPassword(auth, idToEmail(id), idToPassword(id)));
});

$('#signup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#su-name').value.replace(/\s+/g, ' ').trim().slice(0, 20);
  const nick = cleanName($('#su-nick').value);
  const id = $('#su-id').value.trim().toLowerCase();
  const err = (m) => { $('#auth-error').textContent = m; };
  if (!name) return err('이름을 입력해주세요.');
  if (!nick) return err('닉네임을 입력해주세요.');
  if (!ID_RE.test(id)) return err('아이디는 영어 소문자, 숫자, _ 로 4~16자예요.');
  authGuard(e.currentTarget, async () => {
    signingUp = true;
    const cred = await createUserWithEmailAndPassword(auth, idToEmail(id), idToPassword(id));
    const uid = cred.user.uid;
    try {
      await update(ref(db), {
        [`ids/${id}`]: uid,
        [`users/${uid}`]: {
          id, nick, approved: false, points: 0, createdAt: serverTimestamp(),
          stats: { games: 0, win1: 0, win2: 0, win3: 0, daily1: 0 },
        },
        [`private/${uid}`]: { name },
      });
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
  await signOut(auth);
}));

function watchProfile(uid) {
  profileUnsubs.forEach((u) => u());
  profileUnsubs = [
    onValue(ref(db, `users/${uid}`), (s) => {
      const prev = profile;
      profile = s.val();
      profileLoaded = true;
      if (prev && profile) notifyGiftIn(prev, profile);
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
  isAdmin = false;
  if (!user) {
    playerId = null;
    if (room) leaveLocal();
    unwatchLobbies();
    unwatchDaily();
    showHome();
    return;
  }
  playerId = user.uid;
  if (!signingUp) watchProfile(user.uid);
});

function renderHeaderUser() {
  const on = !!(profile && profile.approved);
  $('#hdr-user').classList.toggle('hidden', !on);
  if (on) $('#hdr-user').innerHTML = `${esc(profile.nick)} · <b>${(profile.points || 0).toLocaleString()}P</b>`;
  $('#hdr-admin').classList.toggle('hidden', !isAdmin);
}

// 로그인 상태에 맞는 첫 화면 (방에 들어가 있지 않을 때)
let rejoinTried = false;
function showHome() {
  renderHeaderUser();
  if (room) return;
  if (!authReady) return show('loading');
  if (!authUser) return show('auth');
  if (!profileLoaded) return show('loading');
  if (!profile) {
    if (signingUp) return show('loading');
    // 가입 정보가 없음 (거절되었거나 지워짐)
    show('auth');
    $('#auth-error').textContent = '가입 정보가 없어요. 관리자가 거절했거나 삭제했을 수 있어요.';
    return;
  }
  if (!profile.approved) {
    $('#pending-who').textContent = `${profile.nick} (@${profile.id})`;
    return show('pending');
  }
  show('home');
  renderProfile();
  watchLobbies();
  watchDaily();
  payDailyChampions();
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
  $('#pf-avatar').style.background = AVATAR_BG(authUser.uid);
  $('#pf-avatar').textContent = [...profile.nick][0] || '?';
  $('#pf-nick').textContent = profile.nick;
  $('#pf-id').textContent = `@${profile.id}`;
  $('#pf-points').textContent = `${(profile.points || 0).toLocaleString()} 포인트`;
  const cell = (n, label) => `<div><b>${n || 0}</b><span>${label}</span></div>`;
  $('#pf-stats').innerHTML = cell(st.games, '게임') + cell(st.win1, '🥇 1등') + cell(st.win2, '🥈 2등') + cell(st.win3, '🥉 3등') + cell(st.daily1, '👑 오늘의 챔피언');
  $('#btn-nick').disabled = (profile.points || 0) < 300;
}

// ---------- 닉네임 변경 (300포인트) ----------
$('#btn-nick').onclick = () => {
  $('#nick-have').textContent = `${(profile.points || 0).toLocaleString()}P`;
  $('#nick-new').value = '';
  $('#nick-error').textContent = '';
  $('#nick-dialog').showModal();
  $('#nick-new').focus();
};
$('#nick-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const nick = cleanName($('#nick-new').value);
  if (!nick) { $('#nick-error').textContent = '새 닉네임을 입력해주세요.'; return; }
  if (nick === profile.nick) { $('#nick-error').textContent = '지금 닉네임과 같아요.'; return; }
  if ((profile.points || 0) < 300) { $('#nick-error').textContent = '포인트가 부족해요.'; return; }
  $('#nick-submit').disabled = true;
  try {
    await update(ref(db, `users/${authUser.uid}`), { nick, points: profile.points - 300 });
    $('#nick-dialog').close();
    toast(`닉네임을 '${nick}'(으)로 바꿨어요. (-300P)`, 'success');
  } catch (err) {
    $('#nick-error').textContent = authMessage(err);
  } finally {
    $('#nick-submit').disabled = false;
  }
});

// ---------- 포인트 선물 ----------
$('#btn-gift').onclick = () => {
  $('#gift-have').textContent = `${(profile.points || 0).toLocaleString()}P`;
  $('#gift-to').value = '';
  $('#gift-amt').value = '';
  $('#gift-error').textContent = '';
  $('#gift-dialog').showModal();
  $('#gift-to').focus();
};
$('#gift-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const err = (m) => { $('#gift-error').textContent = m; };
  const toId = $('#gift-to').value.trim().toLowerCase();
  const amt = Number($('#gift-amt').value);
  if (!ID_RE.test(toId)) return err('받는 사람 아이디를 확인해주세요.');
  if (toId === profile.id) return err('나에게는 선물할 수 없어요.');
  if (!Number.isInteger(amt) || amt < 1) return err('1 이상의 정수로 적어주세요.');
  $('#gift-submit').disabled = true;
  try {
    const toUid = (await get(ref(db, `ids/${toId}`))).val();
    if (!toUid) return err('그런 아이디가 없어요.');
    const [meSnap, toSnap] = await Promise.all([get(ref(db, `users/${authUser.uid}`)), get(ref(db, `users/${toUid}`))]);
    const mine = meSnap.val();
    const them = toSnap.val();
    if (!them) return err('그런 회원이 없어요.');
    if ((mine.points || 0) < amt) return err(`포인트가 부족해요. (지금 ${mine.points || 0}P)`);
    const key = push(ref(db, 'gifts')).key;
    await update(ref(db), {
      [`gifts/${key}`]: { from: authUser.uid, to: toUid, amt, fromNick: mine.nick, toNick: them.nick, at: serverTimestamp() },
      [`users/${toUid}/points`]: (them.points || 0) + amt,
      [`users/${toUid}/lastGiftIn`]: { key, from: authUser.uid, amt },
      [`users/${authUser.uid}/points`]: mine.points - amt,
    });
    $('#gift-dialog').close();
    toast(`${them.nick}님에게 ${amt}P를 선물했어요!`, 'success');
  } catch (e2) {
    err(authMessage(e2));
  } finally {
    $('#gift-submit').disabled = false;
  }
});
// 선물을 받으면 알림
function notifyGiftIn(prev, cur) {
  const g = cur.lastGiftIn;
  if (!g || g.key === prev.lastGiftIn?.key) return;
  get(ref(db, `gifts/${g.key}`)).then((s) => {
    const nick = s.val()?.fromNick || '누군가';
    toast(`🎁 ${nick}님이 ${g.amt}P를 선물했어요!`, 'success');
  }).catch(() => toast(`🎁 ${g.amt}P를 선물 받았어요!`, 'success'));
}

// ---------- 승리 포인트 (1등 100, 2등 50, 3등 30) ----------
// 로그인한 2명 이상이 한 판에서만. 2등은 3명 이상, 3등은 4명 이상일 때
const PRIZE = [100, 50, 30];
let claimedKey = null;
async function claimRoundRewards() {
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
    if (!(lastGame && lastGame.code === code && lastGame.round === round)) {
      updates[`users/${authUser.uid}/lastGame`] = { code, round };
      updates[`users/${authUser.uid}/stats/games`] = (prof.stats?.games || 0) + 1;
    }
    const amt = rank >= 1 && rank <= 3 && participants >= rank + 1 ? PRIZE[rank - 1] : 0;
    if (amt) {
      const claimed = (await get(ref(db, `claims/${code}/${authUser.uid}`))).val();
      if (!(typeof claimed === 'number' && claimed >= round)) {
        updates[`users/${authUser.uid}/points`] = (prof.points || 0) + amt;
        updates[`users/${authUser.uid}/lastWin`] = { code, round, amt };
        updates[`users/${authUser.uid}/stats/win${rank}`] = (prof.stats?.[`win${rank}`] || 0) + 1;
        updates[`claims/${code}/${authUser.uid}`] = round;
      }
    }
    if (!Object.keys(updates).length) return;
    await update(ref(db), updates);
    if (updates[`claims/${code}/${authUser.uid}`] != null) {
      toast(`${rank}등! +${amt} 포인트`, 'success');
      const sub = $('#end-sub');
      if ($('#end-dialog').open && !sub.textContent.includes('포인트')) sub.textContent = [sub.textContent, `+${amt} 포인트`].filter(Boolean).join(' · ');
    }
  } catch (e) {
    console.warn('[포인트]', e.message);
  }
}

// ---------- 오늘의 챔피언 포인트: 하루가 지나면 그날 1·2·3등에게 지급 ----------
function prevDateKey(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
let dailyPayChecked = null;
async function payDailyChampions() {
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

// ---------- 시작 ----------
show('loading');
