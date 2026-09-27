(() => {
  'use strict';
  let dispose = () => {}, session = null;
  const unavailable = 'O WhatsApp está temporariamente indisponível. Aguarde alguns minutos antes de tentar novamente.';
  function unmount() { dispose(); dispose = () => {}; }
  function mount(view, token, accountId, denied) {
    unmount();
    if (!session || session.token !== token || session.id !== accountId) session = {
      token, id: accountId, connected: false, attempt: false, checked: false, qr: '', number: '',
      until: 0, failures: 0, deadline: 0, polls: 0, inFlight: null, note: '', paused: false,
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
        </div><div class="sw-actions"><button id="whatsappConnect" class="primary" type="button">Conectar WhatsApp</button>
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
      $('whatsappState').textContent = cooling ? 'WhatsApp temporariamente indisponível' : !s.checked && !busy ? 'Estado da conexão não confirmado' : s.connected ? '🟢 WhatsApp conectado' : s.attempt ? 'Preparando conexão...' : s.checked ? '🔴 WhatsApp desconectado' : 'Consultando conexão...';
      $('whatsappNumber').hidden = !s.connected || !s.number;
      $('whatsappNumber').textContent = s.number ? `Número conectado: +${s.number}` : '';
      $('whatsappNotice').textContent = cooling ? `${unavailable} Nova consulta em ${Math.ceil((s.until - Date.now()) / 1000)} s.` : s.note;
      $('whatsappConnect').hidden = s.connected || s.attempt;
      $('whatsappConnect').disabled = busy || cooling || !s.checked;
      $('whatsappRefresh').disabled = busy || cooling;
      $('whatsappDisconnect').hidden = !s.connected && !s.attempt;
      $('whatsappDisconnect').disabled = busy || cooling;
      $('whatsappConfirmDisconnect').disabled = busy || cooling;
      $('whatsappQrArea').hidden = !s.qr || s.connected || cooling;
      if (s.qr && !s.connected && !cooling) $('whatsappQr').src = s.qr;
      else $('whatsappQr').removeAttribute('src');
      if (cooling && visible()) countdown = setTimeout(paint, 1000); // UI only; never retries the provider.
    }
    function schedule() {
      stop();
      if (!visible() || !s.attempt || s.connected || s.paused || s.inFlight || Date.now() < s.until) return;
      if (Date.now() >= s.deadline || s.polls >= 12) {
        s.paused = true; s.qr = ''; s.note = 'O acompanhamento terminou. Atualize o status ou desconecte a tentativa antes de iniciar outra conexão.'; paint(); return;
      }
      timer = setTimeout(() => {
        if (Date.now() >= s.deadline) { schedule(); return; }
        s.polls++; run('status');
      }, Math.min(60000, 15000 * 2 ** s.failures));
    }
    function apply(data, action) {
      s.checked = true; s.failures = 0;
      s.connected = Boolean(data.connected || data.conectado || ['connected', 'conectado'].includes(data.status));
      s.number = s.connected && /^\d{10,15}$/.test(data.connectedNumber || '') ? data.connectedNumber : '';
      if (s.connected || action === 'logout') { s.attempt = false; s.qr = ''; s.deadline = 0; s.polls = 0; s.paused = false; }
      else {
        const attempting = action === 'iniciar' || data.connectionAttemptActive || ['pairing', 'iniciando', 'qr_pronto'].includes(data.status);
        if (attempting) {
          s.attempt = true;
          if (!s.deadline) { s.deadline = Date.now() + 180000; s.polls = 0; }
          const qr = data.qrCode || data.qr || '';
          if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(qr) || /^https:\/\/api\.qrserver\.com\/v1\/create-qr-code\/\?/.test(qr)) s.qr = qr;
        } else { s.attempt = false; s.qr = ''; s.deadline = 0; s.polls = 0; s.paused = false; }
      }
      s.note = s.connected ? 'Sua conexão está pronta.' : s.attempt ? s.qr ? 'Escaneie o QR Code abaixo para concluir a conexão.' : 'Preparando conexão... Aguarde o QR Code ou atualize o status. Não é necessário conectar novamente.' : 'Conecte seu WhatsApp para utilizar a integração do estabelecimento.';
    }
    function fail(error, action) {
      s.checked = false; s.qr = ''; s.failures++;
      if (action === 'iniciar' && (!error.status || error.status >= 500 || error.status === 409)) s.attempt = true;
      if (error.status === 429 || error.data?.errorCode === 'EVOLUTION_RATE_LIMIT') {
        const seconds = Math.max(30, Number(error.data?.retryAfterSeconds) || 0, error.retrySeconds || 0);
        s.until = Math.max(s.until, Date.now() + seconds * 1000, Number(error.data?.retryAt) || 0);
        s.paused = true; s.note = unavailable; stop();
      } else {
        s.note = error.status === 401 ? 'Sua sessão expirou. Entre novamente no painel.' : error.status === 403 ? 'O acesso a esta conexão está indisponível para sua conta.' : 'Não foi possível confirmar a conexão. Atualize o status antes de tentar novamente.';
        const permanent = [400, 401, 403, 404, 409].includes(error.status) || ['EVOLUTION_INVALID_KEY', 'EVOLUTION_NOT_CONFIGURED', 'EVOLUTION_INVALID_URL', 'EVOLUTION_ENDPOINT_NOT_FOUND', 'EVOLUTION_INVALID_RESPONSE', 'EVOLUTION_STATE_UNKNOWN'].includes(error.data?.errorCode);
        if (action !== 'status' || permanent || s.failures >= 3) { s.paused = true; stop(); }
        if (active && error.status === 401) location.assign('/login.html');
        else if (active && error.status === 403) { unmount(); denied(); }
      }
    }
    async function run(action) {
      if (!visible() || s.inFlight || Date.now() < s.until) return;
      if (action === 'iniciar' && (!s.checked || s.attempt || s.connected)) return;
      stop();
      if (action === 'iniciar') { s.attempt = true; s.paused = false; s.deadline = Date.now() + 180000; s.polls = 0; s.note = 'Preparando conexão...'; }
      s.inFlight = (async () => {
        try {
          const response = await fetch(base + '/' + action, { method: action === 'iniciar' ? 'POST' : action === 'logout' ? 'DELETE' : 'GET',
            headers: { 'Content-Type': 'application/json', 'x-barbeiro-token': token }, cache: 'no-store',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(action === 'iniciar' ? 70000 : 20000)]),
            ...(action === 'iniciar' ? { body: '{}' } : {}) });
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
    $('whatsappConnect').onclick = () => run('iniciar');
    $('whatsappRefresh').onclick = () => run('status');
    $('whatsappDisconnect').onclick = () => { if (!s.inFlight && Date.now() >= s.until) { $('whatsappConfirm').showModal(); $('whatsappCancel').focus(); } };
    $('whatsappCancel').onclick = () => $('whatsappConfirm').close();
    $('whatsappConfirmDisconnect').onclick = () => { $('whatsappConfirm').close(); run('logout'); };
    function visibility() { if (!visible()) { stop(); clearTimeout(countdown); } else paint(); }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', unmount);
    dispose = () => { active = false; stop(); clearTimeout(countdown); controller.abort(); $('whatsappConfirm')?.close(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', unmount); };
    paint();
    // A previous mount may still be aborting. Wait before checking status; never start a connection here.
    Promise.resolve(s.inFlight).then(() => { if (active) run('status'); });
  }
  window.StudiofyWhatsapp = { mount, unmount };
})();
