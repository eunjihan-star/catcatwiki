'use strict';

const axios = require('axios');

/**
 * 한국부동산원 청약홈 - APT 분양정보 상세조회 (청약 당첨자발표일 = 청약당첨일/분양일 자동 조회)
 * https://www.data.go.kr/data/15098547/openapi.do
 * 엔드포인트: https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail
 * (2026-08 웹 검색으로 확인 - 이 API를 실제로 쓰는 공개된 연동 코드에서 교차 확인한
 * 필드만 사용한다: HOUSE_NM(주택명), RCRIT_PBLANC_DE(모집공고일), PRZWNER_PRESNATN_DE
 * (당첨자발표일). 주소/공급위치 필드명은 아직 실제 응답으로 확인 못 해서 안 쓴다 -
 * 이름(HOUSE_NM) 매칭만 하고, 활용신청 승인 후 실제 응답으로 검증되면 주소 매칭도 추가한다.
 *
 * ⚠️ 아직 이 dataset에 대한 활용신청이 안 되어 있으면 401을 받는다 - data.go.kr에서
 * "한국부동산원_청약홈 분양정보 조회 서비스"(15098547) 활용신청 필요.
 * ⚠️ "100% 커버"는 아니다 - 청약(공개분양) 절차를 거친 단지만 있다. 100% 조합원 물량
 * 재건축(일반분양 없음)이나 청약홈 등록(2022-01) 이전 단지는 데이터가 없을 수 있다.
 */
const BASE_URL = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail';

function normalizeText(s) {
  return (s || '').replace(/\s/g, '');
}

// 정부 API 날짜는 보통 "20240315" 압축 형식으로 온다 - 이미 대시가 있으면 그대로 둔다.
// (실제 응답으로 아직 검증 못 해서 두 형식 다 안전하게 처리)
function formatDate(d) {
  if (!d) return null;
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d;
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

// "실시간" 갱신 데이터지만, 매 검색마다 전체 목록을 다시 받아오면 느리고 API 호출도
// 낭비되므로 1시간 캐시한다 (다른 지역 정비사업 API들과 동일한 패턴).
let cache = null;
const CACHE_TTL_MS = 60 * 60 * 1000;
async function getCachedRows() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rows;
  const rows = await fetchApplyhomeRows();
  cache = { rows, fetchedAt: Date.now() };
  return rows;
}

/**
 * 아파트명으로 청약 당첨자발표일(=청약당첨일/분양일)을 찾는다.
 * @param {string} buildingName
 * @returns {Promise<{winAnnouncementDate: string|null, houseName: string, noticeDate: string|null, source: string}|null>}
 */
async function findApplyhomeInfo(buildingName) {
  if (!buildingName) return null;
  const rows = await getCachedRows();
  const wantName = normalizeText(buildingName);
  if (!wantName) return null;
  const match = rows.find((row) => {
    const rowName = normalizeText(row['HOUSE_NM']);
    return rowName && (rowName.includes(wantName) || wantName.includes(rowName));
  });
  if (!match) return null;
  return {
    winAnnouncementDate: formatDate(match['PRZWNER_PRESNATN_DE']),
    houseName: match['HOUSE_NM'] || null,
    noticeDate: formatDate(match['RCRIT_PBLANC_DE']),
    source: '한국부동산원 청약홈 "APT 분양정보 조회 서비스"(15098547)',
  };
}

module.exports = { findApplyhomeInfo };
