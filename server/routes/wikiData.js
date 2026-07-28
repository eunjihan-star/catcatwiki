'use strict';

const express = require('express');
const { handleGetWikiData, handleSaveWikiData } = require('../wikiDataHandler');

const router = express.Router();

router.get('/wiki-data', async (req, res) => {
  try {
    res.json(await handleGetWikiData());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/wiki-data', async (req, res) => {
  try {
    res.json(await handleSaveWikiData(req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
