'use strict';

const express = require('express');
const { handleSearch } = require('../searchHandler');

const router = express.Router();

router.post('/search', async (req, res) => {
  try {
    const body0 = req.body || {};
    const result = await handleSearch(body0.address, body0.buildingTypes);
    res.json(result);
  } catch (err) {
    const status = err.status || (err.code === 'MISSING_API_KEY' ? 500 : 502);
    const body = { error: err.message };
    if (err.parsed) body.parsed = err.parsed;
    res.status(status).json(body);
  }
});

module.exports = router;
