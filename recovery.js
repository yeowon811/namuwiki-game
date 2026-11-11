// 비밀번호 찾기 (질문 1개) — 서버 없이 동작
// - 질문 + 답으로 만든 열쇠(AK)로 비밀번호를 잠가서 vault/<uid>에 저장
// - vault는 '찾기용 계정'(<아이디>.rcv@…)으로 로그인해야만 읽을 수 있음. 찾기용 계정의 비밀번호도 질문+답으로 만들어서,
//   질문이나 답이 틀리면 로그인이 안 되고, Firebase가 여러 번 틀린 시도를 막아 줌
// - keys/<uid>: AK와 찾기용 계정 비밀번호를 '내 비밀번호'로 잠가서 저장 → 비밀번호를 바꿀 때 다시 잠글 수 있음
//   (관리자도 질문의 답이나 비밀번호를 모르면 열 수 없음)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeAuth, inMemoryPersistence, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, get } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

// 질문 목록 (혈액형·전화번호 뒷자리처럼 남이 쉽게 알 수 있는 질문은 뺌)
export const QUESTIONS = [
  { id: 'trip', q: '내가 가본 첫 여행지는?' },
  { id: 'pet', q: '처음 키워 본 반려동물은?' },
  { id: 'nickname', q: '나의 어렸을 적 별명은?' },
  { id: 'food', q: '내가 가장 좋아하는 음식은?' },
  { id: 'town', q: '어릴 때 살던 동네 이름은?' },
  { id: 'phone', q: '내 현재 핸드폰 기종은?' },
];
export const QA_COUNT = 1;
export const RCV_VER = 2; // 찾기 정보 방식 번호 (1 = 예전 질문 2개 방식 → 다시 만들어야 함)
const ITER = 200000;
const te = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const randB64 = (n) => b64(crypto.getRandomValues(new Uint8Array(n)));
// 띄어쓰기·대소문자는 무시 (예: '서울 강남' = '서울강남')
export const norm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, '');

// qa = [{ qid, answer }] → 문제가 있으면 안내 문구
export function checkQA(qa) {
  if (!Array.isArray(qa) || qa.length !== QA_COUNT) return '비밀번호 찾기 질문에 답해 주세요.';
  const [x] = qa;
  if (!QUESTIONS.some((q) => q.id === x.qid)) return '비밀번호 찾기 질문을 골라 주세요.';
  if (norm(x.answer).length < 2) return '질문의 답을 2글자 이상 써 주세요.';
  return null;
}
const keyOf = (x) => `p:${x.qid}`;
const secretOf = (qa) => qa.map((x) => `${keyOf(x)}\u0001${norm(x.answer)}`).sort().join('\u0002');

async function kdf(secret, salt) {
  const k = await crypto.subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(salt), iterations: ITER }, k, 256);
}
const aes = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function seal(raw, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(raw), te.encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}
async function unseal(raw, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await aes(raw), unb64(box.ct));
  return new TextDecoder().decode(pt);
}
const rcvPassword = async (id, qa) => b64(await kdf(secretOf(qa), `nr-rcv|${id}`));
const rcvEmails = (id, domain) => ['', '2', '3'].map((s) => `${id}.rcv${s}@${domain}`);

// 찾기용 계정 전용 Firebase: 로그인 상태가 본 화면과 섞이지 않고 메모리에만 있음
let side = null;
function sideApp() {
  if (!side) {
    const app = initializeApp(firebaseConfig, 'recovery');
    side = { auth: initializeAuth(app, { persistence: inMemoryPersistence }), db: getDatabase(app) };
  }
  return side;
}
const code = (e) => e?.code || '';
const fail = (c, m) => Object.assign(new Error(m || c), { code: c });

// keys/<uid>: 내 비밀번호로 잠근 { ak, vs, rcvEmail, rcvPw }
async function lockKeys(uid, password, obj) {
  const salt = randB64(16);
  return { salt, ...(await seal(await kdf(password, `nr-key|${uid}|${salt}`), JSON.stringify(obj))) };
}
export async function unlockKeys(uid, password, box) {
  if (!box?.salt) throw fail('recover/no-keys');
  try {
    return JSON.parse(await unseal(await kdf(password, `nr-key|${uid}|${box.salt}`), box));
  } catch { throw fail('recover/bad-keys'); }
}

