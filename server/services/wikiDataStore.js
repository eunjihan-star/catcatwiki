'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * 관리자모드에서 추가/수정/삭제한 위키 데이터(업무 매뉴얼·용어사전·주간회의·관리자 비밀번호
 * 해시)를 실제로 저장하는 곳. 이 파일이 생기기 전에는 브라우저 메모리에만 있다가 "내보내기"
 * 로 받은 HTML 파일을 사람이 직접 배포 파일에 덮어써야만 남는 구조였다 — 그 단계를 잊으면
 * (또는 export 없이 새로고침하면) 편집 내용이 통째로 사라지는 문제가 있었다.
 *
 * ⚠️ Vercel 서버리스 함수는 파일시스템 쓰기가 그 요청이 끝나면 사라진다(배포마다도 초기화).
 * 그래서 배포 환경에서는 반드시 Vercel KV(Upstash Redis 호환 REST API)를 써야 실제로
 * 영속된다. 로컬 개발(npm start)에서는 KV 환경변수가 없을 때 로컬 JSON 파일로 대체해서
 * 별도 설정 없이 바로 동작하게 한다.
 */

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const STORE_KEY = 'wiki-data-v1';

const LOCAL_FILE = path.join(__dirname, '..', 'data', 'wiki-data.json');

async function kvGet() {
  const { data } = await axios.post(KV_URL, ['GET', STORE_KEY], {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    timeout: 8000,
  });
  return data?.result ? JSON.parse(data.result) : null;
}

async function kvSet(value) {
  await axios.post(KV_URL, ['SET', STORE_KEY, JSON.stringify(value)], {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    timeout: 8000,
  });
}

function fileGet() {
  if (!fs.existsSync(LOCAL_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
  } catch (err) {
    return null;
  }
}

function fileSet(value) {
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(value, null, 2), 'utf8');
}

const useKv = Boolean(KV_URL && KV_TOKEN);

// 저장된 게 없으면(최초 상태) null을 반환한다 - 이 경우 프론트엔드는 HTML에 내장된
// 기본 데이터(seed)를 그대로 쓴다. 관리자가 뭐라도 한 번 저장하는 순간부터 여기 값이
// "진짜" 데이터가 된다.
async function getWikiData() {
  return useKv ? kvGet() : fileGet();
}

async function saveWikiData(value) {
  return useKv ? kvSet(value) : fileSet(value);
}

module.exports = { getWikiData, saveWikiData, useKv };
