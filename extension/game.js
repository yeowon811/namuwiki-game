// 게임 페이지에서 실행: 게임 페이지(window.postMessage) ↔ 확장 프로그램(chrome.runtime) 중계
(() => {
  const VERSION = chrome.runtime.getManifest().version;

  const post = (type, data = {}) => window.postMessage({ source: 'nr-ext', type, ...data }, '*');

  async function hello() {
    let race = null;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GAME_HELLO' });
      race = res?.race ?? null;
    } catch (e) {
      // 백그라운드가 잠깐 응답하지 않아도 설치된 것은 알려줌
      console.warn('[나무위키 레이스 도우미]', e);
    }
    post('READY', { version: VERSION, race });
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== 'nr-page') return;
    const { source, ...msg } = e.data;
    if (msg.type === 'PING') return hello();
    if (!['RACE', 'OPEN_START', 'STOP', 'BOARD', 'CHAT'].includes(msg.type)) return;
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (res && 'race' in res) post('STATE', { race: res.race });
    } catch (err) {
      post('ERROR', { message: String(err) });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE') post('STATE', { race: msg.race });
    if (msg.type === 'CHAT_SEND') post('CHAT_SEND', { text: msg.text }); // 나무위키 탭 채팅창에서 보낸 메시지
  });

  hello();
})();
