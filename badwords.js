// 부적절한 단어 거르기: 채팅은 ***로 가리고, 닉네임은 쓸 수 없게
// - WORDS에 단어를 더하거나 빼면 돼요. 글자 사이에 띄어쓰기·숫자·기호를 넣어도 걸러져요 (예: '씨 발', '시1발', '병.신')
// - ALLOW: 걸리면 안 되는 평범한 말 (그 안에 들어 있는 단어는 가리지 않음)
const WORDS = [
  // 욕설
  '시발', '씨발', '씨빨', '씨팔', '시팔', '쓰발', '쓰벌', '씨벌', '시벌', '싸발', '씨바', '시바', '씨부랄', '시부랄',
  'ㅅㅂ', 'ㅆㅂ', 'ㅅㅃ', 'ㅆㅃ', '십새', '씹새', '씹창', '씹년', '씹놈', '십년', '씹할', '씹덕',
  '병신', '븅신', '빙신', '병쉰', '등신', 'ㅂㅅ', 'ㅄ',
  '좆', '좇같', '존나', '졸라', '조까', '좆까', '좃', 'ㅈㄴ', 'ㅈ같', 'ㅈㄹ',
  '개새끼', '개새기', '개색기', '개색히', '개섀끼', '개세끼', '개쌔끼', '개쉐이', '개시키', '새끼야', 'ㅅㄲ', '쌔끼', '색히',
  '지랄', '염병', '썅', '쌍년', '쌍놈', '엠창', '니미', '느금', '느개비', '니애미', '니애비', '애미없', '애비없', '니엄마',
  '미친놈', '미친년', '미친새', '미친쉐', '또라이', '닥쳐', '꺼지라', '뒤져', '뒤질래', '디져', '죽어라', '자살해',
  '찐따', '한남충', '김치녀', '틀딱', '급식충', '맘충', '느검',
  // 성적인 말
  '섹스', '야동', '자위', '보빨', '딸딸이', '창녀', '창놈', '걸레년',
  // 영어
  'fuck', 'fuk', 'fck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'bastard', 'motherfucker', 'porn', 'sex',
];
const ALLOW = ['시발점', '새끼손가락', '새끼발가락', '시바견', '시바이누', '자위대', '자위권', '닥쳐오', '니미츠', 'sexy', 'essex', 'sussex', 'dickens', 'scunthorpe', 'shiitake'];

// 글자 사이에 끼워 넣을 수 있는 것: 띄어쓰기(한 칸), 숫자, 기호
const GAP = "(?:[\\s0-9._\\-~!@#$%^&*()+=|\\\\/,'\"?<>:;\\[\\]{}`·ㆍ]){0,3}";
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE = new RegExp(WORDS.map((w) => [...w].map(esc).join(GAP)).join('|'), 'gi');
const ALLOW_RE = new RegExp(ALLOW.map((w) => [...w].map(esc).join('')).join('|'), 'gi');

const HANGUL = /[가-힣]/;
function allowSpans(text) {
  const spans = [];
  for (const m of text.matchAll(ALLOW_RE)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}
function badMatches(text) {
  const s = String(text ?? '').normalize('NFC');
  const ok = allowSpans(s);
  const out = [];
  for (const m of s.matchAll(RE)) {
    const a = m.index;
    const b = a + m[0].length;
    if (ok.some(([x, y]) => a >= x && b <= y)) continue; // 평범한 말 안에 든 것
    // 띄어쓰기로 이어 붙여야 걸리는 경우, 앞뒤로 한글이 바로 붙어 있으면 다른 낱말임 (예: '시 바다', '존 나와라', '닥 쳐다보다')
    if (/\s/.test(m[0]) && (HANGUL.test(s[a - 1] || '') || HANGUL.test(s[b] || ''))) continue;
    out.push([a, b]);
  }
  return { s, out };
}

// 부적절한 단어를 ***로
export function maskBad(text) {
  const { s, out } = badMatches(text);
  if (!out.length) return s;
  let res = '';
  let i = 0;
  for (const [a, b] of out) { res += s.slice(i, a) + '***'; i = b; }
  return res + s.slice(i);
}
// 부적절한 단어가 들어 있는지 (닉네임 확인용)
export const hasBad = (text) => badMatches(text).out.length > 0;
