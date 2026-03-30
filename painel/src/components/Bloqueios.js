import React, { useState } from 'react';

function Bloqueios() {
  const [data, setData] = useState('');
  const [hora, setHora] = useState('');
  const [msg, setMsg] = useState('');

  const bloquear = () => {
    fetch('http://localhost:3001/api/bloqueios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, hora })
    })
      .then(res => res.json())
      .then(() => setMsg('Horário bloqueado!'));
  };

  return (
    <div>
      <h2>Bloquear Horário</h2>
      <input type="date" value={data} onChange={e => setData(e.target.value)} />
      <input type="time" value={hora} onChange={e => setHora(e.target.value)} />
      <button onClick={bloquear}>Bloquear</button>
      <div>{msg}</div>
    </div>
  );
}

export default Bloqueios;
