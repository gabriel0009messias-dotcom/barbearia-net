import React, { useEffect, useState } from 'react';

function Faturamento() {
  const [dia, setDia] = useState(0);
  const [mes, setMes] = useState(0);
  const [ano, setAno] = useState(0);

  useEffect(() => {
    fetch('http://localhost:3001/api/faturamento?periodo=dia')
      .then(res => res.json()).then(data => setDia(data.total));
    fetch('http://localhost:3001/api/faturamento?periodo=mes')
      .then(res => res.json()).then(data => setMes(data.total));
    fetch('http://localhost:3001/api/faturamento?periodo=ano')
      .then(res => res.json()).then(data => setAno(data.total));
  }, []);

  return (
    <div>
      <h2>Faturamento</h2>
      <ul>
        <li>Hoje: <b>R$ {dia.toFixed(2)}</b></li>
        <li>Mês: <b>R$ {mes.toFixed(2)}</b></li>
        <li>Ano: <b>R$ {ano.toFixed(2)}</b></li>
      </ul>
    </div>
  );
}

export default Faturamento;
