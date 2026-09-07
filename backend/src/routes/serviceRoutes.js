const express = require('express');
const { requireAuth, requireRoles } = require('../middlewares/authMiddleware');
const serviceService = require('../services/serviceService');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await serviceService.list(req.user.salon_id));
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAuth, requireRoles('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    res.status(201).json(await serviceService.create(req.user.salon_id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.put('/:id', requireAuth, requireRoles('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    res.json(await serviceService.update(req.user.salon_id, req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireAuth, requireRoles('OWNER', 'ADMIN'), async (req, res, next) => {
  try {
    await serviceService.remove(req.user.salon_id, req.params.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
