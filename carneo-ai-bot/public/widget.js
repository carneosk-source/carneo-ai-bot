(function () {
  // 🔗 URL tvojho backendu na Renderi
  const API_BASE = 'https://carneo-ai-bot.onrender.com';

  const bubble = document.createElement('div');
  bubble.style.cssText =
    'position:fixed;bottom:20px;right:20px;width:64px;height:64px;border-radius:999px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:999999;box-shadow:0 8px 24px rgba(0,0,0,.2)';
  bubble.innerText = 'AI';
  document.body.appendChild(bubble);

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;bottom:100px;right:20px;width:360px;height:520px;background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:999999';
  panel.innerHTML = `
    <div style="padding:12px 14px;background:#111;color:#fff;font-weight:600">Carneo AI poradca</div>
    <div id="carneo-chat-log" style="flex:1;padding:12px;overflow:auto;font:14px/1.45 system-ui,Arial"></div>
    <div style="display:flex;border-top:1px solid #eee">
      <input id="carneo-chat-input" placeholder="Napíšte otázku..." style="flex:1;border:0;padding:10px 12px;font:14px system-ui" />
      <button id="carneo-chat-send" style="border:0;background:#111;color:#fff;padding:0 14px">Poslať</button>
    </div>`;
  document.body.appendChild(panel);

  bubble.onclick = () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  };

  const log = panel.querySelector('#carneo-chat-log');
  const input = panel.querySelector('#carneo-chat-input');
  const send = panel.querySelector('#carneo-chat-send');

  function addMsg(text, who) {
    const div = document.createElement('div');
    div.style.margin = '8px 0';
    div.innerHTML = `<div style="font-weight:600;color:${
      who === 'you' ? '#111' : '#555'
    }">${who === 'you' ? 'Vy' : 'Carneo AI'}</div><div>${text}</div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function ask(q) {
    addMsg(q, 'you');
    input.value = '';
    try {
      const r = await fetch(API_BASE + '/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q })
      });
      const data = await r.json();
      addMsg(data.answer || '(bez odpovede)', 'ai');
    } catch (e) {
      console.error('Chat error', e);
      addMsg('Chyba pri komunikácii so serverom.', 'ai');
    }
  }

  send.onclick = () => input.value.trim() && ask(input.value.trim());
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && input.value.trim()) ask(input.value.trim());
  };
})();
