'use strict';

const axios = require('axios');

/**
 * 한국부동산원 청약홈 - APT 분양정보 상세조회 (청약 당첨자발표일 = 청약당첨일/분양일 자동 조회)
 * https://www.data.go.kr/data/15098547/openapi.do
 * 엔드포인트: https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail
 * 2026-08-04 활용신청 승인 후 실제 응답으로 필드명 전부 검증 완료:
 *   HOUSE_NM(주택명), HSSPLY_ADRES(공급위치 - "OO시 OO구 OO동 123번지 일원" 형태),
 *   RCRIT_PBLANC_DE(모집공고일), PRZWNER_PRESNATN_DE(당첨자발표일, 이미 "YYYY-MM-DD"
 *   형식), PBLANC_URL(청약홈 원문 상세페이지 링크), TOT_SUPLY_HSHLDCO(총 공급세대수).
 *
 * ⚠️ "100% 커버"는 아니다 - 청약(공개분양) 절차를 거친 단지만 있고, 2026-08-04 실제
 * 응답으로 확인한 커버 범위는 모집공고일 기준 약 2020-02 ~ 현재(최근 ~6년, 총 2,833건) -
 * 그 이전(예: 2015년 분양) 단지나 100% 조합원 물량 재건축(일반분양 없음)은 데이터가 없다.
 * ⚠️ 아파트명이 흔한 이름이면 여러 단지가 걸릴 수 있어, 지번주소를 넘겨주면 공급위치
 * 텍스트로 한 번 더 걸러서 정확도를 높인다(선택값 - 없으면 이름만으로 매칭).
 */
const BASE_URL = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail';

function normalizeText(s) {
  return (s || '').replace(/\s/g, '');
}

function dongRoot(dong) {
  return normalizeText(dong).replace(/(동|읍|면|가)$/, '');
}

async function fetchApplyhomeRows() {
  const apiKey = process.env.CHEONGYAK_API_KEY;
  if (!apiKey) {
    const err = new Error(
      '청약홈 분양정보 키가 없습니다. data.go.kr "한국부동산원_청약홈 분양정보 조회 서비스"(15098547) 활용신청 후 ' +
        '.env의 CHEONGYAK_API_KEY 에 등록해주세요.'
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const rows = [];
  let page = 1;
  let totalCount = Infinity;
  while (rows.length < totalCount && page <= 50) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await axios.get(BASE_URL, { params: { page, perPage: 300, serviceKey: apiKey }, timeout: 8000 });
    const pageRows = data?.data || [];
    totalCount = typeof data?.totalCount === 'number' ? data.totalCount : pageRows.length;
    rows.push(...pageRows);
    if (pageRows.length === 0) break;
    page += 1;
  }
  return rows;
}

// 분기별로 갱신되는 다른 API들과 달리 "실시간"이지만, 검색할 때마다 전체 2,800여건을
// 다시 받아오면 느리므로 1시간 캐시한다 (다른 지역 정비사업 API들과 동일한 패턴).
let cache = null;
const CACHE_TTL_MS = 60 * 60 * 1000;
async function getCachedRows() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rows;
  const rows = await fetchApplyhomeRows();
  cache = { rows, fetchedAt: Date.now() };
  return rows;
}

/**
 * 아파트명(+선택적으로 동명)으로 청약 당첨자발표일을 찾는다.
 * @param {string} buildingName
 * @param {string} [dong] 지번주소에서 뽑은 동/읍/면 이름 - 있으면 공급위치 텍스트와
 *   교차 확인해서 흔한 이름(래미안/자이 등)의 다른 단지가 잘못 걸리는 걸 줄인다.
 * @returns {Promise<{winAnnouncementDate: string|null, houseName: string, noticeDate: string|null, link: string|null, householdCount: string|null, source: string}|null>}
 */
async function findApplyhomeInfo(buildingName, dong) {
  if (!buildingName) return null;
  const rows = await getCachedRows();
  const wantName = normalizeText(buildingName);
  if (!wantName) return null;
  const wantDong = dongRoot(dong);

  const candidates = rows.filter((row) => {
    const rowName = normalizeText(row['HOUSE_NM']);
    return rowName && (rowName.includes(wantName) || wantName.includes(rowName));
  });
  if (candidates.length === 0) return null;

  // 이름 매칭이 여러 건이면 동(dong)이 일치하는 것으로 좁힌다 - 그래도 여러 건이면 첫 번째.
  const match = (wantDong && candidates.length > 1
    ? candidates.find((row) => normalizeText(row['HSSPLY_ADRES']).includes(wantDong))
    : null) || candidates[0];

  return {
    winAnnouncementDate: match['PRZWNER_PRESNATN_DE'] || null,
    houseName: match['HOUSE_NM'] || null,
    noticeDate: match['RCRIT_PBLANC_DE'] || null,
    link: match['PBLANC_URL'] || null,
    householdCount: match['TOT_SUPLY_HSHLDCO'] || null,
    source: '한국부동산원 청약홈 "APT 분양정보 조회 서비스"(15098547)',
  };
}

module.exports = { findApplyhomeInfo };
