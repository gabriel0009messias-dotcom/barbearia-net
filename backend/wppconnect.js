const qrcodeTerminal = require('qrcode-terminal');
const wppconnect = require('@wppconnect-team/wppconnect');

const { attachBotHandlers } = require('./botFlow');

async function iniciarBot() {
  const client = await wppconnect.create({
    session: 'barbearia-bot',
    headless: false,
    autoClose: 0,
    catchQR: (base64Qrimg, asciiQR) => {
      console.log('\nQR Code do WhatsApp gerado. Escaneie com o celular.\n');

      if (asciiQR) {
        console.log(asciiQR);
        return;
      }

      const base64Data = base64Qrimg.split(',')[1];
      qrcodeTerminal.generate(base64Data, { small: true });
    },
    statusFind: (statusSession) => {
      console.log('Status do WhatsApp:', statusSession);
    },
    logQR: false,
    browserArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  console.log('Bot do WhatsApp iniciado. Aguarde o QR Code ou a abertura do navegador.');
  attachBotHandlers(client, { sessionKey: 'barbearia-bot' });
}

iniciarBot().catch((error) => {
  console.error('Erro ao iniciar WPPConnect:', error);
});
