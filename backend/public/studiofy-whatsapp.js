(() => {
  'use strict';
  let dispose = () => {}, session = null;
  const unavailable = 'O WhatsApp está temporariamente indisponível. Aguarde alguns minutos antes de tentar novamente.';
  function unmount() { dispose(); dispose = () => {}; }
  function mount(view, token, accountId, denied) {
    unmount();
    if (!session || session.token !== token || session.id !== accountId) session = {
      token, id: accountId, connected: false, attempt: false, checked: false, qr: '', number: '',
      until: 0, failures: 0, deadline: 0, polls: 0, inFlight: null, note: '', paused: false, diagnostic: '',
      mode: 'qr', phone: '', pairing: '', codeUntil: 0, timedOut: false,
    };
    const s = session, controller = new AbortController();
    let active = true, timer = null, countdown = null;
    const base = `/api/publico/assinaturas/${encodeURIComponent(accountId)}/whatsapp`;
    view.innerHTML = `<section class="sw" aria-label="Conectar WhatsApp">
      <p class="muted">Conecte o WhatsApp do seu estabelecimento ao Studiofy.</p>
      <div class="card sw-card"><h2 id="whatsappState" role="status">Consultando conexão...</h2>
        <p id="whatsappNumber" hidden></p><p id="whatsappNotice" class="muted" role="status"></p>
        <div id="whatsappQrArea" hidden><img id="whatsappQr" alt="QR Code para conectar o WhatsApp do estabelecimento" referrerpolicy="no-referrer">
          <ol class="sw-instructions"><li>Abra o WhatsApp no celular</li><li>Vá em Aparelhos conectados</li><li>Toque em Conectar um aparelho</li><li>Escaneie este QR Code</li></ol>
        </div><div id="whatsappPairingArea" hidden><strong id="whatsappPairingValue"></strong>
          <ol class="sw-instructions"><li>Abra o WhatsApp no celular</li><li>Vá em Aparelhos conectados e Conectar um aparelho</li><li>Escolha Conectar com número de telefone</li><li>Digite o código mostrado acima</li></ol></div>
        <form id="whatsappPairingForm" hidden><label for="whatsappPhone">Número do WhatsApp (DDI 55 para Brasil)</label>
          <input id="whatsappPhone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+55 11 99999-9999" maxlength="25">
          <button id="whatsappGenerateCode" class="primary" type="submit">Gerar código</button></form>
        <div class="sw-actions"><button id="whatsappConnect" class="primary" type="button">Conectar por QR Code</button>
          <button id="whatsappPairing" type="button">Conectar com código</button><button id="whatsappRetry" type="button" hidden>Tentar novamente</button>
          <button id="whatsappRefresh" type="button">Atualizar status</button><button id="whatsappDisconnect" type="button" hidden>Desconectar WhatsApp</button></div>
      </div><dialog id="whatsappConfirm" class="sw-confirm" aria-labelledby="whatsappConfirmTitle"><h2 id="whatsappConfirmTitle">Desconectar WhatsApp?</h2>
        <p>O WhatsApp deste estabelecimento será desconectado. O Chat Studiofy continuará disponível.</p><div class="sw-actions"><button id="whatsappCancel" type="button">Cancelar</button><button id="whatsappConfirmDisconnect" type="button">Desconectar WhatsApp</button></div></dialog>
    </section>`;
    const $ = id => view.querySelector('#' + id);
    const visible = () => active && !document.hidden;
    function stop() { clearTimeout(timer); timer = null; }
    function paint() {
      if (!active) return;
      clearTimeout(countdown);
      const cooling = Date.now() < s.until, busy = Boolean(s.inFlight);
      if (s.attempt && !s.connected && !busy && !s.timedOut && ((s.codeUntil && Date.now() >= s.codeUntil) || (s.deadline && Date.now() >= s.deadline))) {
        s.timedOut = true; s.paused = true; s.note = s.qr || s.pairing ? 'O código expirou. Toque em Tentar novamente para recuperar um código atualizado.' : 'O WhatsApp não disponibilizou um código no prazo. Toque em Tentar novamente. Sua instância será preservada.';
        s.qr = ''; s.pairing = ''; stop();
      }
      $('whatsappState').textContent = cooling ? 'WhatsApp temporariamente indisponível' : s.connected ? '🟢 WhatsApp conectado' : s.timedOut ? 'Código de conexão indisponível' : !s.checked && !busy ? 'Estado da conexão não confirmado' : s.qr ? 'Aguardando leitura do QR Code' : s.pairing ? 'Aguardando código no WhatsApp' : s.attempt ? 'Preparando conexão...' : s.checked ? '🔴 WhatsApp desconectado' : 'Consultando conexão...';
      $('whatsappNumber').hidden = !s.connected || !s.number;
      $('whatsappNumber').textContent = s.number ? `Número conectado: +${s.number}` : '';
      $('whatsappNotice').textContent = (cooling ? `${s.note || unavailable} Nova consulta em ${Math.ceil((s.until - Date.now()) / 1000)} s.` : s.note) + (s.diagnostic ? ` ${s.diagnostic}` : '');
      $('whatsappConnect').hidden = s.connected || (s.attempt && !s.timedOut);
      $('whatsappConnect').disabled = busy || cooling || !s.checked;
      $('whatsappPairing').hidden = $('whatsappConnect').hidden;
      $('whatsappPairing').disabled = busy || cooling || !s.checked;
      $('whatsappGenerateCode').disabled = busy || cooling || !s.checked || (s.attempt && !s.timedOut);
      $('whatsappPhone').disabled = busy;
      $('whatsappPairingForm').hidden = s.connected || s.mode !== 'pairing' || Boolean(s.pairing) || (s.attempt && !s.timedOut);
      $('whatsappPairingArea').hidden = !s.pairing || s.connected;
      $('whatsappPairingValue').textContent = s.pairing.replace(/^([A-Z0-9]{4})([A-Z0-9]{4})$/i, '$1-$2');
      $('whatsappRetry').hidden = s.connected || !s.attempt || (!s.timedOut && !s.paused);
      $('whatsappRetry').disabled = busy || cooling;
      $('whatsappRefresh').disabled = busy || cooling;
      $('whatsappDisconnect').hidden = !s.connected && !s.attempt;
      $('whatsappDisconnect').textContent = s.connected ? 'Desconectar WhatsApp' : 'Encerrar tentativa';
      $('whatsappDisconnect').disabled = busy || cooling;
      $('whatsappConfirmDisconnect').disabled = busy || cooling;
      $('whatsappQrArea').hidden = !s.qr || s.connected;
      if (s.qr && !s.connected) $('whatsappQr').src = s.qr;
      else $('whatsappQr').removeAttribute('src');
      if ((cooling || (s.attempt && !s.timedOut)) && visible()) countdown = setTimeout(paint, 1000); // UI only; never retries the provider.
    }
    function schedule() {
      stop();
      if (!visible() || !s.attempt || s.connected || s.paused || s.inFlight || Date.now() < s.until) return;
      if (Date.now() >= s.deadline || s.polls >= 12) {
        s.paused = true; s.timedOut = true; s.qr = ''; s.pairing = ''; s.note = 'O acompanhamento terminou. Toque em Tentar novamente para recuperar o código com segurança.'; paint(); return;
      }
      timer = setTimeout(() => {
        if (Date.now() >= s.deadline) { schedule(); return; }
        s.polls++; run('status', 'poll');
      }, Math.min(60000, 15000 * 2 ** s.failures));
    }
    function apply(data, action) {
      s.checked = true; s.failures = 0; s.diagnostic = '';
      s.connected = Boolean(data.connected || data.conectado || ['open', 'connected', 'conectado'].includes(data.status));
      s.number = s.connected && /^\d{10,15}$/.test(data.connectedNumber || '') ? data.connectedNumber : '';
      if (s.connected || action === 'logout') { s.attempt = false; s.qr = ''; s.pairing = ''; s.codeUntil = 0; s.timedOut = false; s.deadline = 0; s.polls = 0; s.paused = false; }
      else {
        const attempting = ['iniciar', 'pairing-code', 'recuperar'].includes(action) || data.connectionAttemptActive || ['pairing', 'pairing_code', 'iniciando', 'qr_pronto'].includes(data.status);
        if (attempting) {
          s.attempt = true;
          if (!s.deadline) { s.deadline = Date.now() + 60000; s.polls = 0; }
          if (data.connectionMode) s.mode = data.connectionMode;
          const pairing = data.pairingCode || (s.mode === 'pairing' ? data.code : '') || '';
          const hadCode = Boolean(s.qr || s.pairing);
          const qr = data.qrCode || data.qr || '';
          if (data.codeExpiresInSeconds === 0 && !qr && !pairing) { s.qr = ''; s.pairing = ''; s.codeUntil = 0; }
          if (/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(pairing)) { s.pairing = pairing; s.qr = ''; s.mode = 'pairing'; }
          else if (s.mode === 'qr' && (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(qr) || /^https:\/\/api\.qrserver\.com\/v1\/create-qr-code\/\?/.test(qr))) s.qr = qr;
          if (s.qr || s.pairing) {
            s.codeUntil = Date.now() + (data.codeExpiresInSeconds || 60) * 1000;
            if (!hadCode) s.deadline = Date.now() + 180000;
            s.timedOut = false;
          } else if (data.connectionTimedOut) { s.timedOut = true; s.paused = true; }
        } else { s.attempt = false; s.qr = ''; s.pairing = ''; s.codeUntil = 0; s.timedOut = false; s.deadline = 0; s.polls = 0; s.paused = false; }
      }
      s.note = s.connected ? 'Sua conexão está pronta.' : s.timedOut ? 'O WhatsApp não disponibilizou um código no prazo. Toque em Tentar novamente.' : s.attempt ? s.qr ? 'Escaneie o QR Code abaixo para concluir a conexão.' : s.pairing ? 'Digite este código no WhatsApp do celular.' : 'Preparando conexão... Aguardando o código do WhatsApp por até 60 segundos.' : 'Escolha QR Code ou código de pareamento para conectar seu WhatsApp.';
    }
    function fail(error, action) {
      s.checked = false; if (action !== 'status') s.qr = ''; s.failures++;
      const details = error.data?.diagnostic;
      s.diagnostic = details?.requestId ? `Referência: ${details.requestId}. Etapa: ${details.endpoint || action}.` : '';
      if (['iniciar', 'pairing-code', 'recuperar'].includes(action) && (!error.status || error.status >= 500 || error.status === 409)) { s.attempt = true; s.timedOut = true; }
      if (error.status === 429 || error.data?.errorCode === 'EVOLUTION_RATE_LIMIT') {
        // Relative server durations also work when the browser clock is skewed.
        const supplied = Math.max(Number(error.data?.retryAfterSeconds) || 0, error.retrySeconds || 0);
        const seconds = Number.isFinite(supplied) && supplied > 0 ? supplied : 30;
        s.until = Math.max(s.until, Date.now() + seconds * 1000);
        const source = error.data?.rateLimitSource === 'local_cooldown'
          ? 'Bloqueio local após um HTTP 429 anterior da Evolution; esta consulta não foi enviada ao provedor.'
          : 'A Evolution ou seu proxy respondeu HTTP 429 (limite de requisições).';
        s.paused = true; s.note = `${unavailable} ${source}`; stop();
      } else {
        s.note = error.status === 401 ? 'Sua sessão expirou. Entre novamente no painel.' : error.status === 403 ? 'O acesso a esta conexão está indisponível para sua conta.' : error.data?.message || 'Não foi possível confirmar a conexão. Atualize o status antes de tentar novamente.';
        const permanent = [400, 401, 403, 404, 409].includes(error.status) || ['EVOLUTION_INVALID_KEY', 'EVOLUTION_NOT_CONFIGURED', 'EVOLUTION_INVALID_URL', 'EVOLUTION_ENDPOINT_NOT_FOUND', 'EVOLUTION_INVALID_RESPONSE', 'EVOLUTION_STATE_UNKNOWN'].includes(error.data?.errorCode);
        if (action !== 'status' || permanent || s.failures >= 3) { s.paused = true; stop(); }
        if (active && error.status === 401) location.assign('/login.html');
        else if (active && error.status === 403) { unmount(); denied(); }
      }
    }
    async function run(action, trigger) {
      if (!visible() || s.inFlight || Date.now() < s.until) return;
      const starting = ['iniciar', 'pairing-code'].includes(action);
      if (starting && (!s.checked || (s.attempt && !s.timedOut) || s.connected)) return;
      if (starting && s.attempt) action = 'recuperar';
      stop();
      if (action === 'status' && trigger === 'manual_status') s.paused = false;
      if (starting || action === 'recuperar') { s.attempt = true; s.timedOut = false; s.codeUntil = 0; s.paused = false; s.deadline = Date.now() + 60000; s.polls = 0; s.note = 'Preparando conexão...'; }
      s.inFlight = (async () => {
        try {
          const mutation = ['iniciar', 'pairing-code', 'recuperar'].includes(action);
          const response = await fetch(base + '/' + action, { method: mutation ? 'POST' : action === 'logout' ? 'DELETE' : 'GET',
            headers: { 'Content-Type': 'application/json', 'x-barbeiro-token': token, 'x-whatsapp-trigger': trigger }, cache: 'no-store',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(mutation ? 70000 : 20000)]),
            ...(mutation ? { body: JSON.stringify({ mode: s.mode, ...(s.mode === 'pairing' ? { phone: s.phone } : {}) }) } : {}) });
          const data = await response.json();
          if (!response.ok || data.success === false) {
            const retry = response.headers.get('Retry-After');
            const retrySeconds = /^\d+$/.test(retry || '') ? Number(retry) : Math.max(0, (Date.parse(retry) - Date.now()) / 1000) || 0;
            throw { status: response.status, data, retrySeconds };
          }
          apply(data, action);
        } catch (error) {
          if (controller.signal.aborted) { s.checked = false; return; }
          fail(error, action);
        }
      })();
      paint();
      try { await s.inFlight; } finally { s.inFlight = null; paint(); schedule(); }
    }
    $('whatsappConnect').onclick = () => { if ($('whatsappConnect').disabled || (s.attempt && !s.timedOut)) return; s.mode = 'qr'; run('iniciar', 'connect_click'); };
    $('whatsappPairing').onclick = () => { if ($('whatsappPairing').disabled || (s.attempt && !s.timedOut)) return; s.mode = 'pairing'; paint(); $('whatsappPhone').focus(); };
    $('whatsappPairingForm').onsubmit = event => { event.preventDefault(); s.phone = $('whatsappPhone').value.trim(); if (!s.phone) { s.note = 'Informe o número do WhatsApp com DDD.'; paint(); return; } run('pairing-code', 'connect_click'); };
    $('whatsappRetry').onclick = () => run('recuperar', 'connect_click');
    $('whatsappRefresh').onclick = () => run('status', 'manual_status');
    $('whatsappDisconnect').onclick = () => { if (!s.inFlight && Date.now() >= s.until) { $('whatsappConfirm').showModal(); $('whatsappCancel').focus(); } };
    $('whatsappCancel').onclick = () => $('whatsappConfirm').close();
    $('whatsappConfirmDisconnect').onclick = () => { $('whatsappConfirm').close(); run('logout', 'logout_click'); };
    function visibility() { if (!visible()) { stop(); clearTimeout(countdown); } else { paint(); schedule(); } }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', unmount);
    dispose = () => { active = false; stop(); clearTimeout(countdown); controller.abort(); $('whatsappConfirm')?.close(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', unmount); };
    paint();
    // A previous mount may still be aborting. Wait before checking status; never start a connection here.
    Promise.resolve(s.inFlight).then(() => { if (active) run('status', 'section_open'); });
  }
  window.StudiofyWhatsapp = { mount, unmount };
})();
