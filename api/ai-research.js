'use strict';

// Vercel Node.js 서버리스 함수: POST /api/ai-research
// "AI로 조사하기" 버튼 클릭 시에만 호출된다 (검색할 때마다 자동 호출 X - 비용 때문).
require('dotenv').config();

const { handleAiResearch } = require('../server/aiResearchHandler');

module.exports = async (req, res) => {
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
    const result = await handleAiResearch(req.body || {});
    res.status(200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};
