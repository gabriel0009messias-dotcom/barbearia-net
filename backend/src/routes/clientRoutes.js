const express = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const clientService = require('../services/clientService');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await clientService.list(req.user.salon_id));
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    res.status(201).json(await clientService.create(req.user.salon_id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    res.json(await clientService.update(req.user.salon_id, req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await clientService.remove(req.user.salon_id, req.params.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