// 처음 설정하거나 질문을 바꿀 때 → 본 계정으로 저장할 내용(updates)을 돌려줌
// oldRcv: 질문을 바꿀 때 지금 찾기용 계정 { rcvEmail, rcvPw } (그 계정의 비밀번호만 새 답으로 바꿈)
export async function makeRecovery({ uid, id, domain, password, qa, oldRcv = null }) {
  const err = checkQA(qa);
  if (err) throw fail('recover/qa', err);
  const { auth } = sideApp();
  const rcvPw = await rcvPassword(id, qa);
  let rcvUid = null;
  let rcvEmail = null;
  try {
    if (oldRcv?.rcvEmail) {
      const cred = await signInWithEmailAndPassword(auth, oldRcv.rcvEmail, oldRcv.rcvPw);
      await updatePassword(cred.user, rcvPw);
      rcvUid = cred.user.uid;
      rcvEmail = oldRcv.rcvEmail;
    } else {
      for (const email of rcvEmails(id, domain)) {
        try {
          rcvUid = (await createUserWithEmailAndPassword(auth, email, rcvPw)).user.uid;
        } catch (e) {
          if (!/email-already-in-use/.test(code(e))) throw e;
          // 전에 만들다 만 내 찾기용 계정이면 같은 비밀번호로 들어가짐. 아니면 다음 이름으로
          rcvUid = await signInWithEmailAndPassword(auth, email, rcvPw).then((c) => c.user.uid, () => null);
        }
        if (rcvUid) { rcvEmail = email; break; }
      }
      if (!rcvUid) throw fail('recover/no-slot', '비밀번호 찾기 계정을 만들지 못했어요. 관리자에게 알려 주세요.');
    }
  } finally {
    await signOut(auth).catch(() => {});
  }
  const vs = randB64(16);
  const ak = await kdf(secretOf(qa), `nr-vault|${id}|${vs}`);
  return {
    [`users/${uid}/rcv`]: rcvUid,
    [`users/${uid}/rcvV`]: RCV_VER,
    [`vault/${uid}`]: { salt: vs, ...(await seal(ak, password)) },
    [`keys/${uid}`]: await lockKeys(uid, password, { ak: b64(ak), vs, rcvEmail, rcvPw }),
  };
}

// 비밀번호가 바뀌었을 때 (keysObj = unlockKeys 결과) → 새 비밀번호로 다시 잠근 updates
export async function relock({ uid, password, keysObj }) {
  const ak = unb64(keysObj.ak);
  return {
    [`vault/${uid}`]: { salt: keysObj.vs, ...(await seal(ak, password)) },
    [`keys/${uid}`]: await lockKeys(uid, password, keysObj),
  };
}

// 비밀번호 찾기: 아이디 + 질문 2개와 답 → { uid, password, keysObj }
export async function recoverPassword({ id, domain, qa }) {
  const err = checkQA(qa);
  if (err) throw fail('recover/qa', err);
  const { auth, db } = sideApp();
  const rcvPw = await rcvPassword(id, qa);
  try {
    let user = null;
    let rcvEmail = null;
    for (const email of rcvEmails(id, domain)) {
      try {
        user = (await signInWithEmailAndPassword(auth, email, rcvPw)).user;
        rcvEmail = email;
        break;
      } catch (e) {
        if (/too-many-requests|network/.test(code(e))) throw e;
      }
    }
    if (!user) throw fail('recover/wrong');
    const uid = (await get(ref(db, `ids/${id}`))).val();
    if (!uid || (await get(ref(db, `users/${uid}/rcv`))).val() !== user.uid) throw fail('recover/wrong');
    const v = (await get(ref(db, `vault/${uid}`))).val();
    if (!v?.salt) throw fail('recover/wrong');
    const ak = await kdf(secretOf(qa), `nr-vault|${id}|${v.salt}`);
    let password;
    try { password = await unseal(ak, v); } catch { throw fail('recover/wrong'); }
    return { uid, password, keysObj: { ak: b64(ak), vs: v.salt, rcvEmail, rcvPw } };
  } finally {
    await signOut(auth).catch(() => {});
  }
}

// ---------- 이 기기에 비밀번호 기억 ----------
// 찾기 질문을 바꿀 때 비밀번호를 다시 묻지 않으려고, 비밀번호로 로그인한 기기에만 잠가서 보관
// (브라우저 밖으로 꺼낼 수 없는 열쇠로 잠가서 IndexedDB에. 로그아웃하면 지움)
const IDB = 'nr-secure';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) {
  const d = await idb();
  try {
    return await new Promise((res, rej) => {
      const t = d.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  } finally { d.close(); }
}
async function deviceKey() {
  let k = await kv('readonly', (s) => s.get('key'));
  if (!k) {
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await kv('readwrite', (s) => s.put(k, 'key'));
  }
  return k;
}
export async function rememberPassword(uid, password) {
  try {
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(password));
    await kv('readwrite', (s) => s.put({ iv, ct }, `pw:${uid}`));
  } catch (e) { console.warn('[기기 기억]', e); }
}
export async function recallPassword(uid) {
  try {
    const box = await kv('readonly', (s) => s.get(`pw:${uid}`));
    if (!box) return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, await deviceKey(), box.ct);
    return new TextDecoder().decode(pt);
  } catch { return null; }
}
export async function forgetPasswords() {
  try { await kv('readwrite', (s) => s.clear()); } catch { /* 무시 */ }
}
