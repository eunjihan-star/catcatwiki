'use strict';

const { findRedevelopmentDatesViaGemini } = require('./services/geminiSearchService');

// 프론트엔드가 검색 결과를 렌더링한 직후 백그라운드로(비차단) 자동 호출하는 엔드포인트의
// 순수 로직. /api/search 안에서 동기적으로 부르지 않는 이유는 searchHandler.js의 주석 참고.
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

  return findRedevelopmentDatesViaGemini({
    buildingName: buildingName.trim(),
    regionLabel: typeof regionLabel === 'string' ? regionLabel : undefined,
    knownCompletionDate: typeof knownCompletionDate === 'string' ? knownCompletionDate : undefined,
    missingFields: fields,
  });
}

module.exports = { handleAiResearch };
