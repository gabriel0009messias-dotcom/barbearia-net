const fs = require('fs');
const path = require('path');

function aplicarLinhaEnv(linha = '') {
  const conteudo = String(linha).trim();

  if (!conteudo || conteudo.startsWith('#')) {
    return;
  }

  const separador = conteudo.indexOf('=');

  if (separador <= 0) {
    return;
  }

  const chave = conteudo.slice(0, separador).trim();
  let valor = conteudo.slice(separador + 1).trim();

  if (
    (valor.startsWith('"') && valor.endsWith('"')) ||
    (valor.startsWith("'") && valor.endsWith("'"))
  ) {
    valor = valor.slice(1, -1);
  }

  if (!(chave in process.env)) {
    process.env[chave] = valor;
  }
}

function carregarEnv(caminhoArquivo = path.join(__dirname, '.env')) {
  if (!fs.existsSync(caminhoArquivo)) {
    return;
  }

  const conteudo = fs.readFileSync(caminhoArquivo, 'utf8');
  conteudo.split(/\r?\n/).forEach(aplicarLinhaEnv);
}

carregarEnv();

module.exports = {
  carregarEnv,
};
