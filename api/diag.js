'use strict';

// 임시 진단용 - Vercel 배포 환경에서 KV 연결이 실제로 되는지 브라우저에서 바로 확인.
// 시크릿 값은 응답에 절대 포함하지 않는다(존재 여부만).
require('dotenv').config();

const { handleDiag } = require('../server/diagHandler');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    res.status(200).json(await handleDiag());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
