import React, { useEffect, useState } from 'react';

function Agendamentos() {
  const [agendamentos, setAgendamentos] = useState([]);

  useEffect(() => {
    fetch('http://localhost:3001/api/agendamentos')
      .then(res => res.json())
      .then(setAgendamentos);
  }, []);

  return (
    <div>
      <h2>Agendamentos</h2>
      <table border="1" cellPadding={5} style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>Cliente</th>
            <th>Serviço</th>
            <th>Data</th>
            <th>Hora</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {agendamentos.map(a => (
            <tr key={a.id}>
              <td>{a.cliente_id}</td>
              <td>{a.servico_id}</td>
              <td>{a.data}</td>
              <td>{a.hora}</td>
              <td>{a.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default Agendamentos;
