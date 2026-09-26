(() => {
  'use strict';
  let total = 0, dispose = () => {}, badgeVersion = 0;
  let mounted = false, blocked = false, badgeSync = null, badgeToken = null;
  const originalTitle = document.title;
  const base = '/api/chat/conversations';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = value => value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  function paintBadge() {
    document.title = total ? `(${total}) Studiofy` : originalTitle;
    const badge = document.querySelector('#inboxBadge');
    if (badge) { badge.textContent = total; badge.hidden = !total; badge.setAttribute('aria-label', `${total} mensagens não lidas`); }
  }
  async function refreshBadge(token) {
    if (badgeSync && badgeToken === token) return;
    badgeSync?.dispose(); badgeToken = token; blocked = false;
    const connection = value => { const el = document.querySelector('#inboxBadgeConnection'); if (el) el.hidden = !value; };
    badgeSync = StudiofyChatSync.create({ interval: 20000, enabled: () => !mounted && !blocked,
      task: async () => {
        const version = ++badgeVersion;
        const response = await fetch(base + '/unread', { headers: { 'x-barbeiro-token': token || '' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if ([401, 403].includes(response.status)) { pause(); return; }
        if (!response.ok) throw { status: response.status, retryAfterMs: (Number(response.headers.get('Retry-After')) || 0) * 1000 };
        const data = await response.json(); if (version === badgeVersion && !blocked) { total = data.messages; paintBadge(); }
      }, failed: () => connection(true), recovered: () => connection(false) });
    badgeSync.wake();
  }
  function unmount() { const wasMounted = mounted; dispose(); dispose = () => {}; mounted = false; if (wasMounted) badgeSync?.start(); }
  function pause() { blocked = true; ++badgeVersion; unmount(); badgeSync?.stop(); total = 0; paintBadge(); }
  function resume() { if (blocked) { blocked = false; badgeSync?.start(); } }
  function mount(view, token, denied) {
    unmount(); ++badgeVersion; mounted = true; badgeSync?.stop();
    const controller = new AbortController(); let active = true, busy = false, selected = null, cursor = null, oldest = null, hasMore = false, retryAt = 0, query = '';
    let conversations = [], messages = new Map(); const drafts = new Map();
    let newest = null, readThrough = 0, lastListAt = 0;
    view.innerHTML = `<section class="ci" aria-label="Conversas do estabelecimento">
      <aside class="ci-list-pane"><header class="ci-list-heading"><div><span class="ci-eyebrow">ATENDIMENTO</span><h2>Caixa de entrada</h2></div><button id="inboxRefresh" type="button">Atualizar</button></header>
        <p class="ci-hint">Mensagens atualizadas automaticamente.</p>
        <form id="inboxSearchForm" class="ci-search"><label for="inboxSearch">Buscar conversa</label><div><input id="inboxSearch" type="search" maxlength="80" placeholder="Nome ou telefone" autocomplete="off"><button type="submit" aria-label="Buscar conversa">Buscar</button></div></form>
        <div id="inboxList" class="ci-list" aria-label="Lista de conversas"></div><button id="inboxMore" type="button" hidden>Mais conversas</button>
      </aside>
      <section id="inboxThread" class="ci-thread" aria-label="Conversa selecionada"><div class="ci-empty"><span aria-hidden="true">✉</span><h2>Uma conversa de cada vez</h2><p>Selecione um cliente para ler e responder.</p><span class="ci-channel">● Chat Studiofy</span></div></section>
      <div id="inboxNotice" class="ci-notice" role="status" aria-live="polite"></div>
      <div id="inboxConnection" class="ci-notice" role="status" hidden>Tentando atualizar…</div>
    </section>`;
    const root = view.querySelector('.ci'), $ = id => root.querySelector('#' + id);
    const sync = StudiofyChatSync.create({ interval: 8000, enabled: () => active && !busy && !blocked, task: synchronize,
      recovered: () => { if (active) $('inboxConnection').hidden = true; }, failed: error => {
        if ([401, 403, 404].includes(error.status)) failure(error); else if (active) $('inboxConnection').hidden = false;
      } });
    function viewport() { root.style.setProperty('--ci-vh', (window.visualViewport?.height || innerHeight) + 'px'); root.style.setProperty('--ci-top', (window.visualViewport?.offsetTop || 0) + 'px'); }
    viewport(); window.visualViewport?.addEventListener('resize', viewport); window.visualViewport?.addEventListener('scroll', viewport);
    dispose = () => { active = false; sync.dispose(); controller.abort(); window.visualViewport?.removeEventListener('resize', viewport); window.visualViewport?.removeEventListener('scroll', viewport); };
    function notice(text = '', error = false) { if (!active) return; $('inboxNotice').textContent = text; $('inboxNotice').classList.toggle('ci-error', error); }
    function lock(value) { busy = value; if (!active) return; root.setAttribute('aria-busy', String(value)); root.querySelectorAll('button,input,textarea').forEach(el => { el.disabled = value; }); if (!value) sync.start(); }
    async function request(path, body) {
      if (Date.now() < retryAt) throw { status: 429, retryAfterMs: retryAt - Date.now() };
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/json', 'x-barbeiro-token': token || '' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.status === 429) retryAt = Date.now() + Math.max(1, Number(response.headers.get('Retry-After')) || 60) * 1000;
      if (!response.ok) throw { status: response.status, retryAfterMs: Math.max(0, retryAt - Date.now()) };
      return response.json();
    }
    function failure(error, sending = false) {
      if (!active) return;
      if (error.status === 401) { pause(); location.assign('/login.html'); return; }
      if (error.status === 403) { pause(); view.replaceChildren(); denied(); return; }
      if (error.status === 404) { selected = null; root.classList.remove('ci-open'); }
      notice(error.status === 429 ? 'Muitas tentativas. Aguarde um momento.' : error.status === 404 ? 'Conversa indisponível.' : error.status === 400 ? 'Confira o texto. Use até 2.000 caracteres, sem HTML.' : sending ? 'Não foi possível enviar a mensagem.' : 'Não foi possível carregar as conversas. Tente atualizar novamente.', true);
    }
    function renderList() {
      const top = $('inboxList').scrollTop, focused = document.activeElement?.dataset?.conversation;
      $('inboxList').innerHTML = conversations.length ? conversations.map(c => `<button type="button" class="ci-item ${selected === c.id ? 'is-selected' : ''}" data-conversation="${escape(c.id)}" aria-pressed="${selected === c.id}"><span class="ci-avatar" aria-hidden="true">${escape(c.name.slice(0, 1).toUpperCase())}</span><span class="ci-item-body"><span class="ci-item-top"><strong>${escape(c.name)}</strong><time datetime="${escape(c.last_message_at)}">${time(c.last_message_at)}</time></span><span class="ci-preview">${escape(c.last_message || 'Conversa iniciada. Envie uma mensagem.')}</span><span class="ci-item-bottom"><span class="ci-channel">● Chat Studiofy</span>${c.unread_count ? `<span class="ci-badge" aria-label="${c.unread_count} mensagens não lidas">${c.unread_count}</span>` : ''}</span></span></button>`).join('') : `<div class="ci-empty"><span aria-hidden="true">✉</span><h3>${query ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda'}</h3><p>${query ? 'Tente outro nome ou telefone.' : 'As mensagens da sua página pública aparecerão aqui.'}</p></div>`;
      $('inboxMore').hidden = !cursor;
      root.querySelectorAll('[data-conversation]').forEach(button => { button.onclick = () => open(button.dataset.conversation); });
      $('inboxList').scrollTop = top;
      if (focused) root.querySelector(`[data-conversation="${focused}"]`)?.focus({ preventScroll: true });
    }
    async function list(more = false, background = false) {
      const data = await request('/search', { query, ...(more && cursor ? { cursor } : {}) });
      if (!active) return;
      conversations = more || background ? [...new Map([...conversations, ...data.conversations].map(c => [c.id, c])).values()].sort((a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at) || b.id.localeCompare(a.id)) : data.conversations;
      cursor = data.nextCursor; renderList(); lastListAt = Date.now();
      const unread = await request('/unread'); if (active) { total = unread.messages; paintBadge(); }
    }
    function drawThread(conversation) {
      $('inboxThread').innerHTML = `<header class="ci-thread-heading"><button id="inboxBack" type="button">← Voltar para conversas</button><div><h2 id="inboxClientName">${escape(conversation.name)}</h2><span class="ci-channel">● Chat Studiofy</span></div><button id="inboxThreadRefresh" type="button">Atualizar conversa</button></header>
        <details class="ci-customer"><summary>Cliente · Dados de contato</summary><dl><div><dt>Nome</dt><dd>${escape(conversation.name)}</dd></div><div><dt>Telefone</dt><dd>${escape(conversation.phone)}</dd></div></dl><p>Dados informados pelo cliente. Sem vínculo verificado com agendamentos.</p></details>
        <div id="inboxHistory" class="ci-history" tabindex="0" aria-label="Histórico da conversa"><button id="inboxOlder" type="button" hidden>Ver mensagens anteriores</button><div id="inboxMessages"></div></div>
        <button id="inboxNew" class="ci-new" type="button" hidden>↓ Nova mensagem</button>
        <form id="inboxReplyForm" class="ci-composer"><label for="inboxReply">Digite uma resposta</label><div><textarea id="inboxReply" rows="2" maxlength="2000" required placeholder="Como podemos ajudar?"></textarea><button id="inboxSend" type="submit">Enviar</button></div></form>`;
      $('inboxReply').value = drafts.get(selected)?.content || '';
      $('inboxReply').oninput = () => { const draft = drafts.get(selected); drafts.set(selected, { content: $('inboxReply').value, clientMessageId: draft?.content === $('inboxReply').value ? draft.clientMessageId : null }); };
      $('inboxBack').onclick = () => { root.classList.remove('ci-open'); root.querySelector(`[data-conversation="${selected}"]`)?.focus(); };
      $('inboxOlder').onclick = () => history(true);
      $('inboxThreadRefresh').onclick = () => refresh();
      $('inboxReplyForm').onsubmit = send;
      $('inboxNew').onclick = () => { $('inboxHistory').scrollTop = $('inboxHistory').scrollHeight; $('inboxNew').hidden = true; sync.wake(); };
      $('inboxHistory').addEventListener('scroll', () => { if (StudiofyChatSync.viewedEnd($('inboxHistory'))) $('inboxNew').hidden = true; });
    }
    function renderMessages(older = false, preserve = false) {
      const history = $('inboxHistory'), height = history.scrollHeight, top = history.scrollTop;
      $('inboxMessages').innerHTML = messages.size ? [...messages.values()].sort((a, b) => a.id - b.id).map(m => `<article class="ci-message ${m.sender_type === 'establishment' ? 'ci-mine' : 'ci-theirs'}"><span class="ci-sr">${m.sender_type === 'establishment' ? 'Estabelecimento' : 'Cliente'}: </span><p>${escape(m.content)}</p><time datetime="${escape(m.created_at)}" title="${escape(new Date(m.created_at).toLocaleString('pt-BR'))}">${time(m.created_at)}</time></article>`).join('') : '<div class="ci-empty"><h3>A conversa começa aqui</h3><p>Nenhuma mensagem ainda.</p></div>';
      $('inboxOlder').hidden = !hasMore;
      history.scrollTop = older ? top + history.scrollHeight - height : preserve ? top : history.scrollHeight;
      if (StudiofyChatSync.viewedEnd(history)) $('inboxNew').hidden = true;
    }
    async function read() {
      if (!active || !StudiofyChatSync.viewedEnd($('inboxHistory')) || !messages.size || !root.classList.contains('ci-open')) return false;
      // O histórico foi desenhado e rolado até a mensagem mais recente antes de confirmar leitura.
      const last = Math.max(0, ...[...messages.values()].filter(m => m.sender_type === 'customer').map(m => m.id));
      if (last <= readThrough) return false;
      await request('/' + selected + '/read', { throughMessageId: last }); readThrough = last; return true;
    }
    async function fetchHistory(older = false) {
      const data = await request('/' + selected + '/messages' + (older && oldest ? '?before=' + oldest : ''));
      if (!active) return;
      if (!older) messages.clear();
      for (const message of data.messages) messages.set(message.id, message);
      oldest = data.oldestId; hasMore = data.hasMore;
      if (!older) newest = data.newestId;
      if (!$('inboxHistory')) drawThread(data.conversation);
      renderMessages(older); if (!older) await read();
    }
    async function open(id) {
      if (busy) return; lock(true); await sync.idle(); if (!active) return;
      selected = id; messages.clear(); newest = null; readThrough = 0; root.classList.add('ci-open');
      $('inboxThread').innerHTML = '<p class="ci-loading">Carregando mensagens...</p>'; renderList(); lock(true); notice('Carregando mensagens...');
      try { await fetchHistory(); await list(); notice(); }
      catch (error) {
        failure(error);
        if (active && !$('inboxHistory')) { root.classList.remove('ci-open'); selected = null; $('inboxThread').innerHTML = '<div class="ci-empty"><h2>Conversa indisponível</h2><p>Selecione a conversa para tentar novamente.</p></div>'; }
      }
      finally { lock(false); if (active) $('inboxReply')?.focus({ preventScroll: true }); }
    }
    async function history(older) {
      if (busy) return; lock(true); notice('Carregando mensagens...');
      try { await sync.idle(); await fetchHistory(older); notice(); } catch (error) { failure(error); } finally { lock(false); }
    }
    async function refresh(more = false) {
      if (busy) return; lock(true); notice('Carregando conversas...');
      try { await sync.idle(); await badgeSync?.idle(); if (!more && selected && root.classList.contains('ci-open')) await fetchHistory(); await list(more); notice(); }
      catch (error) { failure(error); } finally { lock(false); }
    }
    async function send(event) {
      event.preventDefault(); if (busy) return;
      const content = $('inboxReply').value.trim();
      if (!content || content.length > 2000 || /[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) { notice('Use até 2.000 caracteres, sem HTML.', true); return; }
      const previous = drafts.get(selected); const draft = { content, clientMessageId: previous?.content === content && previous.clientMessageId ? previous.clientMessageId : crypto.randomUUID() }; drafts.set(selected, draft);
      lock(true); notice('Enviando...'); let sent = false;
      try {
        await sync.idle();
        const data = await request('/' + selected + '/messages', draft); sent = true;
        if (!active) return;
        drafts.delete(selected); $('inboxReply').value = ''; messages.set(data.message.id, data.message); renderMessages();
        await fetchHistory(); await list(); notice('Mensagem enviada.');
      } catch (error) { failure(error, true); if (sent && active && ![401, 403].includes(error.status)) notice('Mensagem enviada. Não foi possível atualizar. Use Atualizar conversa.', true); }
      finally { lock(false); if (active) $('inboxReply')?.focus({ preventScroll: true }); }
    }
    async function synchronize() {
      let changed = false;
      if (selected && root.classList.contains('ci-open') && $('inboxHistory')) {
        for (let page = 0; page < 3; page++) {
          if (!active || document.hidden || !root.classList.contains('ci-open')) return;
          const data = await request('/' + selected + '/messages' + (newest ? '?after=' + newest : ''));
          if (!active) return;
          const history = $('inboxHistory'), follow = StudiofyChatSync.nearEnd(history);
          const incoming = data.messages.filter(m => !messages.has(m.id));
          for (const message of data.messages) messages.set(message.id, message);
          if (data.newestId) newest = data.newestId;
          if (!oldest) { oldest = data.oldestId; hasMore = data.hasMore; }
          if (incoming.length) { changed = true; renderMessages(false, !follow || document.hidden); if (!follow) $('inboxNew').hidden = false; }
          if (!data.hasMore) break;
        }
        changed = await read() || changed;
      }
      if (!active || document.hidden) return;
      if (changed || Date.now() - lastListAt >= 20000) await list(false, true);
    }
    $('inboxSearchForm').onsubmit = event => { event.preventDefault(); query = $('inboxSearch').value.trim(); cursor = null; refresh(); };
    $('inboxRefresh').onclick = () => refresh(); $('inboxMore').onclick = () => refresh(true);
    refresh();
  }
  window.StudiofyInbox = { mount, unmount, pause, resume, paintBadge, refreshBadge };
})();
