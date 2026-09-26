(() => {
  'use strict';
  const slug = location.pathname.split('/').filter(Boolean).pop();
  const endpoint = '/api/chat/public/' + encodeURIComponent(slug);
  const root = document.createElement('div');
  root.className = 'sc-widget';
  root.innerHTML = `
    <button class="sc-launcher" id="chatLauncher" type="button" aria-haspopup="dialog" aria-controls="chatDialog"><span aria-hidden="true">💬</span> Falar com a gente</button>
    <dialog id="chatDialog" class="sc-dialog" aria-labelledby="chatTitle">
      <header class="sc-header"><div class="sc-avatar" aria-hidden="true">S</div><div class="sc-heading"><h2 id="chatTitle">Estabelecimento</h2><p><span aria-hidden="true">●</span> Chat Studiofy</p></div><button id="chatClose" class="sc-close" type="button" aria-label="Fechar chat">×</button></header>
      <div class="sc-presence" id="chatPresence">Um canal direto com o estabelecimento</div>
      <div class="sc-content">
        <section id="chatIdentity" hidden><div class="sc-intro"><span class="sc-eyebrow">VAMOS CONVERSAR</span><h3>Olá! 👋<br>Como podemos ajudar?</h3><p>Como podemos chamar você?</p></div>
          <form id="chatIdentityForm"><label for="chatName">Nome</label><input id="chatName" autocomplete="name" maxlength="80" required>
          <label for="chatPhone">Seu WhatsApp/telefone</label><input id="chatPhone" type="tel" autocomplete="tel" inputmode="tel" maxlength="30" required aria-describedby="chatPrivacy">
          <p id="chatPrivacy" class="sc-note">Esses dados ajudam o estabelecimento a identificar seu atendimento.</p><button class="sc-primary" type="submit" id="chatStart">Iniciar conversa <span aria-hidden="true">→</span></button></form>
          <p class="sc-note sc-channel-note">Você está no Chat Studiofy. Nenhuma mensagem é enviada pelo WhatsApp.</p>
        </section>
        <section id="chatConversation" hidden><div class="sc-toolbar"><span>Suas mensagens</span><button id="chatRefresh" type="button">Atualizar conversa</button></div>
          <div id="chatHistory" class="sc-history" tabindex="0" aria-label="Histórico da conversa"><button id="chatOlder" class="sc-older" type="button" hidden>Ver mensagens anteriores</button><div class="sc-welcome">Olá! 👋 Como podemos ajudar?<small>O estabelecimento responde quando puder.</small></div><div id="chatMessages"></div></div>
          <button id="chatNew" class="sc-new" type="button" hidden>↓ Nova mensagem</button><div id="chatConnection" class="sc-connection" role="status" hidden>Tentando atualizar…</div>
          <form id="chatSendForm" class="sc-composer"><label for="chatMessage" class="sc-sr-only">Digite uma mensagem</label><textarea id="chatMessage" placeholder="Digite uma mensagem..." maxlength="2000" rows="2" required></textarea><button id="chatSend" class="sc-send" type="submit" aria-label="Enviar mensagem">➤</button></form>
        </section>
        <div id="chatNotice" class="sc-notice" role="status" aria-live="polite" tabindex="-1"></div><button id="chatRetry" class="sc-retry" type="button" hidden>Tentar novamente</button>
      </div><footer class="sc-footer">Conversas com cuidado. <strong>Studiofy</strong></footer>
    </dialog>`;
  document.body.append(root);
  const $ = id => root.querySelector('#' + id);
  const dialog = $('chatDialog'), history = $('chatHistory');
  let busy = false, identified = false, pending = null, messages = new Map(), oldest = null, hasMore = false, retryAt = 0;
  let newest = null, readThrough = 0;
  const sync = StudiofyChatSync.create({ interval: 8000, enabled: () => dialog.open && identified && !$('chatConversation').hidden && !busy,
    task: synchronize, recovered: () => { $('chatConnection').hidden = true; }, failed: error => {
      if ([401, 403, 404].includes(error.status)) failure(error); else $('chatConnection').hidden = false;
    } });
  const rateMessage = 'Você enviou muitas mensagens. Aguarde um pouco e tente novamente.';
  function name(value) {
    $('chatTitle').textContent = value || 'Estabelecimento';
    $('chatLauncher').setAttribute('aria-label', 'Falar com ' + (value || 'o estabelecimento') + ' pelo Chat Studiofy');
  }
  name(document.body.dataset.establishmentName);
  document.addEventListener('studiofy:establishment', event => name(event.detail.name));
  function viewport() {
    const v = window.visualViewport;
    dialog.style.setProperty('--sc-height', (v?.height || innerHeight) + 'px');
    dialog.style.setProperty('--sc-top', (v?.offsetTop || 0) + 'px');
  }
  window.visualViewport?.addEventListener('resize', viewport);
  window.visualViewport?.addEventListener('scroll', viewport);
  function notice(text = '', error = false) { $('chatNotice').textContent = text; $('chatNotice').classList.toggle('sc-error', error); }
  function screen(value) {
    $('chatIdentity').hidden = value !== 'identity'; $('chatConversation').hidden = value !== 'conversation';
    $('chatRetry').hidden = true;
    $('chatPresence').textContent = ['identity', 'conversation'].includes(value) ? 'As respostas são atualizadas automaticamente' : 'Chat Studiofy';
  }
  function focus(id) { if (dialog.open) $(id).focus({ preventScroll: true }); }
  function loading(value) {
    busy = value;
    for (const id of ['chatStart', 'chatSend', 'chatRefresh', 'chatOlder', 'chatRetry']) $(id).disabled = value;
    $('chatMessage').readOnly = value;
    $('chatStart').textContent = value ? 'Iniciando...' : 'Iniciar conversa →';
    $('chatSendForm').setAttribute('aria-busy', String(value));
    if (!value) sync.start();
  }
  async function request(path, body) {
    if (Date.now() < retryAt) throw { status: 429, retryAfterMs: retryAt - Date.now() };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Studiofy-Chat': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.status === 429) {
        const seconds = Number(response.headers.get('Retry-After'));
        retryAt = Date.now() + Math.max(1, Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
      }
      if (!response.ok) throw { status: response.status, retryAfterMs: Math.max(0, retryAt - Date.now()) };
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  function failure(error, sending = false) {
    if ([403, 404].includes(error.status)) {
      screen('unavailable'); notice('O chat deste estabelecimento está temporariamente indisponível.', true);
    } else if (error.status === 401) {
      identified = false; messages.clear(); pending = null; $('chatMessage').value = ''; screen('identity');
      notice('Identifique-se para iniciar ou retomar o atendimento.'); focus('chatName');
    } else {
      notice(error.status === 429 ? rateMessage : error.status === 400 ? 'Confira os campos. Use texto sem HTML e até 2.000 caracteres por mensagem.' : sending ? 'Não foi possível enviar. Tente novamente.' : 'Não foi possível carregar a conversa. Tente novamente.', true);
      if (!identified && $('chatIdentity').hidden) $('chatRetry').hidden = false;
    }
  }
  function render(older = false, preserve = false) {
    const oldHeight = history.scrollHeight, oldTop = history.scrollTop;
    $('chatMessages').replaceChildren();
    for (const message of [...messages.values()].sort((a, b) => a.id - b.id)) {
      const item = document.createElement('article'); item.className = 'sc-message ' + (message.sender_type === 'customer' ? 'sc-mine' : 'sc-theirs');
      const author = document.createElement('span'); author.className = 'sc-sr-only'; author.textContent = message.sender_type === 'customer' ? 'Você: ' : 'Estabelecimento: ';
      const text = document.createElement('p'); text.textContent = message.content;
      const time = document.createElement('time'); const date = new Date(message.created_at);
      if (Number.isFinite(+date)) { time.dateTime = date.toISOString(); time.textContent = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); time.title = date.toLocaleString('pt-BR'); }
      item.append(author, text, time); $('chatMessages').append(item);
    }
    $('chatOlder').hidden = !hasMore;
    history.scrollTop = older ? oldTop + history.scrollHeight - oldHeight : preserve ? oldTop : history.scrollHeight;
    if (StudiofyChatSync.viewedEnd(history)) $('chatNew').hidden = true;
  }
  async function acknowledge() {
    if (!dialog.open || $('chatConversation').hidden || !StudiofyChatSync.viewedEnd(history) || !messages.size) return;
    const last = Math.max(0, ...[...messages.values()].filter(m => m.sender_type === 'establishment').map(m => m.id));
    if (last <= readThrough) return;
    await request('/read', { throughMessageId: last }); readThrough = last;
  }
  async function synchronize() {
    for (let page = 0; page < 3; page++) {
      if (document.hidden || !dialog.open) return;
      const data = await request('/messages' + (newest ? '?after=' + newest : ''));
      const follow = StudiofyChatSync.nearEnd(history), top = history.scrollTop;
      const incoming = data.messages.filter(m => !messages.has(m.id));
      for (const message of data.messages) messages.set(message.id, message);
      if (data.newestId) newest = data.newestId;
      if (!oldest) { oldest = data.oldestId; hasMore = data.hasMore; }
      if (incoming.length) {
        render(false, !follow || document.hidden || !dialog.open);
        if (!follow) { history.scrollTop = top; $('chatNew').hidden = false; }
      }
      if (!data.hasMore) break;
    }
    await acknowledge();
  }
  async function load(older = false, sent = false) {
    if (busy) return;
    loading(true); notice('Carregando conversa...');
    try {
      await sync.idle();
      const data = await request('/messages' + (older && oldest ? '?before=' + oldest : ''));
      identified = true;
      if (!older) messages.clear();
      for (const message of data.messages) messages.set(message.id, message);
      oldest = data.oldestId; hasMore = data.hasMore; screen('conversation'); render(older); notice(sent ? 'Mensagem enviada' : '');
      if (!older) newest = data.newestId;
      if (pending && data.messages.some(m => m.client_message_id === pending.clientMessageId && m.sender_type === 'customer')) {
        if ($('chatMessage').value.trim() === pending.content) $('chatMessage').value = '';
        pending = null;
      }
      if (!older) { focus('chatMessage'); await acknowledge(); }
    } catch (error) { failure(error); if (sent && ![401, 403, 404].includes(error.status)) notice('Mensagem enviada. Não foi possível atualizar a conversa. Use Atualizar conversa.', true); }
    finally { loading(false); }
  }
  $('chatLauncher').onclick = () => { dialog.showModal(); viewport(); if (!busy) { if (!identified) screen('loading'); load(); } };
  $('chatClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { sync.stop(); $('chatLauncher').focus({ preventScroll: true }); });
  $('chatNew').onclick = () => { history.scrollTop = history.scrollHeight; $('chatNew').hidden = true; sync.wake(); };
  history.addEventListener('scroll', () => { if (StudiofyChatSync.viewedEnd(history)) { $('chatNew').hidden = true; } });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $('chatRefresh').onclick = () => load(); $('chatRetry').onclick = () => load(); $('chatOlder').onclick = () => load(true);
  $('chatIdentityForm').onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    const inputName = $('chatName'), inputPhone = $('chatPhone');
    const validName = inputName.value.trim() && !/[<>\x00-\x1f]/.test(inputName.value);
    const validPhone = /^[+\d\s().-]+$/.test(inputPhone.value) && /^\d{10,15}$/.test(inputPhone.value.replace(/\D/g, ''));
    inputName.setCustomValidity(validName ? '' : 'Informe seu nome, sem HTML.');
    inputPhone.setCustomValidity(validPhone ? '' : 'Informe um telefone válido com DDD.');
    if (!$('chatIdentityForm').reportValidity()) return;
    loading(true); notice('Carregando conversa...');
    try { await sync.idle(); await request('/session', { name: inputName.value.trim(), phone: inputPhone.value }); identified = true; }
    catch (error) { failure(error); return; }
    finally { loading(false); }
    await load();
  };
  for (const id of ['chatName', 'chatPhone']) $(id).addEventListener('input', () => $(id).setCustomValidity(''));
  $('chatSendForm').onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    const content = $('chatMessage').value.trim();
    if (!content || content.length > 2000 || /[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) { notice('Digite uma mensagem de até 2.000 caracteres, sem HTML.', true); focus('chatMessage'); return; }
    if (!pending || pending.content !== content) pending = { content, clientMessageId: crypto.randomUUID() };
    loading(true); notice('Enviando...'); let sent = false;
    try {
      await sync.idle();
      const data = await request('/messages', pending); messages.set(data.message.id, data.message); pending = null;
      $('chatMessage').value = ''; render(); notice('Mensagem enviada'); sent = true;
    } catch (error) { failure(error, true); }
    finally { loading(false); focus('chatMessage'); }
    if (sent) await load(false, true);
  };
})();
