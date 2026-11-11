// 관리자 페이지: 회원 목록, 포인트 조정, 이용 정지, 삭제 (예전 방식 가입의 승인/거절)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, get, set, update, onValue, serverTimestamp, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

let users = {};
const picked = new Set(); // 일괄 지급할 회원 (체크한 사람)
let presence = {}; // uid → { conns: { 창: { where, room, at } }, lastSeen }
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
let adminUid = null;
onAuthStateChanged(auth, async (user) => {
  unsub?.();
  if (!user) return gate('먼저 <a class="link" href="./">게임 페이지</a>에서 로그인해 주세요.');
  const isAdmin = (await get(ref(db, `admins/${user.uid}`)).catch(() => null))?.val() === true;
  if (!isAdmin) return gate('관리자만 볼 수 있는 페이지예요.');
  adminUid = user.uid;
  const me = (await get(ref(db, `users/${user.uid}`))).val();
  if (me?.pwSet !== true) return gate('관리자 계정은 비밀번호가 꼭 있어야 해요. <a class="link" href="./">게임 페이지</a>에서 비밀번호를 먼저 만들어 주세요.');
  $('#hdr-user').textContent = me ? `${me.nick} (@${me.id})` : '';
  $('#adm-gate').classList.add('hidden');
  $('#adm-main').classList.remove('hidden');
  loadRoomStats();
  const unsubNotice = onValue(ref(db, 'notice'), (s) => renderNotice(s.val()), (e) => { $('#notice-cur').textContent = `공지를 불러오지 못했어요. 데이터베이스 규칙을 다시 게시했는지 확인해 주세요. (${e.message})`; });
  const unsubPresence = onValue(ref(db, 'presence'), (s) => { presence = s.val() || {}; render(); },
    (e) => { $('#online-sum').textContent = `접속 현황을 불러오지 못했어요. 데이터베이스 규칙을 다시 게시했는지 확인해 주세요. (${e.message})`; });
  const unsubUsers = onValue(ref(db, 'users'), async (s) => {
    users = s.val() || {};
    // 실명은 private에 따로 있어서 한 명씩 읽음
    await Promise.all(Object.keys(users).filter((uid) => !names.has(uid)).map(async (uid) => {
      const v = (await get(ref(db, `private/${uid}`)).catch(() => null))?.val();
      names.set(uid, v?.name || '');
    }));
    render();
    syncNicks();
  }, (e) => gate(`회원 목록을 불러오지 못했어요. (${esc(e.message)})`));
  unsub = () => { unsubNotice(); unsubPresence(); unsubUsers(); };
});

// 접속 현황
const WHERE = { home: '시작 화면', shop: '상점', lobby: '대기실', playing: '게임 중', results: '결과 화면' };
const connsOf = (uid) => Object.values(presence[uid]?.conns || {}).filter((c) => c && typeof c === 'object');
const isOnline = (uid) => connsOf(uid).length > 0;
function fmtAgo(t) {
  if (typeof t !== 'number') return '-';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '방금 전';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}일 전` : fmtDate(t);
}
const whereText = (c) => (c.daily ? '오늘의 챔피언' : WHERE[c.where] || esc(c.where)) + (c.room && !c.daily ? ` <span class="text-tertiary">· 방 ${esc(c.room)}</span>` : '');
function renderOnline(all) {
  const on = all.filter((u) => isOnline(u.uid))
    .map((u) => ({ ...u, conns: connsOf(u.uid).sort((a, b) => (b.at || 0) - (a.at || 0)) }))
    .sort((a, b) => (b.conns[0].at || 0) - (a.conns[0].at || 0));
  const playing = on.filter((u) => u.conns.some((c) => c.where === 'playing')).length;
  $('#online-count').textContent = `${on.length}명`;
  $('#online-sum').textContent = on.length ? `지금 ${on.length}명 접속 중 · 게임 중 ${playing}명` : '지금 접속한 사람이 없어요.';
  $('#online-list').innerHTML = on.length
    ? on.map((u) => `<tr><td class="nick"><span class="on-dot"></span>${esc(u.nick)}</td><td>@${esc(u.id)}</td>`
      + `<td>${u.conns.map(whereText).join('<br>')}${u.conns.length > 1 ? ` <span class="tag">창 ${u.conns.length}개</span>` : ''}</td>`
      + `<td class="text-tertiary">${fmtAgo(u.conns[0].at)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="adm-empty">접속 중인 사람이 없어요.</td></tr>';
}
setInterval(() => { if (Object.keys(users).length) render(); }, 60 * 1000); // '몇 분 전' 갱신

