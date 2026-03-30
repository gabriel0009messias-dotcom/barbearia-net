const fs = require('fs');
const path = require('path');

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
    return process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;
  }

  return listarCaminhosChromeWindows().find((item) => fs.existsSync(item)) || null;
}

function criarOpcoesWppconnect({ session, headless, catchQR, statusFind }) {
  const executablePath = encontrarNavegadorLocal();
  const userDataDir = path.join(__dirname, 'tokens', session);

  return {
    session,
    headless,
    autoClose: 0,
    catchQR,
    statusFind,
    logQR: false,
    folderNameToken: path.join(__dirname, 'tokens'),
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
