// 관리자 페이지: 가입 승인/거절, 회원 목록, 포인트 조정, 이용 정지
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, get, update, onValue } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
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
  unsub = onValue(ref(db, 'users'), async (s) => {
    users = s.val() || {};
    // 실명은 private에 따로 있어서 한 명씩 읽음
    await Promise.all(Object.keys(users).filter((uid) => !names.has(uid)).map(async (uid) => {
      const v = (await get(ref(db, `private/${uid}`)).catch(() => null))?.val();
      names.set(uid, v?.name || '');
    }));
    render();
  }, (e) => gate(`회원 목록을 불러오지 못했어요. (${esc(e.message)})`));
});

function render() {
  const all = Object.entries(users).map(([uid, u]) => ({ uid, ...u, name: names.get(uid) || '' }));
  const pending = all.filter((u) => !u.approved).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  $('#pending-count').textContent = `${pending.length}명`;
  $('#pending-list').innerHTML = pending.length
    ? pending.map((u) => `<tr><td class="nick">${esc(u.nick)}</td><td>@${esc(u.id)}</td><td>${esc(u.name)}</td><td>${fmtDate(u.createdAt)}</td>`
      + `<td><div class="acts"><button class="btn btn-primary btn-sm" data-act="approve" data-uid="${u.uid}">승인</button>`
      + `<button class="btn btn-sm btn-danger" data-act="reject" data-uid="${u.uid}">거절</button></div></td></tr>`).join('')
    : '<tr><td colspan="5" class="adm-empty">기다리는 가입 신청이 없어요.</td></tr>';

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
      await update(ref(db), { [`users/${uid}`]: null, [`private/${uid}`]: null, [`ids/${u.id}`]: null });
      toast(`${u.nick}님의 가입을 거절했어요.`);
    } else if (b.dataset.act === 'delete') {
      if (!confirm(`${u.nick}(@${u.id})님의 회원 정보를 지울까요? 포인트와 기록이 모두 사라지고 되돌릴 수 없어요.`)) return;
      await update(ref(db), { [`users/${uid}`]: null, [`private/${uid}`]: null, [`ids/${u.id}`]: null });
      toast(`${u.nick}님의 회원 정보를 지웠어요.`);
    } else if (b.dataset.act === 'suspend') {
      if (!confirm(`${u.nick}님을 이용 정지할까요? 다시 승인 대기 상태가 돼요.`)) return;
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
