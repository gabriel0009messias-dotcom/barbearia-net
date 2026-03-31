const express = require('express');
const path = require('path');

const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3001;
const barberPanelPath = path.join(__dirname, '..', 'painel');
const adminPanelPath = path.join(__dirname, '..', 'painel-admin');
const assetVersion = process.env.RENDER_GIT_COMMIT || process.env.APP_VERSION || '20260330';

function definirCabecalhoSemCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', routes);
app.use(
  express.static(barberPanelPath, {
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/i.test(filePath)) {
        definirCabecalhoSemCache(res);
      }
    },
  })
);

app.use((req, res, next) => {
  res.locals.assetVersion = assetVersion;
  next();
});

app.get('/', (req, res) => {
  definirCabecalhoSemCache(res);
  res.sendFile(path.join(barberPanelPath, 'index.html'));
});

app.get('/api', (req, res) => {
  res.json({ message: 'API Barbearia rodando!' });
});

app.get('/cadastro.html', (req, res) => {
  definirCabecalhoSemCache(res);
  res.sendFile(path.join(barberPanelPath, 'cadastro.html'));
});

app.get('/barbeiro.html', (req, res) => {
  definirCabecalhoSemCache(res);
  res.sendFile(path.join(barberPanelPath, 'barbeiro.html'));
});

app.get('/controle-interno', (req, res) => {
  definirCabecalhoSemCache(res);
  res.sendFile(path.join(adminPanelPath, 'login.html'));
});

app.get('/controle-interno/painel', (req, res) => {
  definirCabecalhoSemCache(res);
  res.sendFile(path.join(adminPanelPath, 'dashboard.html'));
});

app.get('/controle-interno/assets/login.js', (req, res) => {
  definirCabecalhoSemCache(res);
  res.sendFile(path.join(adminPanelPath, 'login.js'));
});

app.get('/controle-interno/assets/admin.js', (req, res) => {
  definirCabecalhoSemCache(res);
  res.sendFile(path.join(adminPanelPath, 'admin.js'));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
