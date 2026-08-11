'use strict';

const crypto = require('crypto');
const { getQueue, saveQueue, MAX_ITEMS } = require('./services/linearQueueStore');
const { getWikiData, saveWikiData } = require('./services/wikiDataStore');

// 매일 도는 Linear 수집 루틴이 이 서버로 초안을 밀어넣을 때 쓰는 공유 비밀값. 사람이
// 입력하는 비밀번호가 아니라 우리 쪽 API와 우리 쪽 예약 루틴만 아는 값이라, 인터넷에
// 공개된 이 엔드포인트에 아무나 임의의 글을 밀어넣지 못하게 막는 최소한의 방어다.
// 미설정(로컬 개발 등)이면 검사를 건너뛴다.
const SYNC_SECRET = process.env.LINEAR_SYNC_SECRET;

async function handleGetQueue() {
  const data = await getQueue();
  const items = (data.items || [])
    .slice()
    .sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
  return { items };
}

/**
 * 예약 루틴이 분류까지 마친 초안들을 밀어넣는다. Linear 이슈 id 기준으로 이미 있는
 * 항목(pending이든 승인/반려 완료든)은 건드리지 않는다 - 검토 결과를 덮어쓰지 않기
 * 위함이고, 같은 이슈를 매일 계속 다시 긁어와도 중복으로 안 쌓이게 하기 위함이다.
 */
async function handleSubmitDrafts(body) {
  if (SYNC_SECRET && (!body || body.secret !== SYNC_SECRET)) {
    const err = new Error('인증되지 않은 요청입니다.');
    err.status = 401;
    throw err;
  }

  const drafts = Array.isArray(body && body.items) ? body.items : [];
  const data = await getQueue();
  const items = data.items || [];
  const existingIds = new Set(items.map((i) => i.linearIssueId));

  const now = new Date().toISOString();
  let added = 0;
  for (const d of drafts) {
    if (!d || !d.linearIssueId || existingIds.has(d.linearIssueId)) continue;
    items.push({
      id: crypto.randomUUID(),
      linearIssueId: d.linearIssueId,
      linearIdentifier: (d.linearIdentifier || '').toString().slice(0, 50),
      linearUrl: (d.linearUrl || '').toString().slice(0, 500),
      title: (d.title || '').toString().slice(0, 200),
      category: (d.category || '').toString().slice(0, 100),
      tags: Array.isArray(d.tags) ? d.tags.slice(0, 10).map((t) => t.toString().slice(0, 50)) : [],
      snippet: (d.snippet || '').toString().slice(0, 300),
      body: (d.body || '').toString().slice(0, 20000),
      status: 'pending',
      importedAt: now,
      reviewedAt: null,
    });
    existingIds.add(d.linearIssueId);
    added += 1;
  }

  // 상한 초과 시 오래된 pending부터 제거 (승인/반려된 건 감사 목적상 우선 보존)
  items.sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return (a.importedAt || '').localeCompare(b.importedAt || '');
  });
  while (items.length > MAX_ITEMS) {
    const idx = items.findIndex((i) => i.status === 'pending');
    if (idx === -1) break; // pending이 없으면(전부 심사완료) 더 못 줄임 - 그대로 둔다
    items.splice(idx, 1);
  }

  await saveQueue({ items });
  return { ok: true, added };
}

/**
 * 관리자 승인/반려. wikiDataHandler.handleSaveWikiData와 동일하게 관리자 비밀번호
 * 해시로 인증한다. 승인 시 실제 MANUAL 데이터에 항목을 추가한다.
 */
async function handleReviewDraft(body) {
  const { id, decision } = body || {};
  if (!id || (decision !== 'approve' && decision !== 'reject')) {
    const err = new Error('잘못된 요청입니다.');
    err.status = 400;
    throw err;
  }

  const wikiData = (await getWikiData()) || {};
  if (wikiData.adminPasswordHash && body.authHash !== wikiData.adminPasswordHash) {
    const err = new Error('관리자 인증이 유효하지 않습니다. 다시 로그인해주세요.');
    err.status = 401;
    throw err;
  }

  const data = await getQueue();
  const items = data.items || [];
  const item = items.find((i) => i.id === id);
  if (!item) {
    const err = new Error('대기열에서 해당 항목을 찾을 수 없습니다.');
    err.status = 404;
    throw err;
  }
  if (item.status !== 'pending') {
    const err = new Error('이미 처리된 항목입니다.');
    err.status = 409;
    throw err;
  }

  if (decision === 'approve') {
    const manual = Array.isArray(wikiData.manual) ? wikiData.manual.slice() : [];
    manual.push({
      id: `linear-${item.linearIssueId}`,
      title: item.title,
      category: item.category || '업무프로세스',
      tags: item.tags,
      snippet: item.snippet,
      body: item.body,
      source: `출처: Linear ${item.linearIdentifier}${item.linearUrl ? ' — ' + item.linearUrl : ''}`,
    });
    await saveWikiData({ ...wikiData, manual });
  }

  item.status = decision === 'approve' ? 'approved' : 'rejected';
  item.reviewedAt = new Date().toISOString();
  await saveQueue({ items });
  return { ok: true };
}

module.exports = { handleGetQueue, handleSubmitDrafts, handleReviewDraft };
