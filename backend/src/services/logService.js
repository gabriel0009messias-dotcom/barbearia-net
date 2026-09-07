const { LOG_LEVELS } = require('../config/constants');
const logRepository = require('../repositories/logRepository');

async function write(level, source, message, context = {}) {
  const prefix = `[${source}] ${message}`;

  if (level === LOG_LEVELS.ERROR) {
    console.error(prefix, context);
  } else if (level === LOG_LEVELS.WARN) {
    console.warn(prefix, context);
  } else {
    console.log(prefix, context);
  }

  try {
    await logRepository.createLog({ level, source, message, context });
  } catch (error) {
    console.error('[logService] Falha ao salvar log', error.message);
  }
}

module.exports = {
  info: (source, message, context) => write(LOG_LEVELS.INFO, source, message, context),
  warn: (source, message, context) => write(LOG_LEVELS.WARN, source, message, context),
  error: (source, message, context) => write(LOG_LEVELS.ERROR, source, message, context),
};
