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
  function blockedNotice() { toast('🚫 레이스 중에는 검색할 수 없어요. 본문 링크로만 이동하세요!'); }

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
        :host{all:initial}
        *{box-sizing:border-box}
        .wrap{position:fixed;right:16px;bottom:16px;width:260px;pointer-events:auto;
          font:14px/1.45 system-ui,-apple-system,'Noto Sans KR',sans-serif;color:#fff}
        .box{background:#00a495;border-radius:14px;padding:10px 14px;box-shadow:0 6px 24px rgba(0,0,0,.25)}
        .box.done{background:#2f9e44}
        .row{display:flex;justify-content:space-between;gap:12px}
        .k{opacity:.85;font-size:12px}
        .target{font-weight:800;font-size:16px;word-break:keep-all}
        .big{font-weight:800;font-variant-numeric:tabular-nums}
        .warn{margin-top:4px;font-size:12px;background:rgba(0,0,0,.2);border-radius:8px;padding:2px 6px}
        .board{margin-top:8px;background:rgba(20,28,26,.92);border-radius:14px;padding:8px 12px;box-shadow:0 6px 24px rgba(0,0,0,.25)}
        .bhead{display:flex;justify-content:space-between;align-items:center;font-weight:800;font-size:13px;cursor:pointer;user-select:none}
        .bhead span:last-child{opacity:.7;font-weight:400;font-size:12px}
        ol{list-style:none;margin:6px 0 0;padding:0;max-height:220px;overflow:auto}
        li{display:flex;gap:8px;align-items:baseline;padding:3px 0;font-size:13px;border-top:1px solid rgba(255,255,255,.08)}
        li .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        li .s{font-variant-numeric:tabular-nums;opacity:.9;white-space:nowrap}
        li.me .n{color:#7ee8db;font-weight:700}
        li.fin .s{color:#8ce99a;font-weight:700}
        li.out{opacity:.55}
        .rk{width:1.6em;text-align:center}
        .toast{position:fixed;top:16px;right:16px;max-width:320px;background:#212529;color:#fff;padding:10px 14px;border-radius:12px;
          box-shadow:0 6px 24px rgba(0,0,0,.3);font:600 14px/1.45 system-ui,'Noto Sans KR',sans-serif;
          opacity:0;transform:translateY(-10px);transition:.25s;pointer-events:none}
        .toast.show{opacity:1;transform:none}
      </style>
      <div class="toast"></div>
      <div class="wrap">
        <div class="box"><div class="k">🎯 목표 문서</div><div class="target"></div>
          <div class="row"><span class="big clicks"></span><span class="big time"></span></div>
          <div class="warn" hidden></div></div>
        <div class="board" hidden>
          <div class="bhead"><span>🏁 실시간 순위</span><span class="tog"></span></div>
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
  function toast(msg, ms = 3500) {
    ensureHud();
    const el = root.querySelector('.toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function updateTime() {
    if (!root || !race) return;
    const ms = (race.finished ? race.finishT : Date.now()) - race.startAt;
    root.querySelector('.time').textContent = '⏱ ' + fmt(ms);
  }

  function renderBoard() {
    if (!root) return;
    const board = race?.board;
    const el = root.querySelector('.board');
    el.hidden = !board?.players?.length;
    if (el.hidden) return;
    const done = board.players.filter((p) => p.status === 'finished').length;
    root.querySelector('.tog').textContent = `${done}/${board.players.length} 도착 · ${boardOpen ? '접기 ▾' : '펼치기 ▸'}`;
    const ol = root.querySelector('ol');
    ol.hidden = !boardOpen;
    let rank = 0;
    ol.innerHTML = board.players.map((p) => {
      let s;
      let cls = p.me ? 'me' : '';
      let rk = '';
      if (p.status === 'finished') {
        rank += 1;
        rk = ['🥇', '🥈', '🥉'][rank - 1] || rank;
        cls += ' fin';
        s = board.mode === 'clicks' ? `${p.clicks}클릭 · ${fmtP(p.elapsed)}` : `${fmtP(p.elapsed)} · ${p.clicks}클릭`;
      } else if (p.status === 'gaveup') {
        cls += ' out';
        s = '포기';
      } else {
        s = p.clicks != null ? `달리는 중 · ${p.clicks}클릭째` : '달리는 중';
      }
      return `<li class="${cls}"><span class="rk">${rk}</span><span class="n">${esc(p.name)}${p.me ? ' (나)' : ''}</span><span class="s">${s}</span></li>`;
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
      toast(`🎉 ${p.name}님 도착! ${rank}등 · ${fmtP(p.elapsed)} · ${p.clicks}클릭`, 5000);
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
    root.querySelector('.target').textContent = race.finished ? `🎉 도착! ${race.target}` : race.target;
    root.querySelector('.clicks').textContent = `👆 ${race.clicks}클릭`;
    const warn = root.querySelector('.warn');
    warn.hidden = !race.violations;
    warn.textContent = `⚠️ 링크 클릭이 아닌 이동 ${race.violations}회`;
    updateTime();
    renderBoard();
    notifyArrivals();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'HUD') return;
    if (!msg.race && msg.ended && race) {
      race = null;
      updateBlockStyle();
      toast('🏁 게임이 끝났어요! 게임 탭에서 결과를 확인하세요.', 6000);
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
