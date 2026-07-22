'use strict';

const express = require('express');
const { handleSearch } = require('../searchHandler');

const router = express.Router();

router.post('/search', async (req, res) => {
  try {
    const result = await handleSearch((req.body || {}).address);
    res.json(result);
  } catch (err) {
    const status = err.status || (err.code === 'MISSING_API_KEY' ? 500 : 502);
    const body = { error: err.message };
    if (err.parsed) body.parsed = err.parsed;
    res.status(status).json(body);
  }
});

module.exports = router;
