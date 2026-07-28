'use strict';

const { getWikiData, saveWikiData } = require('./services/wikiDataStore');

const ALLOWED_KEYS = ['manual', 'glossary', 'meetings', 'adminPasswordHash'];

async function handleGetWikiData() {
  const data = await getWikiData();
  return data || {};
}

/**
 * 관리자모드 저장. 클라이언트가 이미 하고 있던 것과 동일한 수준의 가벼운 보호(비밀번호
 * 해시 비교)를 서버에서도 한 번 더 확인한다 - 완전한 인증은 아니지만(해시가 페이지
 * 소스에 노출되는 방식이라는 건 화면에도 이미 안내 중), 최소한 관리자 토글을 거치지 않은
 * 요청을 걸러낸다. 저장된 값이 아직 없으면(최초 저장) 통과시킨다.
 */
async function handleSaveWikiData(body) {
  if (!body || typeof body !== 'object') {
    const err = new Error('잘못된 요청입니다.');
    err.status = 400;
    throw err;
  }

  const current = (await getWikiData()) || {};
  // authHash는 "지금 이 세션이 로그인할 때 쓴 비밀번호 해시"이고, body.adminPasswordHash는
  // "저장할 새 상태의 비밀번호 해시"라 서로 다를 수 있다(비밀번호 변경 시). 인증은 반드시
  // authHash로만 확인한다 - adminPasswordHash로 확인하면 비밀번호 변경 저장이 항상 실패한다.
  if (current.adminPasswordHash && body.authHash !== current.adminPasswordHash) {
    const err = new Error('관리자 인증이 유효하지 않습니다. 다시 로그인해주세요.');
    err.status = 401;
    throw err;
  }

  const payload = {};
  for (const key of ALLOWED_KEYS) {
    payload[key] = key in body ? body[key] : current[key];
  }
  await saveWikiData(payload);
  return { ok: true };
}

module.exports = { handleGetWikiData, handleSaveWikiData };
