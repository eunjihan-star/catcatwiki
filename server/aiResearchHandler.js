'use strict';

const { findRedevelopmentDatesViaAI } = require('./services/aiSearchService');

// 프론트엔드 "AI로 조사하기" 버튼이 호출하는 엔드포인트의 순수 로직. 검색할 때마다
// 자동으로 도는 게 아니라 사용자가 명시적으로 클릭했을 때만 (유료 API) 호출된다.
const VALID_FIELDS = new Set([
  'unionEstablishment',
  'projectImplementationApproval',
  'managementDisposalApproval',
  'subscriptionWin',
  'memberSuccession',
]);

/**
 * @param {{buildingName?: string, regionLabel?: string, knownCompletionDate?: string, missingFields?: string[]}} body
 */
async function handleAiResearch(body) {
  const { buildingName, regionLabel, knownCompletionDate, missingFields } = body || {};

  if (!buildingName || typeof buildingName !== 'string' || !buildingName.trim()) {
    const err = new Error('건물명(buildingName)이 필요합니다.');
    err.status = 400;
    throw err;
  }

  const fields = Array.isArray(missingFields) ? missingFields.filter((f) => VALID_FIELDS.has(f)) : [];
  if (fields.length === 0) {
    const err = new Error('조사할 항목이 없습니다.');
    err.status = 400;
    throw err;
  }

  return findRedevelopmentDatesViaAI({
    buildingName: buildingName.trim(),
    regionLabel: typeof regionLabel === 'string' ? regionLabel : undefined,
    knownCompletionDate: typeof knownCompletionDate === 'string' ? knownCompletionDate : undefined,
    missingFields: fields,
  });
}

module.exports = { handleAiResearch };
