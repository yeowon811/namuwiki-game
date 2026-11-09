// 나무위키 탭에서 실행
// - 링크 클릭과 문서 이동을 감지해서 확장 프로그램에 보고
// - 레이스 탭에서는 검색창과 랜덤 문서를 막음
// - 진행 상황과 실시간 순위(HUD), 다른 사람 도착 알림을 띄움
(() => {
  // 나무위키는 링크를 눌러도 페이지를 새로 불러오지 않고 주소만 바꿈 → 주소 변화를 주기적으로 확인
  const SS_KEY = 'nr-last-click';
  let clickT = Number(sessionStorage.getItem(SS_KEY)) || 0; // 전체 새로고침으로 이동한 경우 대비
  let popT = 0;
  let lastUrl = null;
  let lastDocUrl = null;
  let race = null;

  const blocking = () => !!race && !race.finished && !race.dq;
  const SEARCH_INPUT = 'input[type="search"]';
  const BLOCKED_PATH = /^\/(Search|go\/|random|RandomPage)/i;

  const isDocLink = (a) => {
    if (!a || !a.href) return false;
    try {
      const u = new URL(a.href, location.href);
      return u.hostname === 'namu.wiki' && u.pathname.startsWith('/w/');
    } catch { return false; }
  };

  // ---------- 검색 막기 ----------
  const isSearchEl = (el) => !!el?.closest?.(SEARCH_INPUT) || (el?.tagName === 'FORM' && el.querySelector(SEARCH_INPUT));
  function blockedNotice() { toast('레이스 중에는 검색할 수 없어요. 본문 링크로만 이동하세요!', 3500, 'warning'); }

  document.addEventListener('focusin', (e) => {
    if (blocking() && e.target.matches?.(SEARCH_INPUT)) { e.target.blur(); blockedNotice(); }
  }, true);
  for (const type of ['keydown', 'keypress', 'input', 'beforeinput', 'paste']) {
    document.addEventListener(type, (e) => {
      if (blocking() && e.target.matches?.(SEARCH_INPUT)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }
  // 페이지 내 찾기(Ctrl+F, ⌘F, F3, Ctrl+G) 막기 → 위반 1회 (문서마다 1회)
  window.addEventListener('keydown', async (e) => {
    if (!blocking()) return;
    const k = (e.key || '').toLowerCase();
    const find = ((e.ctrlKey || e.metaKey) && (k === 'f' || k === 'g')) || e.key === 'F3';
    if (!find) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const before = race.violations;
    const res = await send({ type: 'STRIKE', kind: 'find', title: currentTitle() });
    if (res?.race) setRace(res.race);
    if (!res?.race || res.race.violations === before) toast('레이스 중에는 찾기(Ctrl+F)를 쓸 수 없어요.', 3000, 'warning');
  }, true);
  const currentTitle = () => {
    try { return decodeURIComponent(location.pathname.slice(3)); } catch { return location.pathname.slice(3); }
  };

  document.addEventListener('submit', (e) => {
    if (blocking() && isSearchEl(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      blockedNotice();
    }
  }, true);

  function updateBlockStyle() {
    let style = document.getElementById('nr-block-style');
    if (blocking() && !style) {
      style = document.createElement('style');
      style.id = 'nr-block-style';
      // 검색창, 모바일 검색 버튼, 랜덤 문서 버튼 숨기기
      style.textContent = `form:has(${SEARCH_INPUT}), a[title="검색"], a[href^="/random"], a[href^="/RandomPage"] { display: none !important; }`;
      document.documentElement.appendChild(style);
    } else if (!blocking() && style) {
      style.remove();
    }
  }

  // ---------- 클릭/이동 감지 ----------
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a');
    if (blocking() && a) {
      const href = a.getAttribute('href') || '';
      // 검색 자동완성 목록이나 랜덤 문서 링크는 막음
      if (a.closest('form') && a.closest('form').querySelector(SEARCH_INPUT) || /^\/(random|RandomPage)/i.test(href) || a.title === '검색') {
        e.preventDefault();
        e.stopImmediatePropagation();
        blockedNotice();
        return;
      }
    }
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; // 새 탭으로 열기는 제외
    if (isDocLink(a)) {
      clickT = Date.now();
      try { sessionStorage.setItem(SS_KEY, String(clickT)); } catch {}
    }
  }, true);
  window.addEventListener('popstate', () => { popT = Date.now(); });

  async function send(msg) {
    try { return await chrome.runtime.sendMessage(msg); } catch { return null; }
  }

  async function check() {
    const url = location.href.split('#')[0];
    if (url === lastUrl) return;
    lastUrl = url;
    // 검색 결과/랜덤 페이지로 가면 이전 문서로 되돌림
    if (blocking() && BLOCKED_PATH.test(location.pathname)) {
      blockedNotice();
      if (lastDocUrl) location.replace(lastDocUrl); else history.back();
      return;
    }
    if (location.pathname.startsWith('/w/')) lastDocUrl = url;
    if (!race) return;
    const res = await send({ type: 'NAV', nav: { url, t: Date.now(), clickT, popT } });
    clickT = 0;
    popT = 0;
    try { sessionStorage.removeItem(SS_KEY); } catch {}
    if (res) setRace(res.race);
  }

  // ---------- HUD ----------
  let host, root, timer, toastTimer;
  let seenFinished = null; // 이미 알림을 띄운 도착자
  let boardOpen = sessionStorage.getItem('nr-board-open') !== '0';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmtP = (ms) => (ms == null ? '-' : `${fmt(ms)}.${Math.floor((ms % 1000) / 100)}`);

  function ensureHud() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        /* Ant Design 5 토큰 (게임 페이지와 같은 디자인) */
        :host{all:initial}
        .wrap,.toast{
          --primary:#1677ff;--primary-bg:#e6f4ff;--primary-border:#91caff;
          --success:#52c41a;--success-text:#389e0d;--error:#ff4d4f;--error-bg:#fff2f0;--error-border:#ffccc7;--gold:#faad14;
          --text:rgba(0,0,0,.88);--text2:rgba(0,0,0,.65);--text3:rgba(0,0,0,.45);
          --border:#f0f0f0;--fill:rgba(0,0,0,.04);--bg:#fff;
          --shadow:0 6px 16px 0 rgba(0,0,0,.08),0 3px 6px -4px rgba(0,0,0,.12),0 9px 28px 8px rgba(0,0,0,.05);
          font:14px/1.5715 -apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans KR',Roboto,'Helvetica Neue',Arial,sans-serif;
          color:var(--text);
        }
        @media (prefers-color-scheme: dark){
          .wrap,.toast{--primary:#1668dc;--primary-bg:#111a2c;--primary-border:#15325b;--success:#49aa19;--success-text:#6abe39;
            --error:#dc4446;--error-bg:#2c1618;--error-border:#5b2526;--gold:#d89614;
            --text:rgba(255,255,255,.85);--text2:rgba(255,255,255,.65);--text3:rgba(255,255,255,.45);
            --border:#303030;--fill:rgba(255,255,255,.08);--bg:#1f1f1f}
        }
        *{box-sizing:border-box}
        [hidden]{display:none!important}
        svg{width:1em;height:1em;flex:none;vertical-align:-.125em}
        .wrap{position:fixed;right:16px;bottom:16px;width:272px;pointer-events:auto;
          background:var(--bg);border-radius:8px;box-shadow:var(--shadow);overflow:hidden}
        .box{padding:12px 16px}
        .k{display:flex;align-items:center;gap:6px;color:var(--text3);font-size:12px}
        .k svg{color:var(--primary)}
        .target{font-weight:600;font-size:16px;line-height:1.4;color:var(--primary);word-break:keep-all;margin:2px 0 8px}
        .box.done .target{color:var(--success-text)}
        .box.dq .target{color:var(--error)}
        .row{display:flex;justify-content:space-between;gap:12px}
        .stat{display:flex;align-items:center;gap:6px;font-weight:600;font-variant-numeric:tabular-nums}
        .stat svg{color:var(--text3)}
        .acts{display:flex;gap:6px;margin-top:10px}
        .acts button{flex:1;height:28px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);
          font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px}
        .acts button:hover:not(:disabled){border-color:var(--primary);color:var(--primary)}
        .acts button:disabled{color:var(--text3);cursor:not-allowed;background:var(--fill)}
        .hint{margin-top:8px;font-size:12px;line-height:1.55;padding:8px 10px;border-radius:6px;background:var(--primary-bg);color:var(--text)}
        .hint b{color:var(--primary)}
        .pen{margin-top:6px;font-size:12px;color:var(--gold)}
        .warn{margin-top:8px;font-size:12px;padding:0 7px;line-height:20px;border-radius:4px;display:inline-block;
          color:var(--error);background:var(--error-bg);border:1px solid var(--error-border)}
        .board{border-top:1px solid var(--border)}
        .bhead{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;cursor:pointer;user-select:none;font-weight:600}
        .bhead:hover{background:var(--fill)}
        .bhead .tog{color:var(--text3);font-weight:400;font-size:12px}
        ol{list-style:none;margin:0;padding:0 16px 8px;max-height:220px;overflow:auto}
        li{display:flex;gap:8px;align-items:center;padding:6px 0;font-size:13px;border-top:1px solid var(--border)}
        li .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        li .s{font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px;padding:0 7px;line-height:20px;border-radius:4px;
          color:var(--primary);background:var(--primary-bg);border:1px solid var(--primary-border)}
        li.me .n{font-weight:600}
        li.fin .s{color:var(--success-text);background:transparent;border-color:transparent;font-weight:600;font-size:13px;padding:0}
        li.out .s{color:var(--error);background:var(--error-bg);border-color:var(--error-border)}
        li.out .n{color:var(--text3)}
        .rk{flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;
          background:var(--fill);color:var(--text2)}
        .rk.r1{background:#fadb14;color:#613400}.rk.r2{background:#d9d9d9;color:#262626}.rk.r3{background:#d48806;color:#fff}
        .rk:empty{background:transparent}
        .toast{position:fixed;top:16px;right:16px;max-width:340px;display:flex;align-items:flex-start;gap:12px;
          background:var(--bg);padding:16px 20px;border-radius:8px;box-shadow:var(--shadow);
          opacity:0;transform:translateX(24px);transition:all .3s;pointer-events:none}
        .toast.show{opacity:1;transform:none}
        .toast svg{font-size:20px;margin-top:1px;color:var(--success)}
        .toast.info svg{color:var(--primary)}
        .toast.warning svg{color:var(--gold)}
        .legs{display:inline-flex;gap:3px;margin-right:6px;vertical-align:middle}
        .legs i{width:7px;height:7px;border-radius:50%;background:var(--fill);border:1px solid var(--border)}
        .legs i.on{background:var(--success);border-color:var(--success)}
        .legs i.cur{background:var(--primary-bg);border-color:var(--primary)}
        /* 게임 완료: 화면 가운데 */
        .end{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.45);pointer-events:auto;
          --primary:#1677ff;--gold:#faad14;--gold-bg:#fffbe6;--text:rgba(0,0,0,.88);--text3:rgba(0,0,0,.45);--bg:#fff;
          font:14px/1.5715 -apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans KR',Roboto,'Helvetica Neue',Arial,sans-serif;color:var(--text)}
        @media (prefers-color-scheme: dark){.end{--primary:#1668dc;--gold:#d89614;--gold-bg:#2b2111;--text:rgba(255,255,255,.85);--text3:rgba(255,255,255,.45);--bg:#1f1f1f}}
        .end[hidden]{display:none}
        .card{width:min(340px,calc(100vw - 32px));background:var(--bg);border-radius:12px;padding:32px 24px 24px;text-align:center;
          box-shadow:0 6px 16px 0 rgba(0,0,0,.08),0 3px 6px -4px rgba(0,0,0,.12),0 9px 28px 8px rgba(0,0,0,.05);animation:pop .32s cubic-bezier(.08,.82,.17,1)}
        @keyframes pop{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}
        .ei{display:inline-grid;place-items:center;width:64px;height:64px;border-radius:50%;background:var(--gold-bg);color:var(--gold);font-size:34px;margin-bottom:12px}
        .et{font-size:24px;font-weight:700;margin-bottom:8px}
        .ew{font-size:16px;margin-bottom:4px}.ew b{color:var(--primary)}
        .es{color:var(--text3);margin-bottom:20px}
        .eb{width:100%;height:40px;border:0;border-radius:8px;background:var(--primary);color:#fff;font:inherit;font-size:16px;cursor:pointer}
        .eb:hover{filter:brightness(1.1)}
      </style>
      <div class="end" hidden><div class="card">
        <span class="ei"><svg viewBox="0 0 24 24"><path d="M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v3M8.5 20h7M9.5 17h5v3h-5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>
        <div class="et">게임 완료!</div><div class="ew"></div><div class="es"></div>
        <button class="eb">닫기</button>
      </div></div>
      <div class="toast"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/><path class="mark" d="M8 12.2l2.8 2.8L16 9.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="msg"></span></div>
      <div class="wrap">
        <div class="box">
          <div class="k"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg><span class="klabel">목표 문서</span></div>
          <div class="target"></div>
          <div class="row">
            <span class="stat"><svg viewBox="0 0 24 24"><path d="M9 3.5v7.2M9 10.7V6.5a1.7 1.7 0 0 1 3.4 0v4M12.4 10.5V8.3a1.7 1.7 0 0 1 3.4 0v2.5M15.8 10.8V9.6a1.7 1.7 0 0 1 3.4 0v4.6a6.3 6.3 0 0 1-6.3 6.3h-1.2a5.5 5.5 0 0 1-4.6-2.5L4.6 15a1.6 1.6 0 0 1 2.6-1.9L9 15.2V5.2a1.7 1.7 0 0 1 3.4 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="clicks"></span></span>
            <span class="stat"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="time"></span></span>
          </div>
          <div class="acts">
            <button type="button" class="ret" title="막다른 문서일 때 직전 문서로 돌아가요. 규칙 위반이 아니고 클릭 1번으로만 세요.">↩ 이전 문서로</button>
            <button type="button" class="hintb" title="목표 문서가 무엇인지 짧은 설명을 봐요. 페널티가 있어요.">💡 힌트</button>
          </div>
          <div class="hint" hidden></div>
          <div class="pen" hidden></div>
          <div class="warn" hidden></div>
        </div>
        <div class="board" hidden>
          <div class="bhead"><span>실시간 순위</span><span class="tog"></span></div>
          <ol></ol>
        </div>
      </div>`;
    root.querySelector('.eb').addEventListener('click', () => { root.querySelector('.end').hidden = true; if (!race) removeHud(); });
    root.querySelector('.ret').addEventListener('click', async () => {
      if (!race?.canReturn) return;
      const res = await send({ type: 'RETURN' });
      if (res?.returnTo) toast(`이전 문서 '${res.returnTo}'(으)로 돌아가요. (클릭 +1)`, 2500, 'info');
      if (res?.race) setRace(res.race);
    });
    root.querySelector('.hintb').addEventListener('click', async () => {
      if (!race || race.finished) return;
      if (!race.hintText) {
        const pen = race.mode === 'clicks' ? '+3클릭' : '+30초';
        if (!confirm(`힌트를 보면 기록에 ${pen} 페널티가 붙어요. 볼까요?`)) return;
      }
      const btn = root.querySelector('.hintb');
      btn.disabled = true;
      btn.textContent = '불러오는 중…';
      const res = await send({ type: 'HINT' });
      btn.disabled = false;
      btn.textContent = '💡 힌트';
      if (res?.race) setRace(res.race);
      if (res?.hint) showHint(res.hint.target, res.hint.text);
    });
    root.querySelector('.bhead').addEventListener('click', () => {
      boardOpen = !boardOpen;
      try { sessionStorage.setItem('nr-board-open', boardOpen ? '1' : '0'); } catch {}
      renderBoard();
    });
    document.documentElement.appendChild(host);
    timer = setInterval(updateTime, 500);
  }
  function removeHud() {
    host?.remove();
    host = root = null;
    clearInterval(timer);
  }
  // Ant Design notification 모양의 알림 (success / info / warning)
  const MARKS = {
    success: '<path d="M8 12.2l2.8 2.8L16 9.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    info: '<path d="M12 11v6" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.5" r="1.2" fill="#fff"/>',
    warning: '<path d="M12 7v6" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1.2" fill="#fff"/>',
  };
  function toast(msg, ms = 3500, kind = 'success') {
    ensureHud();
    const el = root.querySelector('.toast');
    el.className = 'toast ' + kind;
    el.querySelector('svg').innerHTML = '<circle cx="12" cy="12" r="9" fill="currentColor"/>' + (MARKS[kind] || MARKS.success);
    el.querySelector('.msg').textContent = msg;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function updateTime() {
    if (!root || !race) return;
    const ms = (race.finished ? race.finishT : Date.now()) - race.startAt;
    root.querySelector('.time').textContent = fmt(ms);
  }

  function renderBoard() {
    if (!root) return;
    const board = race?.board;
    const el = root.querySelector('.board');
    el.hidden = !board?.players?.length;
    if (el.hidden) return;
    const done = board.players.filter((p) => p.status === 'finished').length;
    root.querySelector('.tog').textContent = `${done}/${board.players.length} 도착 · ${boardOpen ? '접기' : '펼치기'}`;
    const ol = root.querySelector('ol');
    ol.hidden = !boardOpen;
    let rank = 0;
    ol.innerHTML = board.players.map((p) => {
      let s;
      let cls = p.me ? 'me' : '';
      let rk = '';
      let rkCls = '';
      if (p.status === 'finished') {
        rank += 1;
        rk = rank;
        rkCls = rank <= 3 ? 'r' + rank : '';
        cls += ' fin';
        s = board.mode === 'clicks' ? `${p.clicks}클릭 · ${fmtP(p.elapsed)}` : `${fmtP(p.elapsed)} · ${p.clicks}클릭`;
      } else if (p.status === 'gaveup') {
        cls += ' out';
        s = p.dq ? '실격' : '포기';
      } else {
        const leg = board.mode === 'relay' ? ` · ${p.leg || 0}/${board.total}` : '';
        s = p.clicks != null ? `달리는 중${leg} · ${p.clicks}클릭째` : `달리는 중${leg}`;
      }
      const dots = board.mode === 'relay' && board.total > 1 && p.status !== 'waiting' ? legDots(p, board.total) : '';
      return `<li class="${cls}"><span class="rk ${rkCls}">${rk}</span><span class="n">${dots}${esc(p.name)}${p.me ? ' (나)' : ''}</span><span class="s">${s}</span></li>`;
    }).join('');
  }

  function legDots(p, total) {
    const leg = p.status === 'finished' ? total : p.leg || 0;
    return `<span class="legs">${Array.from({ length: total }, (_, i) => `<i class="${i < leg ? 'on' : i === leg && p.status === 'playing' ? 'cur' : ''}"></i>`).join('')}</span>`;
  }

  // 게임 완료 알림 (화면 가운데)
  function showEnd(board) {
    ensureHud();
    const players = board?.players || [];
    const winner = players.find((p) => p.status === 'finished');
    const mine = players.find((p) => p.me);
    const score = (p) => (board.mode === 'clicks' ? `${p.clicks}클릭 · ${fmtP(p.elapsed)}` : `${fmtP(p.elapsed)} · ${p.clicks}클릭`);
    let w, sub;
    if (!winner) { w = '도착한 사람이 없어요'; sub = ''; }
    else if (winner.me) { w = '축하해요! <b>1등</b>이에요 🎉'; sub = score(winner); }
    else {
      w = `1등 <b>${esc(winner.name)}</b>`;
      sub = score(winner) + (board.mode === 'relay' && mine && mine.status !== 'finished' ? ` · 나는 ${mine.leg || 0}/${board.total}단계` : '');
    }
    root.querySelector('.ew').innerHTML = w;
    root.querySelector('.es').textContent = (sub ? sub + ' · ' : '') + '게임 탭에서 결과를 확인하세요.';
    root.querySelector('.end').hidden = false;
    root.querySelector('.wrap').hidden = true;
    root.querySelector('.toast').classList.remove('show');
  }

  // 다른 사람이 새로 도착하면 알림
  function notifyArrivals() {
    const players = race?.board?.players;
    if (!players) return;
    const finished = players.filter((p) => p.status === 'finished');
    if (seenFinished === null) { seenFinished = new Set(finished.map((p) => p.id)); return; }
    for (const p of finished) {
      if (seenFinished.has(p.id)) continue;
      seenFinished.add(p.id);
      if (p.me) continue;
      const rank = finished.indexOf(p) + 1;
      toast(`${p.name}님 도착! ${rank}등 · ${fmtP(p.elapsed)} · ${p.clicks}클릭`, 5000, 'success');
    }
  }

  // 위반하면 곧바로 원래 문서로 새로고침되므로, 알림을 저장해 뒀다가 새 페이지에서 다시 보여줌
  function stickyToast(msg, ms, kind) {
    toast(msg, ms, kind);
    try { sessionStorage.setItem('nr-sticky-toast', JSON.stringify({ msg, ms, kind, at: Date.now() })); } catch {}
  }
  function replayStickyToast() {
    try {
      const v = JSON.parse(sessionStorage.getItem('nr-sticky-toast') || 'null');
      sessionStorage.removeItem('nr-sticky-toast');
      if (v && Date.now() - v.at < 8000) toast(v.msg, v.ms, v.kind);
    } catch {}
  }

  function showHint(target, text) {
    if (!root) return;
    const el = root.querySelector('.hint');
    el.innerHTML = `<b>💡 ${esc(target)}</b><br>${esc(text)}`;
    el.hidden = false;
  }

  function setRace(r) {
    const prevKey = race && `${race.code}/${race.round}`;
    const prevLeg = race?.leg || 0;
    const prevStrikes = race?.violations || 0;
    const prevDq = !!race?.dq;
    race = r;
    updateBlockStyle();
    if (!race) return removeHud();
    const sameRace = prevKey === `${race.code}/${race.round}`;
    if (!sameRace) seenFinished = null;
    ensureHud();
    root.querySelector('.wrap').hidden = false;
    root.querySelector('.end').hidden = true;
    const total = race.total || 1;
    const leg = race.leg || 0;
    const current = race.current || race.target;
    root.querySelector('.box').classList.toggle('done', race.finished);
    root.querySelector('.box').classList.toggle('dq', !!race.dq);
    root.querySelector('.klabel').textContent = total > 1 ? `목표 ${Math.min(leg + 1, total)}/${total}` : '목표 문서';
    root.querySelector('.target').textContent = race.dq ? `실격 (규칙 위반 ${race.violations}회)` : race.finished ? `도착! ${current}` : current;
    // 릴레이: 중간 목표에 도착하면 다음 목표 공개
    if (sameRace && total > 1 && leg > prevLeg && !race.finished) {
      toast(`${leg}번째 목표 도착! 다음 목표: ${current}`, 5000, 'success');
    }
    root.querySelector('.clicks').textContent = `${race.clicks}클릭`;
    // 되돌아가기 / 힌트
    const ret = root.querySelector('.ret');
    ret.disabled = !race.canReturn;
    ret.title = race.canReturn ? `'${race.returnTitle}'(으)로 돌아가요. 규칙 위반이 아니고 클릭 1번으로만 세요.` : '돌아갈 문서가 없어요.';
    root.querySelector('.hintb').disabled = !!race.finished || !!race.dq;
    // 위반 알림
    if (sameRace && race.violations > prevStrikes) {
      const last = race.strikes?.[race.strikes.length - 1];
      const what = { back: '뒤로가기는', other: '링크가 아닌 이동(주소창 등)은', find: '찾기(Ctrl+F)는' }[last?.kind] || '규칙 위반은';
      const whatName = { back: '뒤로가기', other: '링크가 아닌 이동', find: '찾기(Ctrl+F)' }[last?.kind] || '규칙 위반';
      const fix = last?.kind === 'find' ? '' : ' 원래 문서로 되돌렸어요.';
      if (race.dq) stickyToast(`🚫 실격! 규칙 위반이 ${race.violations}회예요. (마지막: ${whatName})`, 8000, 'warning');
      else if (race.violations >= (race.maxStrikes || 2) - 1) stickyToast(`⚠️ ${what} 금지예요!${fix} 한 번 더 위반하면 실격이에요. (${race.violations}/${race.maxStrikes || 2})`, 6000, 'warning');
      else stickyToast(`⚠️ ${what} 금지예요!${fix} (위반 ${race.violations}/${race.maxStrikes || 2})`, 5000, 'warning');
    } else if (sameRace && race.dq && !prevDq) toast('🚫 실격됐어요.', 6000, 'warning');
    const hintEl = root.querySelector('.hint');
    if (race.hintText && !race.finished) showHint(race.current || race.target, race.hintText);
    else if (!sameRace || race.finished || (total > 1 && leg > prevLeg)) hintEl.hidden = true; // 다음 목표로 넘어가면 힌트 숨김
    const pen = root.querySelector('.pen');
    pen.hidden = !race.hints;
    pen.textContent = `💡 힌트 ${race.hints}회 · 페널티 ${race.mode === 'clicks' ? `+${race.hints * 3}클릭` : `+${race.hints * 30}초`}`;
    const warn = root.querySelector('.warn');
    warn.hidden = !race.violations && !race.away;
    warn.textContent = [race.violations ? `규칙 위반 ${race.violations}/${race.maxStrikes || 2}회` : '', race.away ? `다른 탭 ${race.away}회` : ''].filter(Boolean).join(' · ');
    updateTime();
    renderBoard();
    notifyArrivals();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'HUD') return;
    if (msg.awayWarn && msg.race) setTimeout(() => toast(`👀 레이스 중에 다른 탭을 봤어요. 결과에 표시돼요. (${msg.race.away}회)`, 5000, 'warning'), 300);
    if (!msg.race && msg.ended && race) {
      const board = msg.board || race.board;
      race = null;
      updateBlockStyle();
      showEnd(board); // '닫기'를 누르면 사라짐
      return;
    }
    setRace(msg.race);
  });

  // 시작: 이 탭이 레이스 탭인지 확인
  send({ type: 'NAMU_HELLO' }).then((res) => {
    if (res?.race) setRace(res.race);
    if (res?.race) replayStickyToast();
    check();
    setInterval(check, 250);
  });
})();
