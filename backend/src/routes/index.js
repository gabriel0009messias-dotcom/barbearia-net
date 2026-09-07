const express = require('express');

const authRoutes = require('./authRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const serviceRoutes = require('./serviceRoutes');
const professionalRoutes = require('./professionalRoutes');
const clientRoutes = require('./clientRoutes');
const blockedTimeRoutes = require('./blockedTimeRoutes');
const appointmentRoutes = require('./appointmentRoutes');
const subscriptionRoutes = require('./subscriptionRoutes');
const whatsappRoutes = require('./whatsappRoutes');
const paymentRoutes = require('./paymentRoutes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/services', serviceRoutes);
router.use('/professionals', professionalRoutes);
router.use('/clients', clientRoutes);
router.use('/blocked-times', blockedTimeRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/subscriptions', subscriptionRoutes);
router.use('/whatsapp', whatsappRoutes);
router.use('/payments', paymentRoutes);

module.exports = router;
