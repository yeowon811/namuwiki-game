// 관리자 페이지: 회원 목록, 포인트 조정, 이용 정지, 삭제 (예전 방식 가입의 승인/거절)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, get, set, update, onValue, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

let users = {};
const names = new Map(); // uid → 실명 (private)
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
const gate = (html) => { $('#adm-gate').classList.remove('hidden'); $('#adm-main').classList.add('hidden'); $('#adm-gate').innerHTML = `<div class="adm-msg">${html}</div>`; };
const fmtDate = (t) => (typeof t === 'number' ? new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-');

let unsub = null;
onAuthStateChanged(auth, async (user) => {
  unsub?.();
  if (!user) return gate('먼저 <a class="link" href="./">게임 페이지</a>에서 로그인해 주세요.');
  const isAdmin = (await get(ref(db, `admins/${user.uid}`)).catch(() => null))?.val() === true;
  if (!isAdmin) return gate('관리자만 볼 수 있는 페이지예요.');
  const me = (await get(ref(db, `users/${user.uid}`))).val();
  $('#hdr-user').textContent = me ? `${me.nick} (@${me.id})` : '';
  $('#adm-gate').classList.add('hidden');
  $('#adm-main').classList.remove('hidden');
  loadRoomStats();
  unsub = onValue(ref(db, 'users'), async (s) => {
    users = s.val() || {};
    // 실명은 private에 따로 있어서 한 명씩 읽음
    await Promise.all(Object.keys(users).filter((uid) => !names.has(uid)).map(async (uid) => {
      const v = (await get(ref(db, `private/${uid}`)).catch(() => null))?.val();
      names.set(uid, v?.name || '');
    }));
    render();
    syncNicks();
  }, (e) => gate(`회원 목록을 불러오지 못했어요. (${esc(e.message)})`));
});

function render() {
  const all = Object.entries(users).map(([uid, u]) => ({ uid, ...u, name: names.get(uid) || '' }));
  const pending = all.filter((u) => !u.approved && !u.suspended).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  $('#pending-count').textContent = `${pending.length}명`;
  $('#pending-list').innerHTML = pending.length
    ? pending.map((u) => `<tr><td class="nick">${esc(u.nick)}</td><td>@${esc(u.id)}</td><td>${esc(u.name)}</td><td>${fmtDate(u.createdAt)}</td>`
      + `<td><div class="acts"><button class="btn btn-primary btn-sm" data-act="approve" data-uid="${u.uid}">승인</button>`
      + `<button class="btn btn-sm btn-danger" data-act="reject" data-uid="${u.uid}">거절</button></div></td></tr>`).join('')
    : '<tr><td colspan="5" class="adm-empty">없어요. 이제 가입하면 바로 이용할 수 있어요.</td></tr>';

  const q = $('#member-search').value.trim().toLowerCase();
  const members = all.filter((u) => u.approved || u.suspended)
    .filter((u) => !q || [u.nick, u.id, u.name].some((v) => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.points || 0) - (a.points || 0));
  $('#member-count').textContent = `${all.filter((u) => u.approved).length}명`;
  $('#member-list').innerHTML = members.length
    ? members.map((u) => {
      const st = u.stats || {};
      return `<tr><td class="nick">${esc(u.nick)}${u.approved ? '' : ' <span class="tag tag-error">정지</span>'}</td><td>@${esc(u.id)}</td><td>${esc(u.name)}</td>`
        + `<td class="num">${(u.points || 0).toLocaleString()}</td><td class="num">${st.games || 0}</td>`
        + `<td class="num">${st.win1 || 0}/${st.win2 || 0}/${st.win3 || 0}</td><td class="num">${st.daily1 || 0}</td>`
        + `<td><div class="acts"><button class="btn btn-sm" data-act="points" data-uid="${u.uid}">포인트 조정</button>`
        + (u.approved
          ? `<button class="btn btn-sm btn-danger" data-act="suspend" data-uid="${u.uid}">정지</button>`
          : `<button class="btn btn-sm" data-act="unsuspend" data-uid="${u.uid}">정지 해제</button>`)
        + `<button class="btn btn-sm btn-danger" data-act="delete" data-uid="${u.uid}">삭제</button>`
        + '</div></td></tr>';
    }).join('')
    : '<tr><td colspan="8" class="adm-empty">회원이 없어요.</td></tr>';
}
$('#member-search').addEventListener('input', render);

// 닉네임 목록(nicks) 채우기: 목록에 없는 회원 닉네임을 올림. 같은 닉네임이 여럿이면 먼저 가입한 사람이 가짐
// (나중 사람은 게임에서 로그인하면 무료로 바꾸라는 안내를 받음)
let nickSyncing = false;
async function syncNicks() {
  if (nickSyncing) return;
  nickSyncing = true;
  try {
    const nicks = (await get(ref(db, 'nicks'))).val() || {};
    const updates = {};
    const dups = [];
    const list = Object.entries(users).filter(([, u]) => u?.nick).sort(([, a], [, b]) => (a.createdAt || 0) - (b.createdAt || 0));
    const taken = { ...nicks };
    for (const [uid, u] of list) {
      const key = nickKey(u.nick);
      if (!taken[key]) { taken[key] = uid; updates[`nicks/${key}`] = uid; } else if (taken[key] !== uid) dups.push(u.nick);
    }
    if (Object.keys(updates).length) await update(ref(db), updates);
    $('#nick-stats').textContent = `닉네임 목록: ${Object.keys(taken).length}개`
      + (Object.keys(updates).length ? ` (방금 ${Object.keys(updates).length}개 등록)` : '')
      + (dups.length ? ` · 같은 닉네임 ${dups.length}명: ${dups.join(', ')} (로그인하면 무료로 바꾸라는 안내가 떠요)` : ' · 같은 닉네임 없음');
  } catch (e) {
    $('#nick-stats').textContent = `닉네임 목록을 정리하지 못했어요. 데이터베이스 규칙을 다시 게시했는지 확인해 주세요. (${e.message})`;
  } finally {
    nickSyncing = false;
  }
}

// 닉네임 목록에서 그 회원의 닉네임 지우기 (그 회원 것일 때만)
const nickKey = (n) => String(n || '').toLowerCase().replaceAll(' ', '').replace(/[.$#[\]/]/g, '_');
async function nickRemoval(u, uid) {
  if (!u?.nick) return {};
  const key = nickKey(u.nick);
  const owner = (await get(ref(db, `nicks/${key}`))).val();
  return owner === uid ? { [`nicks/${key}`]: null } : {};
}

// ---------- 데이터 정리 ----------
const STALE_ROOM_MS = 2 * 3600 * 1000;
let clockOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (s) => { clockOffset = s.val() || 0; });
const now = () => Date.now() + clockOffset;

// 지울 방 고르기: 활동 기록이 2시간 넘은 방 + 활동 기록이 없는 예전 방 중 접속자가 없는 방
async function findStale() {
  const [roomsSnap, idxSnap, lobSnap] = await Promise.all([get(ref(db, 'rooms')), get(ref(db, 'roomIndex')), get(ref(db, 'lobbies'))]);
  const rooms = roomsSnap.val() || {};
  const idx = idxSnap.val() || {};
  const lob = lobSnap.val() || {};
  const cutoff = now() - STALE_ROOM_MS;
  const stale = new Set();
  for (const [code, r] of Object.entries(rooms)) {
    const last = idx[code]?.lastActive;
    if (!r?.hostId || !r?.state || r?.closed) { stale.add(code); continue; } // 빈 조각만 남은 방, 닫힌 방
    if (typeof last === 'number') { if (last <= cutoff) stale.add(code); continue; }
    const anyoneOnline = Object.values(r?.players || {}).some((p) => p?.online);
    if (!anyoneOnline) stale.add(code);
  }
  for (const code of Object.keys(idx)) if (!rooms[code]) stale.add(code); // 방은 없고 기록만 남음
  const staleLobbies = Object.entries(lob).filter(([code, l]) => stale.has(code) || !(typeof l?.updatedAt === 'number' && l.updatedAt > cutoff)).map(([c]) => c);
  return { total: Object.keys(rooms).length, stale: [...stale], staleLobbies };
}
async function loadRoomStats() {
  try {
    const { total, stale } = await findStale();
    $('#cleanup-stats').textContent = `방 ${total}개 중 정리할 방 ${stale.filter((c) => c).length}개`;
  } catch (e) {
    $('#cleanup-stats').textContent = `방 정보를 불러오지 못했어요. 데이터베이스 규칙을 다시 게시했는지 확인해 주세요. (${e.message})`;
  }
}
$('#btn-cleanup').onclick = async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    const { stale, staleLobbies } = await findStale();
    if (!stale.length && !staleLobbies.length) { toast('정리할 방이 없어요.'); return; }
    if (!confirm(`오래된 방 ${stale.length}개를 지울까요?`)) return;
    const updates = {};
    for (const code of stale) Object.assign(updates, { [`rooms/${code}`]: null, [`roomIndex/${code}`]: null, [`lobbies/${code}`]: null });
    for (const code of staleLobbies) updates[`lobbies/${code}`] = null;
    await update(ref(db), updates);
    await set(ref(db, 'maint/lastCleanup'), serverTimestamp()).catch(() => {});
    toast(`오래된 방 ${stale.length}개를 지웠어요.`);
  } catch (err) {
    toast(`정리하지 못했어요: ${err.message}`);
  } finally {
    b.disabled = false;
    loadRoomStats();
  }
};

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const uid = b.dataset.uid;
  const u = users[uid];
  if (!u) return;
  b.disabled = true;
  try {
    if (b.dataset.act === 'approve') {
      await update(ref(db, `users/${uid}`), { approved: true, suspended: null });
      toast(`${u.nick}님을 승인했어요.`);
    } else if (b.dataset.act === 'reject') {
      if (!confirm(`${u.nick}(@${u.id})님의 가입을 거절할까요? 가입 정보가 지워져요.`)) return;
      await update(ref(db), { [`users/${uid}`]: null, [`private/${uid}`]: null, [`ids/${u.id}`]: null, ...(await nickRemoval(u, uid)) });
      toast(`${u.nick}님의 가입을 거절했어요.`);
    } else if (b.dataset.act === 'delete') {
      if (!confirm(`${u.nick}(@${u.id})님의 회원 정보를 지울까요? 포인트와 기록이 모두 사라지고 되돌릴 수 없어요.`)) return;
      await update(ref(db), { [`users/${uid}`]: null, [`private/${uid}`]: null, [`ids/${u.id}`]: null, ...(await nickRemoval(u, uid)) });
      toast(`${u.nick}님의 회원 정보를 지웠어요.`);
    } else if (b.dataset.act === 'suspend') {
      if (!confirm(`${u.nick}님을 이용 정지할까요? 게임을 할 수 없게 돼요.`)) return;
      await update(ref(db, `users/${uid}`), { approved: false, suspended: true });
      toast(`${u.nick}님을 정지했어요.`);
    } else if (b.dataset.act === 'unsuspend') {
      await update(ref(db, `users/${uid}`), { approved: true, suspended: null });
      toast(`${u.nick}님의 정지를 풀었어요.`);
    } else if (b.dataset.act === 'points') {
      const input = prompt(`${u.nick}님의 포인트를 얼마나 바꿀까요? (지금 ${u.points || 0}P)\n예) 100 은 더하기, -50 은 빼기`, '');
      if (input == null || input.trim() === '') return;
      const delta = Number(input);
      if (!Number.isInteger(delta)) { toast('정수로 적어주세요.'); return; }
      const next = Math.max(0, (u.points || 0) + delta);
      await update(ref(db, `users/${uid}`), { points: next });
      toast(`${u.nick}님의 포인트: ${u.points || 0}P → ${next}P`);
    }
  } catch (err) {
    toast(`실패했어요: ${err.message}`);
  } finally {
    b.disabled = false;
  }
});
