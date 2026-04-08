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

function encontrarNavegadorLocal() {
  if (process.platform !== 'win32') {
    const caminhoConfigurado = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;

    if (caminhoConfigurado && fs.existsSync(caminhoConfigurado)) {
      return caminhoConfigurado;
    }

    try {
      // Quando o Chrome do Puppeteer foi instalado no build, este helper encontra o binario real.
      // Isso evita depender de configurar manualmente o caminho no Render.
      // eslint-disable-next-line global-require
      const puppeteer = require('puppeteer');
      const executablePath =
        typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : null;

      return executablePath || null;
    } catch (error) {
      return null;
    }
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
    browserArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    puppeteerOptions: {
      userDataDir,
      ...(executablePath ? { executablePath } : {}),
    },
  };
}

module.exports = {
  criarOpcoesWppconnect,
};
