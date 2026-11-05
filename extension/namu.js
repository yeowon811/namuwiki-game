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

  const blocking = () => !!race && !race.finished;
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
        svg{width:1em;height:1em;flex:none;vertical-align:-.125em}
        .wrap{position:fixed;right:16px;bottom:16px;width:272px;pointer-events:auto;
          background:var(--bg);border-radius:8px;box-shadow:var(--shadow);overflow:hidden}
        .box{padding:12px 16px}
        .k{display:flex;align-items:center;gap:6px;color:var(--text3);font-size:12px}
        .k svg{color:var(--primary)}
        .target{font-weight:600;font-size:16px;line-height:1.4;color:var(--primary);word-break:keep-all;margin:2px 0 8px}
        .box.done .target{color:var(--success-text)}
        .row{display:flex;justify-content:space-between;gap:12px}
        .stat{display:flex;align-items:center;gap:6px;font-weight:600;font-variant-numeric:tabular-nums}
        .stat svg{color:var(--text3)}
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
      </style>
      <div class="toast"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/><path class="mark" d="M8 12.2l2.8 2.8L16 9.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="msg"></span></div>
      <div class="wrap">
        <div class="box">
          <div class="k"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>목표 문서</div>
          <div class="target"></div>
          <div class="row">
            <span class="stat"><svg viewBox="0 0 24 24"><path d="M9 3.5v7.2M9 10.7V6.5a1.7 1.7 0 0 1 3.4 0v4M12.4 10.5V8.3a1.7 1.7 0 0 1 3.4 0v2.5M15.8 10.8V9.6a1.7 1.7 0 0 1 3.4 0v4.6a6.3 6.3 0 0 1-6.3 6.3h-1.2a5.5 5.5 0 0 1-4.6-2.5L4.6 15a1.6 1.6 0 0 1 2.6-1.9L9 15.2V5.2a1.7 1.7 0 0 1 3.4 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="clicks"></span></span>
            <span class="stat"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="time"></span></span>
          </div>
          <div class="warn" hidden></div>
        </div>
        <div class="board" hidden>
          <div class="bhead"><span>실시간 순위</span><span class="tog"></span></div>
          <ol></ol>
        </div>
      </div>`;
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
        s = '포기';
      } else {
        s = p.clicks != null ? `달리는 중 · ${p.clicks}클릭째` : '달리는 중';
      }
      return `<li class="${cls}"><span class="rk ${rkCls}">${rk}</span><span class="n">${esc(p.name)}${p.me ? ' (나)' : ''}</span><span class="s">${s}</span></li>`;
    }).join('');
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

  function setRace(r) {
    const prevKey = race && `${race.code}/${race.round}`;
    race = r;
    updateBlockStyle();
    if (!race) return removeHud();
    if (prevKey !== `${race.code}/${race.round}`) seenFinished = null;
    ensureHud();
    root.querySelector('.box').classList.toggle('done', race.finished);
    root.querySelector('.target').textContent = race.finished ? `도착! ${race.target}` : race.target;
    root.querySelector('.clicks').textContent = `${race.clicks}클릭`;
    const warn = root.querySelector('.warn');
    warn.hidden = !race.violations;
    warn.textContent = `링크 클릭이 아닌 이동 ${race.violations}회`;
    updateTime();
    renderBoard();
    notifyArrivals();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'HUD') return;
    if (!msg.race && msg.ended && race) {
      const winner = race.board?.players?.find((p) => p.status === 'finished');
      race = null;
      updateBlockStyle();
      const who = winner && !winner.me ? `${winner.name}님이 1등으로 도착해서 ` : '';
      toast(`${who}게임이 끝났어요! 게임 탭에서 결과를 확인하세요.`, 6000, 'info');
      setTimeout(() => { if (!race) removeHud(); }, 6000);
      return;
    }
    setRace(msg.race);
  });

  // 시작: 이 탭이 레이스 탭인지 확인
  send({ type: 'NAMU_HELLO' }).then((res) => {
    if (res?.race) setRace(res.race);
    check();
    setInterval(check, 250);
  });
})();
