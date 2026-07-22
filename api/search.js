'use strict';

// Vercel Node.js 서버리스 함수: POST /api/search
// server/searchHandler.js 의 순수 로직을 그대로 재사용한다 (Express 라우트와 동일 코드).
require('dotenv').config();

const { handleSearch } = require('../server/searchHandler');

module.exports = async (req, res) => {
  // 프론트엔드와 다른 도메인에서 호출되는 경우(예: 위키를 별도 정적 호스팅에 두는 경우)를
  // 대비해 CORS를 허용한다. 같은 Vercel 프로젝트에서 서빙되는 경우에는 어차피 same-origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const address = (req.body || {}).address;
    const result = await handleSearch(address);
    res.status(200).json(result);
  } catch (err) {
    const status = err.status || (err.code === 'MISSING_API_KEY' ? 500 : 502);
    const body = { error: err.message };
    if (err.parsed) body.parsed = err.parsed;
    res.status(status).json(body);
  }
};
