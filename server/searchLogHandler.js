'use strict';

const { getSearchLog, saveSearchLog, MAX_ENTRIES } = require('./services/searchLogStore');
const { getWikiData } = require('./services/wikiDataStore');

function normalizeQuery(raw) {
  return (raw || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
}

async function handleGetSearchLog() {
  const data = await getSearchLog();
  const entries = (data.entries || [])
    .slice()
    .sort((a, b) => b.count - a.count || (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''));
  return { entries };
}

/**
 * 0건 검색어 기록. 정규화(공백정리+소문자)한 값을 키로 카운트를 누적한다.
 * 화면에 보여줄 원본 표기(sampleRaw)는 처음 본 형태를 그대로 유지한다 - 관리자가
 * 실제로 어떻게 띄어 썼는지도 태그 이름을 정할 때 참고가 되기 때문.
 */
async function handleRecordZeroResult(body) {
  const raw = (body && body.query || '').toString().slice(0, 200); // 과도하게 긴 입력 방지
  const norm = normalizeQuery(raw);
  if (!norm) return { ok: true };

  const data = await getSearchLog();
  const entries = data.entries || [];
  const now = new Date().toISOString();

  const existing = entries.find((e) => e.query === norm);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
  } else {
    entries.push({ query: norm, sampleRaw: raw, count: 1, firstSeenAt: now, lastSeenAt: now });
  }

  // 상한 초과 시 가장 오래전에 검색된 것부터 제거한다. 자주 나오는 검색어는 lastSeenAt이
  // 계속 갱신되므로 실질적으로 살아남고, 어쩌다 한 번 나온 오타 등이 먼저 밀려난다.
  entries.sort((a, b) => (a.lastSeenAt || '').localeCompare(b.lastSeenAt || ''));
  while (entries.length > MAX_ENTRIES) entries.shift();

  await saveSearchLog({ entries });
  return { ok: true };
}

/**
 * 로그 전체 삭제. wikiDataHandler.handleSaveWikiData와 동일하게 관리자 비밀번호 해시를
 * 확인한다 - 별도 인증체계를 새로 만들지 않고 기존 관리자 로그인(sessionAuthHash)을 재사용.
 */
async function handleClearSearchLog(body) {
  const wikiData = (await getWikiData()) || {};
  if (wikiData.adminPasswordHash && (!body || body.authHash !== wikiData.adminPasswordHash)) {
    const err = new Error('관리자 인증이 유효하지 않습니다. 다시 로그인해주세요.');
    err.status = 401;
    throw err;
  }
  await saveSearchLog({ entries: [] });
  return { ok: true };
}

module.exports = { handleGetSearchLog, handleRecordZeroResult, handleClearSearchLog };
