const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const dashboardService = require('../services/saasDashboardService');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const payload = await dashboardService.getDashboard(req.user.salon_id);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
