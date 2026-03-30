import React, { useState, useEffect } from 'react';
import Agendamentos from './components/Agendamentos';
import Faturamento from './components/Faturamento';
import Bloqueios from './components/Bloqueios';

function App() {
  const [tela, setTela] = useState('agendamentos');

  return (
    <div style={{ fontFamily: 'sans-serif', maxWidth: 600, margin: '0 auto', padding: 20 }}>
      <h1>Painel do Barbeiro</h1>
      <nav style={{ marginBottom: 20 }}>
        <button onClick={() => setTela('agendamentos')}>Agendamentos</button>
        <button onClick={() => setTela('faturamento')}>Faturamento</button>
        <button onClick={() => setTela('bloqueios')}>Bloquear Horário</button>
      </nav>
      {tela === 'agendamentos' && <Agendamentos />}
      {tela === 'faturamento' && <Faturamento />}
      {tela === 'bloqueios' && <Bloqueios />}
    </div>
  );
}

export default App;
