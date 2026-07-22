'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const searchRouter = require('./routes/search');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.use('/api', searchRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

// 정의되지 않은 API 경로
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// 공통 에러 핸들러
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

app.listen(PORT, () => {
  console.log(`부동산 정보 위키 서버 실행 중: http://localhost:${PORT}`);
});
