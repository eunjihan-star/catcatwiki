'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Linear(TR-543 하위 이슈)에서 매일 자동으로 긁어온 초안을 쌓아두는 "검토 대기열".
 * wikiDataStore.js와 동일한 KV/로컬파일 이중 구조를 그대로 따른다. 실제 MANUAL
 * 데이터(wiki-data-v1)와는 완전히 분리된 저장소라, 관리자가 승인하기 전까지는
 * 위키 화면에 절대 노출되지 않는다.
 */

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const STORE_KEY = 'linear-queue-v1';
const MAX_ITEMS = 500; // 무한정 쌓이지 않도록 상한 - 넘으면 가장 오래전에 들어온 pending부터 버림

const LOCAL_FILE = path.join(__dirname, '..', 'data', 'linear-queue.json');

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

async function getQueue() {
  const data = useKv ? await kvGet() : fileGet();
  return data || { items: [] };
}

async function saveQueue(value) {
  return useKv ? kvSet(value) : fileSet(value);
}

module.exports = { getQueue, saveQueue, MAX_ITEMS };
