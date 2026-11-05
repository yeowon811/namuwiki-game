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
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}
const modeLabel = (m) => (m === 'clicks' ? '👆 최소 클릭' : '⏱️ 타임어택');
const modeDesc = (m) => (m === 'clicks'
  ? '가장 적은 클릭으로 도착한 사람이 이겨요. 클릭 수가 같으면 더 빨리 도착한 사람이 이겨요.'
  : '목표 문서에 가장 빨리 도착한 사람이 이겨요.');
const show = (screen) => $$('.screen').forEach((el) => el.classList.toggle('hidden', el.id !== 'screen-' + screen));
const isHost = () => room?.hostId === playerId;
const me = () => room?.players.find((p) => p.id === playerId);

function pickKeywords(prev) {
  const pick = () => KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
  let start, target;
  do { start = pick(); target = pick(); }
  while (start === target || (prev && (start === prev.start || target === prev.target)));
  return { start, target };
}

function ranking(r) {
  const players = r.players.filter((p) => p.status && p.status !== 'waiting');
  const finished = players.filter((p) => p.status === 'finished');
  finished.sort((a, b) => (r.mode === 'clicks' ? a.clicks - b.clicks || a.elapsed - b.elapsed : a.elapsed - b.elapsed));
  return [...finished, ...players.filter((p) => p.status !== 'finished')];
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
  if (players[playerId]) {
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
    if (!v || !v.players?.[playerId]) {
      leaveLocal();
      toast(v ? '방에서 나왔어요.' : '방이 사라졌어요.');
      return;
    }
    const prevPhase = phase();
    room = {
      code,
      ...v,
      players: Object.entries(v.players || {}).map(([id, p]) => ({ id, ...p })),
    };
    if (prevPhase === 'countdown' && phase() === 'playing') toast('출발! 🏁');
    render();
    maintain();
  });
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
  const { start, target } = pickKeywords(room.round ? room : null);
  const updates = {
    state: 'playing',
    round: (room.round || 0) + 1,
    start,
    target,
    startAt: now() + COUNTDOWN_MS,
  };
  for (const p of room.players) {
    // 연결이 끊긴 사람은 이번 판에서 제외 (안 그러면 게임이 끝나지 않음)
    updates[`players/${p.id}/status`] = p.online ? 'playing' : 'waiting';
    updates[`players/${p.id}/elapsed`] = null;
    updates[`players/${p.id}/clicks`] = null;
    updates[`players/${p.id}/path`] = null;
  }
  update(roomRef(room.code), updates);
}

function endRound() {
  if (room?.state === 'playing') update(roomRef(room.code), { state: 'results' });
}

