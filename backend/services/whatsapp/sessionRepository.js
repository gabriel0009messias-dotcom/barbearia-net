const db = require('../../database');
module.exports = { transaction: callback => db.transaction(callback) };
