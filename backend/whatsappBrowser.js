const fs = require('fs');
const path = require('path');

function garantirDiretorio(caminho) {
  if (!fs.existsSync(caminho)) {
    fs.mkdirSync(caminho, { recursive: true });
  }
}

function listarCaminhosChromeWindows() {
  return [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env['PROGRAMFILES']
      ? path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env['PROGRAMFILES(X86)']
      ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env['PROGRAMFILES']
      ? path.join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : null,
    process.env['PROGRAMFILES(X86)']
      ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : null,
  ].filter(Boolean);
}

function obterChromeDoPuppeteer() {
  try {
    // eslint-disable-next-line global-require
    const puppeteer = require('puppeteer');
    const executablePath = typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : null;

    if (executablePath && fs.existsSync(executablePath)) {
      return executablePath;
    }
  } catch (error) {
    // Continua para os proximos fallbacks.
  }

  return null;
}

function encontrarChromeEmCache(caminhoBase) {
  if (!caminhoBase || !fs.existsSync(caminhoBase)) {
    return null;
  }

  const pilha = [caminhoBase];

  while (pilha.length) {
    const atual = pilha.pop();
    const stat = fs.statSync(atual);

    if (stat.isFile()) {
      const normalizado = atual.replace(/\\/g, '/');
      if (normalizado.endsWith('/chrome') || normalizado.endsWith('/chrome.exe')) {
        return atual;
      }
      continue;
    }

    const filhos = fs.readdirSync(atual).map((item) => path.join(atual, item));
    for (const filho of filhos) {
      pilha.push(filho);
    }
  }

  return null;
}

function encontrarNavegadorLocal() {
  const caminhoConfigurado = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;

  if (caminhoConfigurado && fs.existsSync(caminhoConfigurado)) {
    return caminhoConfigurado;
  }

  const chromeDoPuppeteer = obterChromeDoPuppeteer();

  if (chromeDoPuppeteer) {
    return chromeDoPuppeteer;
  }

  if (process.platform !== 'win32') {
    const cachesConhecidos = [
      process.env.PUPPETEER_CACHE_DIR,
      path.join(__dirname, 'puppeteer-cache'),
      path.join(__dirname, '..', 'puppeteer-cache'),
      path.join(__dirname, '.cache', 'puppeteer'),
      path.join(__dirname, '..', '.cache', 'puppeteer'),
      '/opt/render/project/src/backend/puppeteer-cache',
      '/opt/render/project/src/backend/.cache/puppeteer',
      '/opt/render/.cache/puppeteer',
    ];

    for (const cacheDir of cachesConhecidos) {
      const chrome = encontrarChromeEmCache(cacheDir);
      if (chrome) {
        return chrome;
      }
    }

    return null;
  }

  return listarCaminhosChromeWindows().find((item) => fs.existsSync(item)) || null;
}

function criarOpcoesWppconnect({ session, headless, catchQR, statusFind }) {
  const executablePath = encontrarNavegadorLocal();
  const tokenDir = path.join(__dirname, 'tokens');
  const browserProfilesDir = path.join(__dirname, 'browser-data');
  const userDataDir = path.join(browserProfilesDir, `${session}-${process.pid}`);

  garantirDiretorio(tokenDir);
  garantirDiretorio(browserProfilesDir);
  garantirDiretorio(userDataDir);

  return {
    session,
    headless,
    autoClose: 0,
    catchQR,
    statusFind,
    logQR: false,
    folderNameToken: tokenDir,
    browserArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    puppeteerOptions: {
      userDataDir,
      ...(executablePath ? { executablePath } : {}),
    },
  };
}

module.exports = {
  criarOpcoesWppconnect,
};
