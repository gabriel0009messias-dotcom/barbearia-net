const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const whatsappService = require('../services/whatsappService');

const router = express.Router();

router.get('/status', requireAuth, async (req, res, next) => {
  try {
    res.json(await whatsappService.getStatus(req.user.salon_id));
  } catch (error) {
    next(error);
  }
});

router.post('/start', requireAuth, async (req, res, next) => {
  try {
    res.json(await whatsappService.start(req.user.salon_id));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
