const express = require('express');
const authService = require('../services/saasAuthService');
const { requireAuth } = require('../middlewares/authMiddleware');
const salonRepository = require('../repositories/salonRepository');

const router = express.Router();

router.post('/register', async (req, res, next) => {
  try {
    const result = await authService.register(req.body || {});
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const result = await authService.login(req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const salon = await salonRepository.findById(req.user.salon_id);

    res.json({
      user: {
        id: req.user.id,
        salon_id: req.user.salon_id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
      },
      salon,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
