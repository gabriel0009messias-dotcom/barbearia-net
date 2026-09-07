import React, { useEffect, useMemo, useState } from 'react';
import { apiRequest, clearToken, getToken, setToken } from './services/api';
import './styles.css';

const routes = [
  { path: '/dashboard', label: 'Dashboard' },
  { path: '/agendamentos', label: 'Agendamentos' },
  { path: '/clientes', label: 'Clientes' },
  { path: '/servicos', label: 'Servicos' },
  { path: '/profissionais', label: 'Profissionais' },
  { path: '/horarios', label: 'Horarios' },
  { path: '/bloqueios', label: 'Bloqueios' },
  { path: '/financeiro', label: 'Financeiro' },
  { path: '/assinatura', label: 'Assinatura' },
  { path: '/whatsapp', label: 'WhatsApp' },
  { path: '/configuracoes', label: 'Configuracoes' },
];

function formatCurrency(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function useRoute() {
  const [route, setRoute] = useState(window.location.pathname || '/login');

  useEffect(() => {
    const onPopState = () => setRoute(window.location.pathname || '/login');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function navigate(path) {
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
      setRoute(path);
    }
  }

  return { route, navigate };
}

function PageShell({ user, route, navigate, onLogout, children }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">SaaS Barbearia</p>
          <h1>{user?.salon?.name || 'Painel'}</h1>
          <p className="muted">{user?.name || ''}</p>
        </div>

        <nav className="nav-list">
          {routes.map((item) => (
            <button
              key={item.path}
              type="button"
              className={route === item.path ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate(item.path)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <button type="button" className="ghost-button" onClick={onLogout}>
          Sair
        </button>
      </aside>

      <main className="content">
        <header className="content-header">
          <div>
            <p className="eyebrow">Operacao</p>
            <h2>{routes.find((item) => item.path === route)?.label || 'Painel'}</h2>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

function AuthPage({ mode, onSuccess, onSwitch }) {
  const [form, setForm] = useState({
    salonName: '',
    ownerName: '',
    phone: '',
    email: '',
    password: '',
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      const endpoint = mode === 'register' ? '/auth/register' : '/auth/login';
      const payload =
        mode === 'register'
          ? form
          : {
              email: form.email,
              password: form.password,
            };

      const response = await apiRequest(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setToken(response.token);
      onSuccess(response);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-layout">
      <section className="hero-panel">
        <p className="eyebrow">Plataforma oficial</p>
        <h1>Barbearias e saloes no mesmo sistema, cada um com seus proprios dados.</h1>
        <p className="muted">
          Cadastro, agendamentos, bloqueios, assinatura, dashboard e integracao com WhatsApp em uma unica operacao.
        </p>
      </section>

      <section className="auth-card">
        <p className="eyebrow">{mode === 'register' ? 'Novo cadastro' : 'Acesso'}</p>
        <h2>{mode === 'register' ? 'Criar conta do salao' : 'Entrar na plataforma'}</h2>

        <form className="form-grid" onSubmit={submit}>
          {mode === 'register' ? (
            <>
              <label>
                Nome do salao
                <input
                  value={form.salonName}
                  onChange={(event) => setForm((current) => ({ ...current, salonName: event.target.value }))}
                  required
                />
              </label>
              <label>
                Nome do administrador
                <input
                  value={form.ownerName}
                  onChange={(event) => setForm((current) => ({ ...current, ownerName: event.target.value }))}
                  required
                />
              </label>
              <label>
                Telefone
                <input
                  value={form.phone}
                  onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
                />
              </label>
            </>
          ) : null}

          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
              required
            />
          </label>

          <label>
            Senha
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
              required
            />
          </label>

          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? 'Carregando...' : mode === 'register' ? 'Criar conta' : 'Entrar'}
          </button>
        </form>

        {message ? <p className="error-text">{message}</p> : null}

        <button type="button" className="text-button" onClick={onSwitch}>
          {mode === 'register' ? 'Ja tenho conta' : 'Quero criar uma conta'}
        </button>
      </section>
    </div>
  );
}

function DashboardPage({ data }) {
  return (
    <div className="section-grid">
      <section className="stats-grid">
        <article className="stat-card">
          <span>Clientes</span>
          <strong>{data?.total_clients || 0}</strong>
        </article>
        <article className="stat-card">
          <span>Faturamento do mes</span>
          <strong>{formatCurrency(data?.monthly_revenue || 0)}</strong>
        </article>
        <article className="stat-card">
          <span>Agendamentos hoje</span>
          <strong>{data?.appointments_today?.length || 0}</strong>
        </article>
        <article className="stat-card">
          <span>Status da assinatura</span>
          <strong>{data?.subscription?.status || 'PENDING'}</strong>
        </article>
      </section>

      <section className="card">
        <h3>Proximos agendamentos</h3>
        <Table
          columns={['Data', 'Horario', 'Cliente', 'Servico', 'Profissional']}
          rows={(data?.upcoming_appointments || []).map((item) => [
            item.date,
            item.start_time,
            item.client_name,
            item.service_name,
            item.professional_name,
          ])}
          emptyText="Nenhum agendamento futuro."
        />
      </section>

      <section className="card">
        <h3>Servicos mais usados</h3>
        <Table
          columns={['Servico', 'Total']}
          rows={(data?.top_services || []).map((item) => [item.name, item.total])}
          emptyText="Nenhum dado ainda."
        />
      </section>
    </div>
  );
}

function CrudPage({ title, columns, items, formFields, onCreate, onDelete, loading }) {
  const initialState = useMemo(
    () => formFields.reduce((acc, field) => ({ ...acc, [field.name]: field.defaultValue || '' }), {}),
    [formFields]
  );
  const [form, setForm] = useState(initialState);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setForm(initialState);
  }, [initialState]);

  async function submit(event) {
    event.preventDefault();
    setMessage('');

    try {
      await onCreate(form);
      setForm(initialState);
      setMessage('Registro salvo com sucesso.');
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <div className="section-grid">
      <section className="card">
        <h3>{title}</h3>
        <form className="form-grid compact" onSubmit={submit}>
          {formFields.map((field) => (
            <label key={field.name}>
              {field.label}
              <input
                type={field.type || 'text'}
                value={form[field.name]}
                onChange={(event) => setForm((current) => ({ ...current, [field.name]: event.target.value }))}
                required={field.required}
              />
            </label>
          ))}

          <button type="submit" className="primary-button">
            Salvar
          </button>
        </form>
        {message ? <p className={message.includes('sucesso') ? 'success-text' : 'error-text'}>{message}</p> : null}
      </section>

      <section className="card">
        <Table
          columns={[...columns, 'Acao']}
          rows={items.map((item) => [
            ...columns.map((column) => item[column.key] ?? '-'),
            <button key={item.id} type="button" className="danger-button" onClick={() => onDelete(item.id)}>
              Excluir
            </button>,
          ])}
          emptyText={loading ? 'Carregando...' : 'Nenhum registro encontrado.'}
        />
      </section>
    </div>
  );
}

function AppointmentsPage({ data, related, onCreate, onCancel }) {
  const [form, setForm] = useState({
    clientId: '',
    professionalId: '',
    serviceId: '',
    date: '',
    startTime: '',
  });
  const [message, setMessage] = useState('');

  async function submit(event) {
    event.preventDefault();
    setMessage('');

    try {
      await onCreate(form);
      setForm({
        clientId: '',
        professionalId: '',
        serviceId: '',
        date: '',
        startTime: '',
      });
      setMessage('Agendamento criado com sucesso.');
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <div className="section-grid">
      <section className="card">
        <h3>Novo agendamento</h3>
        <form className="form-grid compact" onSubmit={submit}>
          <label>
            Cliente
            <select value={form.clientId} onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))} required>
              <option value="">Selecione</option>
              {related.clients.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Profissional
            <select
              value={form.professionalId}
              onChange={(event) => setForm((current) => ({ ...current, professionalId: event.target.value }))}
              required
            >
              <option value="">Selecione</option>
              {related.professionals.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Servico
            <select value={form.serviceId} onChange={(event) => setForm((current) => ({ ...current, serviceId: event.target.value }))} required>
              <option value="">Selecione</option>
              {related.services.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Data
            <input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} required />
          </label>
          <label>
            Hora inicial
            <input
              type="time"
              value={form.startTime}
              onChange={(event) => setForm((current) => ({ ...current, startTime: event.target.value }))}
              required
            />
          </label>

          <button type="submit" className="primary-button">
            Salvar
          </button>
        </form>
        {message ? <p className={message.includes('sucesso') ? 'success-text' : 'error-text'}>{message}</p> : null}
      </section>

      <section className="card">
        <Table
          columns={['Data', 'Horario', 'Cliente', 'Servico', 'Profissional', 'Status', 'Acao']}
          rows={data.map((item) => [
            item.date,
            `${item.start_time} - ${item.end_time}`,
            item.client_name,
            item.service_name,
            item.professional_name,
            item.status,
            <button key={item.id} type="button" className="danger-button" onClick={() => onCancel(item.id)}>
              Cancelar
            </button>,
          ])}
          emptyText="Nenhum agendamento."
        />
      </section>
    </div>
  );
}

function SubscriptionPage({ subscription }) {
  return (
    <section className="card">
      <h3>Assinatura</h3>
      <div className="details-grid">
        <div>
          <span>Status</span>
          <strong>{subscription?.status || 'PENDING'}</strong>
        </div>
        <div>
          <span>Valor</span>
          <strong>{formatCurrency(subscription?.amount || 65)}</strong>
        </div>
        <div>
          <span>Proximo pagamento</span>
          <strong>{subscription?.next_payment_date || '-'}</strong>
        </div>
        <div>
          <span>Checkout</span>
          <strong>{subscription?.checkout_url ? 'Disponivel' : 'Ainda nao gerado'}</strong>
        </div>
      </div>
    </section>
  );
}

function WhatsappPage({ status: initialStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (!status || !['CONNECTING', 'QR_READY'].includes(status.status)) {
      return undefined;
    }

    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts += 1;
      try {
        const nextStatus = await apiRequest('/whatsapp/status');
        setStatus(nextStatus);
        if (nextStatus.status === 'CONNECTED' || attempts >= 60) {
          window.clearInterval(timer);
        }
      } catch (error) {
        setMessage(error.message);
        window.clearInterval(timer);
      }
    }, 3000);

    return () => window.clearInterval(timer);
  }, [status?.status]);

  async function startWhatsapp() {
    setLoading(true);
    setMessage('Solicitando QR Code à Evolution API...');

    try {
      const nextStatus = await apiRequest('/whatsapp/start', { method: 'POST' });
      setStatus(nextStatus);
      setMessage(nextStatus.qr_code ? 'Escaneie o QR Code com o WhatsApp da barbearia.' : 'WhatsApp conectado.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  const statusLabel = {
    DISCONNECTED: 'Desconectado',
    CONNECTING: 'Conectando',
    QR_READY: 'QR Code pronto',
    CONNECTED: 'WhatsApp conectado',
  }[status?.status] || 'Desconectado';

  return (
    <section className="card">
      <h3>WhatsApp</h3>
      <div className="details-grid">
        <div>
          <span>Status</span>
          <strong>{statusLabel}</strong>
        </div>
        <div>
          <span>Instancia</span>
          <strong>{status?.instance_name || '-'}</strong>
        </div>
        <div>
          <span>Telefone conectado</span>
          <strong>{status?.connected_phone || '-'}</strong>
        </div>
      </div>

      <button type="button" className="primary-button" onClick={startWhatsapp} disabled={loading || status?.status === 'CONNECTED'}>
        {loading ? 'Gerando QR Code...' : status?.status === 'CONNECTED' ? 'WhatsApp conectado' : 'Gerar QR Code'}
      </button>

      {status?.qr_code ? (
        <div className="qr-block">
          <img src={status.qr_code} alt="QR Code do WhatsApp" />
        </div>
      ) : null}
      <p className={status?.error ? 'error-text' : 'muted'}>{status?.error || message || (status?.status === 'CONNECTED' ? 'WhatsApp conectado com sucesso.' : 'Clique em Gerar QR Code para iniciar.')}</p>
    </section>
  );
}

function SettingsPage({ user }) {
  return (
    <section className="card">
      <h3>Configuracoes</h3>
      <div className="details-grid">
        <div>
          <span>Salao</span>
          <strong>{user?.salon?.name || '-'}</strong>
        </div>
        <div>
          <span>Usuario</span>
          <strong>{user?.name || '-'}</strong>
        </div>
        <div>
          <span>Email</span>
          <strong>{user?.email || '-'}</strong>
        </div>
        <div>
          <span>Papel</span>
          <strong>{user?.role || '-'}</strong>
        </div>
      </div>
    </section>
  );
}

function Table({ columns, rows, emptyText }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length}>{emptyText}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function App() {
  const { route, navigate } = useRoute();
  const [authMode, setAuthMode] = useState(route === '/register' ? 'register' : 'login');
  const [session, setSession] = useState(null);
  const [data, setData] = useState({
    dashboard: null,
    services: [],
    professionals: [],
    clients: [],
    blockedTimes: [],
    appointments: [],
    subscription: null,
    whatsapp: null,
  });
  const [loading, setLoading] = useState(false);
  const [appError, setAppError] = useState('');

  async function loadWorkspace() {
    setLoading(true);
    setAppError('');

    try {
      const [me, dashboard, services, professionals, clients, blockedTimes, appointments, subscription, whatsapp] = await Promise.all([
        apiRequest('/auth/me'),
        apiRequest('/dashboard'),
        apiRequest('/services'),
        apiRequest('/professionals'),
        apiRequest('/clients'),
        apiRequest('/blocked-times'),
        apiRequest('/appointments'),
        apiRequest('/subscriptions/current'),
        apiRequest('/whatsapp/status'),
      ]);

      setSession({
        name: me.user.name,
        email: me.user.email,
        role: me.user.role,
        salon: me.salon || { name: me.user.salon_id },
      });
      setData({
        dashboard,
        services,
        professionals,
        clients,
        blockedTimes,
        appointments,
        subscription,
        whatsapp,
      });
    } catch (error) {
      clearToken();
      setAppError(error.message);
      navigate('/login');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (route === '/login' || route === '/register') {
      setAuthMode(route === '/register' ? 'register' : 'login');
      return;
    }

    if (!routes.some((item) => item.path === route)) {
      navigate('/dashboard');
      return;
    }

    if (!getToken()) {
      navigate('/login');
      return;
    }

    loadWorkspace();
  }, [route]);

  function handleAuthSuccess(payload) {
    setSession({
      name: payload.user.name,
      email: payload.user.email,
      role: payload.user.role,
      salon: payload.salon || { name: payload.user.salon_id },
    });
    navigate('/dashboard');
  }

  async function createResource(path, body) {
    await apiRequest(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await loadWorkspace();
  }

  async function deleteResource(path) {
    await apiRequest(path, { method: 'DELETE' });
    await loadWorkspace();
  }

  if (route === '/login' || route === '/register') {
    return (
      <AuthPage
        mode={authMode}
        onSuccess={handleAuthSuccess}
        onSwitch={() => navigate(authMode === 'register' ? '/login' : '/register')}
      />
    );
  }

  return (
    <PageShell
      user={session}
      route={route}
      navigate={navigate}
      onLogout={() => {
        clearToken();
        setSession(null);
        navigate('/login');
      }}
    >
      {loading ? <section className="card">Carregando...</section> : null}
      {appError ? <section className="card error-text">{appError}</section> : null}

      {!loading && route === '/dashboard' ? <DashboardPage data={data.dashboard} /> : null}

      {!loading && route === '/servicos' ? (
        <CrudPage
          title="Servicos"
          columns={[
            { key: 'name' },
            { key: 'price' },
            { key: 'duration_minutes' },
          ]}
          items={data.services}
          formFields={[
            { name: 'name', label: 'Nome', required: true },
            { name: 'description', label: 'Descricao' },
            { name: 'price', label: 'Preco', type: 'number', required: true },
            { name: 'durationMinutes', label: 'Duracao (min)', type: 'number', required: true },
          ]}
          onCreate={(body) => createResource('/services', body)}
          onDelete={(id) => deleteResource(`/services/${id}`)}
          loading={loading}
        />
      ) : null}

      {!loading && route === '/profissionais' ? (
        <CrudPage
          title="Profissionais"
          columns={[
            { key: 'name' },
            { key: 'phone' },
            { key: 'email' },
          ]}
          items={data.professionals}
          formFields={[
            { name: 'name', label: 'Nome', required: true },
            { name: 'phone', label: 'Telefone' },
            { name: 'email', label: 'Email', type: 'email' },
          ]}
          onCreate={(body) => createResource('/professionals', body)}
          onDelete={(id) => deleteResource(`/professionals/${id}`)}
          loading={loading}
        />
      ) : null}

      {!loading && route === '/clientes' ? (
        <CrudPage
          title="Clientes"
          columns={[
            { key: 'name' },
            { key: 'phone' },
            { key: 'email' },
          ]}
          items={data.clients}
          formFields={[
            { name: 'name', label: 'Nome', required: true },
            { name: 'phone', label: 'Telefone' },
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'notes', label: 'Observacoes' },
          ]}
          onCreate={(body) => createResource('/clients', body)}
          onDelete={(id) => deleteResource(`/clients/${id}`)}
          loading={loading}
        />
      ) : null}

      {!loading && route === '/bloqueios' ? (
        <CrudPage
          title="Bloqueios"
          columns={[
            { key: 'date' },
            { key: 'start_time' },
            { key: 'end_time' },
          ]}
          items={data.blockedTimes}
          formFields={[
            { name: 'date', label: 'Data', type: 'date', required: true },
            { name: 'startTime', label: 'Inicio', type: 'time', required: true },
            { name: 'endTime', label: 'Fim', type: 'time', required: true },
            { name: 'reason', label: 'Motivo' },
          ]}
          onCreate={(body) => createResource('/blocked-times', body)}
          onDelete={(id) => deleteResource(`/blocked-times/${id}`)}
          loading={loading}
        />
      ) : null}

      {!loading && route === '/agendamentos' ? (
        <AppointmentsPage
          data={data.appointments}
          related={{
            clients: data.clients,
            professionals: data.professionals,
            services: data.services,
          }}
          onCreate={(body) => createResource('/appointments', body)}
          onCancel={(id) => deleteResource(`/appointments/${id}`)}
        />
      ) : null}

      {!loading && route === '/assinatura' ? <SubscriptionPage subscription={data.subscription} /> : null}
      {!loading && route === '/whatsapp' ? <WhatsappPage status={data.whatsapp} /> : null}
      {!loading && route === '/configuracoes' ? <SettingsPage user={session} /> : null}

      {!loading && route === '/horarios' ? (
        <section className="card">Os horarios disponiveis sao calculados pelo endpoint de disponibilidade dos agendamentos.</section>
      ) : null}

      {!loading && route === '/financeiro' ? (
        <section className="card">O resumo financeiro atual esta no dashboard e sera expandido com o fluxo oficial de pagamentos.</section>
      ) : null}
    </PageShell>
  );
}

export default App;