// 누구나 실행해도 결과가 같은(멱등) 정리 작업: 라운드 종료, 방장 넘기기
function maintain() {
  if (!room) return;
  if (room.state === 'playing' && now() >= room.startAt) {
    const allDone = !room.players.some((p) => p.status === 'playing');
    const timeUp = room.timeLimitMin > 0 && now() >= room.startAt + room.timeLimitMin * 60000;
    if (allDone || timeUp) endRound();
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
$('#btn-start').onclick = startRound;
$('#btn-copy').onclick = async () => {
  const url = location.origin + location.pathname + '?room=' + room.code;
  try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요!'); }
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

const dlg = $('#arrive-dialog');
const pathArea = $('#arrive-path');
const parsePath = () => pathArea.value.split('\n').map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 100);
const updateArriveCount = () => { $('#arrive-count').textContent = `총 ${parsePath().length + 1}클릭`; };
pathArea.addEventListener('input', updateArriveCount);
$('#btn-arrive').onclick = () => {
  arrivedAt = now(); // 기록 시간은 이 버튼을 누른 순간 기준
  $('#arrive-start').textContent = room.start;
  $('#arrive-target').textContent = room.target;
  $('#arrive-error').textContent = '';
  $('#arrive-clicks-note').textContent = room.mode === 'clicks'
    ? '최소 클릭 모드에서는 적은 문서 수로 클릭 수를 계산해요. 정확하게 적어주세요!'
    : '타임어택 모드에서 경로는 선택이에요. 시간은 도착 버튼을 누른 순간으로 기록돼요.';
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
  $('#arrive-submit').disabled = true;
  try {
    await update(roomRef(room.code, 'players', playerId), {
      status: 'finished',
      elapsed: Math.max(0, (arrivedAt ?? now()) - room.startAt),
      clicks: path.length - 1,
      path,
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
function playerRow(p, extra = '') {
  const mine = p.id === playerId ? '<span class="me">나</span>' : '';
  const crown = p.id === room.hostId ? '👑 ' : '';
  return `<li><span class="dot ${p.online ? '' : 'off'}" title="${p.online ? '접속 중' : '연결 끊김'}"></span>
    <span class="name">${crown}${esc(p.name)}</span>${mine}${extra}</li>`;
}

function render() {
  const ph = phase();
  lastPhase = ph;
  if (ph === 'home') return show('home');
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
    $('#play-target').textContent = room.target;
    $('#play-start-link').href = namuUrl(room.start);
    const status = my?.status;
    $('#play-actions').classList.toggle('hidden', status !== 'playing');
    $('#play-spectator').classList.toggle('hidden', status !== 'waiting');
    const done = $('#play-done');
    done.classList.toggle('hidden', status !== 'finished' && status !== 'gaveup');
    if (status === 'finished') {
      done.innerHTML = `<p><b>도착 완료!</b> ${fmtTimePrecise(my.elapsed)} · ${my.clicks}클릭</p><p class="muted small">다른 사람들이 끝나길 기다리는 중…</p>`;
    } else if (status === 'gaveup') {
      done.innerHTML = '<p>포기했어요.</p><p class="muted small">다른 사람들이 끝나길 기다리는 중…</p>';
    }
    const ranked = ranking(room);
    const spectators = room.players.filter((p) => !ranked.includes(p));
    $('#play-players').innerHTML = [...ranked, ...spectators].map((p) => {
      let tag = '<span class="tag">달리는 중</span>';
      if (p.status === 'finished') tag = `<span class="tag done">${room.mode === 'clicks' ? p.clicks + '클릭 · ' : ''}${fmtTimePrecise(p.elapsed)}</span>`;
      else if (p.status === 'gaveup') tag = '<span class="tag out">포기</span>';
      else if (p.status === 'waiting') tag = '<span class="tag">관전</span>';
      return playerRow(p, tag);
    }).join('');
    $('#btn-end').classList.toggle('hidden', !host);
  } else if (ph === 'results') {
    if (dlg.open) dlg.close();
    show('results');
    renderResults(host);
  }
  tick();
}

function renderResults(host) {
  $('#res-route').innerHTML = `<b>${esc(room.start)}</b> → <b>${esc(room.target)}</b>`;
  $('#res-mode').textContent = modeLabel(room.mode);
  const medals = ['🥇', '🥈', '🥉'];
  let rank = 0;
  const items = ranking(room).map((p) => {
    const finished = p.status === 'finished';
    if (finished) rank += 1;
    const rankStr = finished ? medals[rank - 1] || rank : '-';
    let score;
    if (!finished) score = `<span class="muted">${p.status === 'gaveup' ? '포기' : '미도착'}</span>`;
    else if (room.mode === 'clicks') score = `${p.clicks}클릭<small>${fmtTimePrecise(p.elapsed)}</small>`;
    else score = `${fmtTimePrecise(p.elapsed)}<small>${p.clicks}클릭</small>`;
    const path = finished && Array.isArray(p.path)
      ? `<div class="path">${p.path.map((t) => `<a href="${namuUrl(t)}" target="_blank" rel="noopener">${esc(t)}</a>`).join(' → ')}</div>`
      : '';
    const mine = p.id === playerId ? ' <span class="me">나</span>' : '';
    return `<li><div class="head"><span class="rank">${rankStr}</span><span class="name">${esc(p.name)}${mine}</span><span class="score">${score}</span></div>${path}</li>`;
  });
  $('#res-list').innerHTML = items.join('') || '<li class="muted center">참가자가 없어요.</li>';
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
      timer.textContent = '⏳ ' + fmtTime(left + 999);
      timer.classList.toggle('warn', left < 60000);
      if (left <= 0) maintain();
    } else {
      timer.textContent = fmtTime(elapsed);
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
    toast('이전 방에 다시 들어가지 못했어요.');
  });
}