function render() {
  const all = Object.entries(users).map(([uid, u]) => ({ uid, ...u, name: names.get(uid) || '' }));
  renderOnline(all);
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
      const seen = isOnline(u.uid) ? '<span class="on-dot"></span>접속 중' : `<span class="text-tertiary">${fmtAgo(presence[u.uid]?.lastSeen)}</span>`;
      return `<tr class="${picked.has(u.uid) ? 'picked' : ''}"><td class="pick"><input type="checkbox" data-pick="${u.uid}" ${picked.has(u.uid) ? 'checked' : ''} aria-label="${esc(u.nick)} 선택"></td><td class="nick">${esc(u.nick)}${u.approved ? '' : ' <span class="tag tag-error">정지</span>'}${u.pwSet === true ? '' : ' <span class="tag tag-warning" title="아직 비밀번호를 만들지 않아서 아이디만 알면 누구나 로그인할 수 있어요">비밀번호 없음</span>'}</td><td>@${esc(u.id)}</td><td>${esc(u.name)}</td>`
        + `<td class="seen">${seen}</td>`
        + `<td class="num">${(u.points || 0).toLocaleString()}</td><td class="num">${st.games || 0}</td>`
        + `<td class="num">${st.win1 || 0}/${st.win2 || 0}/${st.win3 || 0}</td><td class="num">${st.daily1 || 0}</td>`
        + `<td><div class="acts"><button class="btn btn-sm" data-act="points" data-uid="${u.uid}">포인트 조정</button>`
        + (u.approved
          ? `<button class="btn btn-sm btn-danger" data-act="suspend" data-uid="${u.uid}">정지</button>`
          : `<button class="btn btn-sm" data-act="unsuspend" data-uid="${u.uid}">정지 해제</button>`)
        + `<button class="btn btn-sm btn-danger" data-act="delete" data-uid="${u.uid}">삭제</button>`
        + '</div></td></tr>';
    }).join('')
    : '<tr><td colspan="10" class="adm-empty">회원이 없어요.</td></tr>';
  // 일괄 지급: 선택 상태
  for (const uid of [...picked]) if (!users[uid]) picked.delete(uid); // 지워진 회원
  const allOn = members.length > 0 && members.every((u) => picked.has(u.uid));
  $('#pick-all').checked = allOn;
  $('#pick-all').indeterminate = !allOn && members.some((u) => picked.has(u.uid));
  $('#bulk-picked').textContent = `${picked.size}명 선택`;
  $('#bulk-give-picked').disabled = picked.size === 0;
  $('#bulk-clear').classList.toggle('hidden', picked.size === 0);
  bulkMembers = members;
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

