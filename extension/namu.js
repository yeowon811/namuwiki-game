// 나무위키 탭에서 실행: 링크 클릭과 문서 이동을 감지해서 확장 프로그램에 보고하고, 진행 상황(HUD)을 띄움
(() => {
  // 나무위키는 링크를 눌러도 페이지를 새로 불러오지 않고 주소만 바꿈 → 주소 변화를 주기적으로 확인
  const SS_KEY = 'nr-last-click';
  let clickT = Number(sessionStorage.getItem(SS_KEY)) || 0; // 전체 새로고침으로 이동한 경우 대비
  let popT = 0;
  let lastUrl = null;
  let race = null;

  const isDocLink = (a) => {
    if (!a || !a.href) return false;
    try {
      const u = new URL(a.href, location.href);
      return u.hostname === 'namu.wiki' && u.pathname.startsWith('/w/');
    } catch { return false; }
  };

  document.addEventListener('click', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; // 새 탭으로 열기는 제외
    const a = e.target.closest?.('a');
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
    if (!race) return;
    const res = await send({ type: 'NAV', nav: { url, t: Date.now(), clickT, popT } });
    clickT = 0;
    popT = 0;
    try { sessionStorage.removeItem(SS_KEY); } catch {}
    if (res) setRace(res.race);
  }

  // ---------- HUD ----------
  let host, root, timer;
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  function ensureHud() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .box{font:14px/1.45 system-ui,-apple-system,'Noto Sans KR',sans-serif;background:#00a495;color:#fff;
          border-radius:14px;padding:10px 14px;box-shadow:0 6px 24px rgba(0,0,0,.25);min-width:180px;max-width:260px}
        .row{display:flex;justify-content:space-between;gap:12px}
        .k{opacity:.8;font-size:12px}
        .target{font-weight:800;font-size:16px;word-break:keep-all}
        .big{font-weight:800;font-variant-numeric:tabular-nums}
        .warn{margin-top:4px;font-size:12px;background:rgba(0,0,0,.2);border-radius:8px;padding:2px 6px}
        .done{background:#2f9e44}
      </style>
      <div class="box"><div class="k">🎯 목표 문서</div><div class="target"></div>
        <div class="row"><span class="big clicks"></span><span class="big time"></span></div>
        <div class="warn" hidden></div></div>`;
    document.documentElement.appendChild(host);
    timer = setInterval(updateTime, 500);
  }
  function removeHud() {
    host?.remove();
    host = root = null;
    clearInterval(timer);
  }
  function updateTime() {
    if (!root || !race) return;
    const ms = (race.finished ? race.finishT : Date.now()) - race.startAt;
    root.querySelector('.time').textContent = '⏱ ' + fmt(ms);
  }
  function setRace(r) {
    race = r;
    if (!race) return removeHud();
    ensureHud();
    root.querySelector('.box').classList.toggle('done', race.finished);
    root.querySelector('.target').textContent = race.finished ? `🎉 도착! ${race.target}` : race.target;
    root.querySelector('.clicks').textContent = `👆 ${race.clicks}클릭`;
    const warn = root.querySelector('.warn');
    warn.hidden = !race.violations;
    warn.textContent = `⚠️ 링크 클릭이 아닌 이동 ${race.violations}회`;
    updateTime();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'HUD') setRace(msg.race);
  });

  // 시작: 이 탭이 레이스 탭인지 확인
  send({ type: 'NAMU_HELLO' }).then((res) => {
    if (res?.race) {
      setRace(res.race);
      lastUrl = null; // 현재 주소를 한 번 보고
    }
    check();
    setInterval(check, 250);
  });
})();
