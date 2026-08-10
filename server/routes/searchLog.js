'use strict';

const express = require('express');
const {
  handleGetSearchLog,
  handleRecordZeroResult,
  handleClearSearchLog,
} = require('../searchLogHandler');

const router = express.Router();

router.get('/search-log', async (req, res) => {
  try {
    res.json(await handleGetSearchLog());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/search-log', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.action === 'clear') {
      res.json(await handleClearSearchLog(body));
    } else {
      res.json(await handleRecordZeroResult(body));
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