// ---------- 공지 ----------
let curNotice = null;
function renderNotice(n) {
  curNotice = n;
  $('#notice-cur').innerHTML = n
    ? `<b>지금 올라가 있는 공지</b> · ${fmtDate(n.at)}<div class="notice-now"><div class="nt">${esc(n.title)}</div><div class="nb">${esc(n.body)}</div></div>`
    : '지금 올라가 있는 공지가 없어요.';
  $('#notice-down').disabled = !n;
  $('#notice-edit').disabled = !n;
}
$('#notice-edit').onclick = () => {
  if (!curNotice) return;
  $('#notice-in-title').value = curNotice.title || '';
  $('#notice-in-body').value = curNotice.body || '';
  $('#notice-in-title').focus();
};
$('#notice-up').onclick = async (e) => {
  const title = $('#notice-in-title').value.trim();
  const body = $('#notice-in-body').value.trim();
  if (!title || !body) { toast('제목과 내용을 모두 적어 주세요.'); return; }
  if (!confirm(`이 공지를 올릴까요?\n\n${title}\n\n접속한 모든 사람에게 떠요. ('더 이상 보지 않기'를 눌렀던 사람에게도 새 공지는 다시 떠요)`)) return;
  const b = e.currentTarget;
  b.disabled = true;
  try {
    await set(ref(db, 'notice'), { id: Date.now(), title, body, at: serverTimestamp(), by: adminUid });
    $('#notice-in-title').value = '';
    $('#notice-in-body').value = '';
    toast('공지를 올렸어요.');
  } catch (err) { toast(`올리지 못했어요: ${err.message}`); } finally { b.disabled = false; }
};
$('#notice-down').onclick = async () => {
  if (!curNotice || !confirm('지금 공지를 내릴까요? 더 이상 아무에게도 뜨지 않아요.')) return;
  try { await set(ref(db, 'notice'), null); toast('공지를 내렸어요.'); } catch (err) { toast(`내리지 못했어요: ${err.message}`); }
};

// ---------- 포인트 일괄 지급 ----------
let bulkMembers = []; // 지금 목록에 보이는 회원 (검색 결과)
$('#member-list').addEventListener('change', (e) => {
  const c = e.target.closest('[data-pick]');
  if (!c) return;
  if (c.checked) picked.add(c.dataset.pick); else picked.delete(c.dataset.pick);
  render();
});
$('#pick-all').addEventListener('change', (e) => {
  for (const u of bulkMembers) if (e.target.checked) picked.add(u.uid); else picked.delete(u.uid);
  render();
});
$('#bulk-clear').onclick = () => { picked.clear(); render(); };
async function giveBulk(uids, label, btn) {
  const amt = Number($('#bulk-amount').value);
  if (!Number.isInteger(amt) || amt === 0) { toast('포인트를 정수로 적어 주세요. (빼려면 -50처럼)'); $('#bulk-amount').focus(); return; }
  if (Math.abs(amt) > 100000) { toast('한 번에 100,000P까지만 바꿀 수 있어요.'); return; }
  if (!uids.length) { toast('대상 회원이 없어요.'); return; }
  const verb = amt > 0 ? `${amt.toLocaleString()}P를 줄까요?` : `${Math.abs(amt).toLocaleString()}P를 뺄까요? (0P 아래로는 안 내려가요)`;
  if (!confirm(`${label} ${uids.length}명에게 ${verb}`)) return;
  btn.disabled = true;
  // 회원마다 지금 포인트에 더함 (그 사이 게임에서 포인트가 바뀌어도 안전하게)
  const res = await Promise.allSettled(uids.map((uid) => runTransaction(ref(db, `users/${uid}/points`), (cur) => Math.max(0, (cur || 0) + amt))));
  const fail = res.filter((r) => r.status === 'rejected');
  btn.disabled = false;
  if (fail.length) toast(`${uids.length - fail.length}명 완료, ${fail.length}명 실패 (${fail[0].reason?.message || ''})`);
  else toast(`${label} ${uids.length}명에게 ${amt > 0 ? '+' : ''}${amt.toLocaleString()}P 했어요.`);
  if (!fail.length) { $('#bulk-amount').value = ''; picked.clear(); render(); }
}
$('#bulk-give-picked').onclick = (e) => giveBulk([...picked].filter((uid) => users[uid]), '선택한 회원', e.currentTarget);
$('#bulk-give-all').onclick = (e) => giveBulk(Object.entries(users).filter(([, u]) => u?.approved).map(([uid]) => uid), '모든 회원(정지 제외)', e.currentTarget);

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
