'use strict';

// Vercel Node.js 서버리스 함수: GET/POST /api/wiki-data
// server/wikiDataHandler.js 의 순수 로직을 그대로 재사용한다 (Express 라우트와 동일 코드).
require('dotenv').config();

const { handleGetWikiData, handleSaveWikiData } = require('../server/wikiDataHandler');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'GET') {
      res.status(200).json(await handleGetWikiData());
      return;
    }
    if (req.method === 'POST') {
      res.status(200).json(await handleSaveWikiData(req.body || {}));
      return;
    }
    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
