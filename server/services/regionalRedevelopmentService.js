'use strict';

const axios = require('axios');

/**
 * 공공데이터포털 "서울특별시_서울시 정비사업 데이터" (데이터셋 15097425) 연동.
 * https://www.data.go.kr/data/15097425/fileData.do
 *
 * ⚠️ 주의사항 (반드시 읽어주세요)
 * 1. 전국 단위 "재건축·재개발 정비구역 정보 API"는 존재하지 않는다. 지자체별로 각자
 *    데이터를 올려두며, 상당수가 REST API가 아니라 파일(CSV/엑셀) 형태다. 이 파일은
 *    "3단계 이상 개방 파일데이터"라 공공데이터포털이 자동으로 REST API(odcloud.kr)로도
 *    변환해서 제공하는데, 그 URL을 이 파일 안에서 확정적으로 확인할 방법이 없다
 *    (활용신청 승인 후 마이페이지 > 개발계정 상세보기에서만 정확한 Request URL이 나옴).
 *    그래서 아래 DEFAULT_BASE_URL은 "가장 유력한 추정값"이고, 실제로 승인받은 뒤
 *    마이페이지에 나오는 URL과 다르면 SEOUL_REDEVELOPMENT_API_URL 환경변수로 덮어써야 한다.
 * 2. 이 데이터셋은 조합설립인가일/사업시행인가일/관리처분계획인가일을 각각의 날짜로
 *    주지 않는다. "시행단계"(현재 어느 단계인지 텍스트)와 "고시일"(그 단계 1건의 고시일)
 *    만 제공한다 — 단계별 이력 전체가 아니다.
 * 3. "수시(1회성)" 갱신 데이터라 실시간 최신이 아닐 수 있다.
 * 4. 이 모듈은 실제 승인된 서비스키로 아직 호출 테스트를 하지 못했다. 문서상 확인된
 *    필드명(정비구역명/시군구명/법정동명/번지/시행단계/고시일 등)과 공공데이터포털
 *    파일데이터 자동변환 API(odcloud.kr)의 표준 응답 형식({data:[...], totalCount})을
 *    기반으로 작성했다 — 키 발급 후 실제 응답으로 필드명이 정확히 일치하는지 검증 필요.
 */
const CONFIRMED_UDDI = 'ea9330ee-5759-4bc9-b2d6-c759ec615815';
const DEFAULT_BASE_URL = `https://api.odcloud.kr/api/15097425/v1/uddi:${CONFIRMED_UDDI}`;

function resolveApiKey() {
  return process.env.SEOUL_REDEVELOPMENT_API_KEY || null;
}

function resolveBaseUrl() {
  return process.env.SEOUL_REDEVELOPMENT_API_URL || DEFAULT_BASE_URL;
}

// "수시(1회성)" 갱신 데이터라 자주 바뀌지 않으므로, 같은 서버리스 인스턴스가 살아있는
// 동안은 캐시해서 매 요청마다 수천 행을 다시 받아오지 않게 한다.
let cache = null; // { fetchedAt, rows }
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchAllRows() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rows;

  const apiKey = resolveApiKey();
  if (!apiKey) {
    const err = new Error(
      '서울시 정비사업 데이터 API 키가 없습니다. 공공데이터포털에서 "서울특별시_서울시 정비사업 데이터"(15097425) ' +
        '활용신청 후 발급받은 서비스키를 .env의 SEOUL_REDEVELOPMENT_API_KEY 에 등록해주세요.'
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const rows = [];
  const perPage = 300;
  let page = 1;
  let totalCount = Infinity;

  while (rows.length < totalCount && page <= 30) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await axios.get(resolveBaseUrl(), {
      params: { page, perPage, serviceKey: apiKey },
      timeout: 8000,
    });
    const pageRows = data?.data || [];
    totalCount = typeof data?.totalCount === 'number' ? data.totalCount : pageRows.length;
    rows.push(...pageRows);
    if (pageRows.length === 0) break;
    page += 1;
  }

  cache = { fetchedAt: Date.now(), rows };
  return rows;
}

/**
 * 시/도·시군구·법정동·번지로 서울시 정비구역을 찾는다. 서울 주소가 아니면 조회 없이 null.
 * @param {{ sido: string, sigungu: string, dong: string, bunji: string }} location
 */
async function findSeoulRedevelopmentZone({ sido, dong, bunji }) {
  if (!sido || !sido.includes('서울')) return null;
  if (!dong && !bunji) return null;

  const rows = await fetchAllRows();
  const normalize = (s) => (s || '').replace(/\s/g, '');
  const normalizedDong = normalize(dong).replace(/(동|읍|면|가)$/, '');
  const normalizedBunji = normalize(bunji);

  const match = rows.find((row) => {
    const rowDong = normalize(row['법정동명']).replace(/(동|읍|면|가)$/, '');
    const rowBunji = normalize(row['번지']);
    if (normalizedDong && rowDong && rowDong !== normalizedDong) return false;
    if (!normalizedBunji || !rowBunji) return false;
    return rowBunji === normalizedBunji;
  });

  if (!match) return null;

  return {
    zoneName: match['정비구역명'] || null,
    sigungu: match['시군구명'] || null,
    dong: match['법정동명'] || null,
    bunji: match['번지'] || null,
    projectType: match['정비유형'] || null,
    implementationMethod: match['사업시행방식'] || null,
    implementerType: match['시행자구분'] || null,
    stage: match['시행단계'] || null, // "현재 단계" 텍스트 (조합설립인가/사업시행인가/관리처분인가 등)
    noticeDate: match['고시일'] || null, // 위 단계 1건의 고시일 — 단계별 이력 전체 아님
    noticeNumber: match['고시번호'] || null,
    zoneArea: match['정비구역면적'] || null,
    basicPlanName: match['기본계획명'] || null,
    source: '공공데이터포털 "서울특별시_서울시 정비사업 데이터"(15097425, 수시 갱신)',
  };
}

module.exports = { findSeoulRedevelopmentZone };
