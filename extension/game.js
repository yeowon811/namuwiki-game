// 게임 페이지에서 실행: 게임 페이지(window.postMessage) ↔ 확장 프로그램(chrome.runtime) 중계
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  document.documentElement.dataset.nrExt = VERSION;

  const post = (type, data = {}) => window.postMessage({ source: 'nr-ext', type, ...data }, location.origin);

  async function hello() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GAME_HELLO' });
      post('READY', { version: VERSION, race: res?.race ?? null });
    } catch (e) {
      post('ERROR', { message: String(e) });
    }
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== 'nr-page') return;
    const { source, ...msg } = e.data;
    if (msg.type === 'PING') return hello();
    if (!['RACE', 'OPEN_START', 'STOP'].includes(msg.type)) return;
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (res && 'race' in res) post('STATE', { race: res.race });
    } catch (err) {
      post('ERROR', { message: String(err) });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE') post('STATE', { race: msg.race });
  });

  hello();
})();
