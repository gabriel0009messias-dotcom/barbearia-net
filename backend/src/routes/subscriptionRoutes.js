const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const subscriptionRepository = require('../repositories/saasSubscriptionRepository');

const router = express.Router();

router.get('/current', requireAuth, async (req, res, next) => {
  try {
    const subscription = await subscriptionRepository.findBySalonId(req.user.salon_id);
    res.json(subscription);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
