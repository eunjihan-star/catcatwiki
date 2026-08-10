'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * 통합검색에서 0건이 나온 검색어를 모아두는 저장소. 태그/제목을 감으로 다시 짓는 대신
 * 실무자가 실제로 뭐라고 검색했는지 데이터로 확인하기 위한 용도 — wikiDataStore.js와
 * 동일한 KV/로컬파일 이중 구조를 그대로 따른다 (Vercel 서버리스는 파일쓰기가 요청이
 * 끝나면 사라지므로 배포 환경에서는 반드시 KV가 필요하다).
 */

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const STORE_KEY = 'search-log-v1';
const MAX_ENTRIES = 300; // 무한정 쌓이지 않도록 상한 - 넘으면 가장 오래전에 검색된 것부터 버림

const LOCAL_FILE = path.join(__dirname, '..', 'data', 'search-log.json');

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

async function getSearchLog() {
  const data = useKv ? await kvGet() : fileGet();
  return data || { entries: [] };
}

async function saveSearchLog(value) {
  return useKv ? kvSet(value) : fileSet(value);
}

module.exports = { getSearchLog, saveSearchLog, MAX_ENTRIES };
