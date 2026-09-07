const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const appointmentService = require('../services/appointmentService');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await appointmentService.list(req.user.salon_id, req.query || {}));
  } catch (error) {
    next(error);
  }
});

router.get('/availability', requireAuth, async (req, res, next) => {
  try {
    res.json(await appointmentService.getAvailability(req.user.salon_id, req.query || {}));
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    res.status(201).json(await appointmentService.create(req.user.salon_id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    res.json(await appointmentService.update(req.user.salon_id, req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await appointmentService.cancel(req.user.salon_id, req.params.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
