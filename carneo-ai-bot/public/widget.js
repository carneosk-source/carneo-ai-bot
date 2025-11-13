(function () {
  const API_BASE = 'https://carneo-ai-bot.onrender.com';

  let currentMode = null; // 'product' | 'order' | 'tech' | null
  let busy = false;

  // FLOATING BUBBLE
  const bubble = document.createElement('div');
  bubble.style.cssText =
    'position:fixed;bottom:20px;right:20px;width:64px;height:64px;border-radius:999px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:999999;box-shadow:0 8px 24px rgba(0,0,0,.2)';
  bubble.innerText = 'AI';
  document.body.appendChild(bubble);

  // PANEL
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;bottom:100px;right:20px;width:380px;max-width:95vw;height:560px;max-height:80vh;background:#fff;border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;z-index:999999;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif';
  panel.innerHTML = `
    <div style="padding:12px 16px;background:#111;color:#fff;display:flex;align-items:center;justify-content:space-between">
      <div style="font-weight:600;font-size:15px">Carneo AI poradca</div>
      <div style="font-size:11px;opacity:.7">beta</div>
    </div>
    <div id="carneo-chat-log" style="flex:1;padding:12px 12px 4px;overflow:auto;font-size:14px;line-height:1.45;background:#f5f5f5;"></div>
    <div style="padding:8px 12px;border-top:1px solid #e2e2e2;background:#fff;">
      <div style="display:flex;gap:6px;">
        <input id="carneo-chat-input" placeholder="Napíšte otázku..." style="flex:1;border-radius:999px;border:1px solid #ccc;padding:8px 12px;font-size:14px;outline:none;" />
        <button id="carneo-chat-send" style="border-radius:999px;border:0;background:#111;color:#fff;padding:0 14px;font-size:14px;cursor:pointer;">Poslať</button>
      </div>
      <div id="carneo-chat-helper" style="margin-top:4px;font-size:11px;color:#888;">Tip: najskôr vyberte typ dotazu vyššie.</div>
    </div>`;
  document.body.appendChild(panel);

  bubble.onclick = () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  };

  const log = panel.querySelector('#carneo-chat-log');
  const input = panel.querySelector('#carneo-chat-input');
  const send = panel.querySelector('#carneo-chat-send');
  const helper = panel.querySelector('#carneo-chat-helper');

  // ------- RENDERING SPRÁV ---------
  function addMsg(text, who) {
    const wrap = document.createElement('div');
    wrap.style.margin = '6px 0';
    wrap.style.display = 'flex';
    wrap.style.justifyContent = who === 'you' ? 'flex-end' : 'flex-start';

    const bubble = document.createElement('div');
    bubble.style.maxWidth = '80%';
    bubble.style.padding = '8px 10px';
    bubble.style.borderRadius = '14px';
    bubble.style.whiteSpace = 'pre-wrap';
    bubble.style.fontSize = '14px';

    if (who === 'you') {
      bubble.style.background = '#111';
      bubble.style.color = '#fff';
      bubble.style.borderBottomRightRadius = '4px';
      // zákazník – čistý text (bez HTML)
      bubble.innerText = text;
    } else {
      bubble.style.background = '#fff';
      bubble.style.color = '#222';
      bubble.style.borderBottomLeftRadius = '4px';
      bubble.style.boxShadow = '0 1px 3px rgba(0,0,0,.08)';
      // AI – HTML (link, <b>, atď.)
      bubble.innerHTML = text;
    }

    wrap.appendChild(bubble);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
  }

  let typingEl = null;
  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.style.margin = '4px 0 2px';
    typingEl.style.fontSize = '12px';
    typingEl.style.color = '#777';
    typingEl.innerText = 'Carneo AI píše...';
    log.appendChild(typingEl);
    log.scrollTop = log.scrollHeight;
  }
  function hideTyping() {
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
    typingEl = null;
  }

  // ------- ÚVODNÁ SPRÁVA + TLAČIDLÁ REŽIMOV ---------
  function renderModeButtons() {
    const box = document.createElement('div');
    box.style.marginTop = '6px';

    const label = document.createElement('div');
    label.style.fontSize = '13px';
    label.style.color = '#555';
    label.style.marginBottom = '4px';
    label.innerText = 'Vyberte, s čím potrebujete pomôcť:';
    box.appendChild(label);

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexWrap = 'wrap';
    row.style.gap = '6px';

    function makeBtn(text, mode) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.border = '0';
      btn.style.borderRadius = '999px';
      btn.style.padding = '6px 10px';
      btn.style.fontSize = '12px';
      btn.style.cursor = 'pointer';
      btn.style.background = '#111';
      btn.style.color = '#fff';
      btn.innerText = text;
      btn.onclick = () => {
        currentMode = mode;
        helper.innerText =
          mode === 'product'
            ? 'Režim: výber produktu Carneo.'
            : mode === 'order'
            ? 'Režim: otázky k objednávke a doručeniu.'
            : 'Režim: technické dotazy a nastavenie.';
        addMsg(
          mode === 'product'
            ? 'Chcem pomôcť s výberom produktu.'
            : mode === 'order'
            ? 'Mám otázku k objednávke.'
            : 'Mám technický dotaz.',
          'you'
        );
        addMsg('Super, napíšte mi podrobnejšie, s čím potrebujete pomôcť.', 'ai');
        box.remove();
      };
      return btn;
    }

    row.appendChild(makeBtn('Výber produktu', 'product'));
    row.appendChild(makeBtn('Objednávka', 'order'));
    row.appendChild(makeBtn('Technický dotaz', 'tech'));

    box.appendChild(row);
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }

  // úvod
  addMsg(
    'Ahoj, som Carneo AI poradca. Pomôžem ti s výberom hodiniek/prsteňov, s objednávkou aj s technickými otázkami.',
    'ai'
  );
  renderModeButtons();

  // ------- DOTAZ NA BACKEND ---------
  async function ask(q) {
    if (busy) return;
    busy = true;

    addMsg(q, 'you');
    input.value = '';
    showTyping();

    try {
      const r = await fetch(API_BASE + '/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          mode: currentMode // 'product' | 'order' | 'tech' | null
        })
      });
      const data = await r.json();
      hideTyping();
      addMsg(data.answer || '(bez odpovede)', 'ai');
    } catch (e) {
      console.error('Chat error', e);
      hideTyping();
      addMsg('Chyba pri komunikácii so serverom.', 'ai');
    } finally {
      busy = false;
    }
  }

  send.onclick = () => input.value.trim() && ask(input.value.trim());
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && input.value.trim()) ask(input.value.trim());
  };
})();
