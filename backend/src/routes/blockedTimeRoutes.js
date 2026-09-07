const express = require('express');
const { requireAuth, requireRoles } = require('../middlewares/authMiddleware');
const blockedTimeService = require('../services/blockedTimeService');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await blockedTimeService.list(req.user.salon_id, req.query || {}));
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAuth, requireRoles('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    res.status(201).json(await blockedTimeService.create(req.user.salon_id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireAuth, requireRoles('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    await blockedTimeService.remove(req.user.salon_id, req.params.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
