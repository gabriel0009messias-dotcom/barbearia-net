const express = require('express');
const paymentService = require('../services/paymentService');

const router = express.Router();

router.post('/webhook', async (req, res, next) => {
  try {
    await paymentService.processWebhook(req);
    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
