'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const searchRouter = require('./routes/search');
const wikiDataRouter = require('./routes/wikiData');
const searchLogRouter = require('./routes/searchLog');
const linearQueueRouter = require('./routes/linearQueue');
const diagRouter = require('./routes/diag');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
// 기본 100kb 제한으로는 위키 전체 데이터(업무 매뉴얼+용어사전+회의록)를 통째로 저장하는
// /api/wiki-data 요청이 걸려서 조용히 실패한다 - 넉넉하게 올려둔다.
app.use(express.json({ limit: '10mb' }));

app.use('/api', searchRouter);
app.use('/api', wikiDataRouter);
app.use('/api', searchLogRouter);
app.use('/api', linearQueueRouter);
app.use('/api', diagRouter);

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
