'use strict';

const axios = require('axios');

/**
 * 지역별 정비사업(재건축·재개발) 데이터 연동.
 *
 * ⚠️ 전국 통합 API는 존재하지 않는다 (확인 완료). 지자체마다 다른 포털/다른 API/다른
 * 필드 구조를 각자 등록해뒀다 — 그래서 이 파일은 "지역 핸들러 레지스트리" 구조로
 * 짰다. 새 지역을 추가하려면:
 *   1) 그 지자체의 정비사업 데이터를 data.go.kr(또는 지자체 자체 열린데이터광장)에서
 *      직접 찾아 실제 API 문서(Request URL, 파라미터, 응답 필드명)를 확인한다
 *      (추측으로 엔드포인트를 지어내지 않는다 — 틀린 정보보다 "이 지역은 아직 지원
 *      안 함"이 낫다는 게 이 프로젝트의 원칙).
 *   2) fetchXxxRows / matchXxxRow / normalizeXxxRow 세 함수를 만들어 REGION_HANDLERS
 *      배열에 등록한다.
 *
 * 등록 안 된 지역은 findRedevelopmentZone()이 에러 없이 조용히 null을 반환한다 —
 * "커버리지가 아직 없다"는 뜻이지 오류가 아니다.
 */

function normalizeText(s) {
  return (s || '').replace(/\s/g, '');
}

function dongRoot(dong) {
  return normalizeText(dong).replace(/(동|읍|면|가)$/, '');
}

// =========================================================================
// 서울특별시 — 공공데이터포털 "서울특별시_서울시 정비사업 데이터" (15097425)
// https://www.data.go.kr/data/15097425/fileData.do
// UDDI 확인됨: ea9330ee-5759-4bc9-b2d6-c759ec615815
// ⚠️ 정확한 Request URL은 활용신청 승인 후 "마이페이지 > 개발계정 상세보기"에서
//    확인 필요 (아래 URL은 공공데이터포털 파일데이터 자동변환 API의 표준 패턴을
//    따른 추정값 — 다르면 SEOUL_REDEVELOPMENT_API_URL 환경변수로 덮어쓸 것).
// ⚠️ 조합설립인가일/사업시행인가일/관리처분계획인가일 개별 필드 없음 —
//    "시행단계"(현재 단계 텍스트) + "고시일"(그 단계 1건의 고시일)만 제공.
// ⚠️ "수시(1회성)" 갱신이라 실시간 최신이 아닐 수 있음.
// =========================================================================
const SEOUL_UDDI = 'ea9330ee-5759-4bc9-b2d6-c759ec615815';
const SEOUL_DEFAULT_URL = `https://api.odcloud.kr/api/15097425/v1/uddi:${SEOUL_UDDI}`;

