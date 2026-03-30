const express = require('express');
const path = require('path');

const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3001;
const barberPanelPath = path.join(__dirname, '..', 'painel');
const adminPanelPath = path.join(__dirname, '..', 'painel-admin');

app.use(express.json());
app.use('/api', routes);
app.use(express.static(barberPanelPath));

app.get('/api', (req, res) => {
  res.json({ message: 'API Barbearia rodando!' });
});

app.get('/controle-interno', (req, res) => {
  res.sendFile(path.join(adminPanelPath, 'login.html'));
});

app.get('/controle-interno/painel', (req, res) => {
  res.sendFile(path.join(adminPanelPath, 'dashboard.html'));
});

app.get('/controle-interno/assets/login.js', (req, res) => {
  res.sendFile(path.join(adminPanelPath, 'login.js'));
});

app.get('/controle-interno/assets/admin.js', (req, res) => {
  res.sendFile(path.join(adminPanelPath, 'admin.js'));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
