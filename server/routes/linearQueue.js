'use strict';

const express = require('express');
const {
  handleGetQueue,
  handleSubmitDrafts,
  handleReviewDraft,
} = require('../linearQueueHandler');

const router = express.Router();

router.get('/linear-queue', async (req, res) => {
  try {
    res.json(await handleGetQueue());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/linear-queue', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.action === 'review') {
      res.json(await handleReviewDraft(body));
    } else {
      res.json(await handleSubmitDrafts(body));
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