async function fetchSeoulRows() {
  const apiKey = process.env.SEOUL_REDEVELOPMENT_API_KEY;
  if (!apiKey) {
    const err = new Error(
      '서울 정비사업 데이터 키가 없습니다. data.go.kr "서울특별시_서울시 정비사업 데이터"(15097425) 활용신청 후 ' +
        '.env의 SEOUL_REDEVELOPMENT_API_KEY 에 등록해주세요.'
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  const baseUrl = process.env.SEOUL_REDEVELOPMENT_API_URL || SEOUL_DEFAULT_URL;

  const rows = [];
  let page = 1;
  let totalCount = Infinity;
  while (rows.length < totalCount && page <= 30) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await axios.get(baseUrl, { params: { page, perPage: 300, serviceKey: apiKey }, timeout: 8000 });
    const pageRows = data?.data || [];
    totalCount = typeof data?.totalCount === 'number' ? data.totalCount : pageRows.length;
    rows.push(...pageRows);
    if (pageRows.length === 0) break;
    page += 1;
  }
  return rows;
}

function matchSeoulRow(row, { dong, bunji }) {
  const rowDong = dongRoot(row['법정동명']);
  const rowBunji = normalizeText(row['번지']);
  const wantDong = dongRoot(dong);
  const wantBunji = normalizeText(bunji);
  if (wantDong && rowDong && rowDong !== wantDong) return false;
  if (!wantBunji || !rowBunji) return false;
  return rowBunji === wantBunji;
}

function normalizeSeoulRow(row) {
  return {
    zoneName: row['정비구역명'] || null,
    sigungu: row['시군구명'] || null,
    dong: row['법정동명'] || null,
    bunji: row['번지'] || null,
    projectType: row['정비유형'] || null,
    implementationMethod: row['사업시행방식'] || null,
    implementerType: row['시행자구분'] || null,
    stage: row['시행단계'] || null,
    noticeDate: row['고시일'] || null,
    noticeNumber: row['고시번호'] || null,
    zoneArea: row['정비구역면적'] || null,
    basicPlanName: row['기본계획명'] || null,
    source: '공공데이터포털 "서울특별시_서울시 정비사업 데이터"(15097425, 수시 갱신)',
  };
}

// =========================================================================
// 부산광역시 — 공공데이터포털 "부산광역시_정비사업 정보" (3069406)
// https://www.data.go.kr/data/3069406/openapi.do
// 확인된 실제 REST 엔드포인트 (건축HUB와 동일한 표준 응답 포맷 사용):
//   http://apis.data.go.kr/6260000/MaintenanceBusinessStatus1/getMaintenanceBusiness1
// ⚠️ 주소(법정동/번지) 조회 파라미터가 없어 전체 목록을 받아 location 필드
//    텍스트에 동/번지가 포함되는지로 매칭한다 (정확도가 서울보다 낮을 수 있음).
// ⚠️ 조합설립인가일/사업시행인가일/관리처분계획인가일 개별 필드 없음 —
//    "step"(사업추진단계) 텍스트만 제공.
// =========================================================================
const BUSAN_BASE_URL = 'http://apis.data.go.kr/6260000/MaintenanceBusinessStatus1/getMaintenanceBusiness1';

async function fetchBusanRows() {
  const apiKey = process.env.BUSAN_REDEVELOPMENT_API_KEY;
  if (!apiKey) {
    const err = new Error(
      '부산 정비사업 데이터 키가 없습니다. data.go.kr "부산광역시_정비사업 정보"(3069406) 활용신청 후 ' +
        '.env의 BUSAN_REDEVELOPMENT_API_KEY 에 등록해주세요.'
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const rows = [];
  let pageNo = 1;
  let totalCount = Infinity;
  while (rows.length < totalCount && pageNo <= 30) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await axios.get(BUSAN_BASE_URL, {
      params: { ServiceKey: apiKey, pageNo, numOfRows: 300, resultType: 'json' },
      timeout: 8000,
    });
    const body = data?.response?.body;
    const items = body?.items?.item;
    const pageRows = items ? (Array.isArray(items) ? items : [items]) : [];
    totalCount = Number(body?.totalCount) || pageRows.length;
    rows.push(...pageRows);
    if (pageRows.length === 0) break;
    pageNo += 1;
  }
  return rows;
}

function matchBusanRow(row, { dong, bunji }) {
  const location = normalizeText(row['location']);
  if (!location) return false;
  const wantDong = dongRoot(dong);
  const wantBunji = normalizeText(bunji);
  if (wantDong && !location.includes(wantDong)) return false;
  if (!wantBunji || !location.includes(wantBunji)) return false;
  return true;
}

function normalizeBusanRow(row) {
  return {
    zoneName: row['areaName'] || null,
    sigungu: null,
    dong: null,
    bunji: null,
    location: row['location'] || null,
    projectType: null,
    implementationMethod: null,
    implementerType: row['businessEntities'] || null,
    stage: row['step'] || null,
    noticeDate: null,
    noticeNumber: null,
    zoneArea: row['areaUnit'] || null,
    basicPlanName: null,
    contractor: row['contractor'] || null,
    unionMemberCount: row['guildMemNum'] || null,
    householdCount: row['generationJoo'] || null,
    source: '공공데이터포털 "부산광역시_정비사업 정보"(3069406)',
  };
}

// =========================================================================
// 지역 레지스트리 — 새 지역은 이 배열에 추가한다.
// =========================================================================
const REGION_HANDLERS = [
  { name: 'seoul', match: (sido) => sido.includes('서울'), fetchRows: fetchSeoulRows, matchRow: matchSeoulRow, normalizeRow: normalizeSeoulRow },
  { name: 'busan', match: (sido) => sido.includes('부산'), fetchRows: fetchBusanRows, matchRow: matchBusanRow, normalizeRow: normalizeBusanRow },
];

// "수시" 갱신 데이터라 자주 바뀌지 않으므로, 같은 서버리스 인스턴스가 살아있는 동안은
// 캐시해서 매 요청마다 수천 행을 다시 받아오지 않게 한다.
const rowsCache = new Map(); // 지역 이름 -> { fetchedAt, rows }
const CACHE_TTL_MS = 60 * 60 * 1000;

async function getCachedRows(handler) {
  const cached = rowsCache.get(handler.name);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.rows;
  const rows = await handler.fetchRows();
  rowsCache.set(handler.name, { fetchedAt: Date.now(), rows });
  return rows;
}

/**
 * 시/도명으로 등록된 지역 핸들러를 찾아 정비구역을 조회한다.
 * 아직 등록되지 않은 지역이면 에러 없이 조용히 null을 반환한다
 * (전국 커버리지가 아직 없다는 뜻이지 오류가 아니다 — 메인 검색 흐름을 막지 않는다).
 * @param {{ sido: string, dong: string, bunji: string }} location
 */
async function findRedevelopmentZone({ sido, dong, bunji }) {
  if (!sido) return null;
  const handler = REGION_HANDLERS.find((h) => h.match(sido));
  if (!handler) return null;
  if (!dong && !bunji) return null;

  const rows = await getCachedRows(handler);
  const match = rows.find((row) => handler.matchRow(row, { dong, bunji }));
  if (!match) return null;
  return handler.normalizeRow(match);
}

module.exports = { findRedevelopmentZone };
