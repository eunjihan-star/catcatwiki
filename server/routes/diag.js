'use strict';

const express = require('express');
const { handleDiag } = require('../diagHandler');

const router = express.Router();

router.get('/diag', async (req, res) => {
  try {
    res.json(await handleDiag());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
