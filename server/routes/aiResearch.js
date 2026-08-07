'use strict';

const express = require('express');
const { handleAiResearch } = require('../aiResearchHandler');

const router = express.Router();

router.post('/ai-research', async (req, res) => {
  try {
    const result = await handleAiResearch(req.body);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
