'use strict';

const axios = require('axios');
const xml2js = require('xml2js');

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

// 부산/인천/경기 데이터는 "OOO번지 일원"처럼 대표 본번만 적어두고 그 일대(부번 포함)를
// 통째로 가리킨다 - 실제 검색 주소는 "727-17"처럼 부번이 붙어있는 경우가 많아서, 부번까지
// 포함한 전체 문자열로 매칭하면 실패한다. 본번만 떼어 매칭한다 (서울은 번/지 필드가 따로
// 있어 정확 매칭이 가능하므로 이 함수를 쓰지 않는다).
function mainLot(bunji) {
  return normalizeText(bunji).split('-')[0];
}

// odcloud.kr "파일데이터 자동변환 API" 표준 응답(data.data / data.totalCount)을 쓰는
// 지역(서울/인천)이 공유하는 페이지네이션 fetch. 페이지를 하나씩 순서대로 기다리면
// 데이터셋이 클 때(또는 캐시가 비어있는 서버 콜드스타트 직후) 검색 하나가 페이지 수만큼
// 느려진다 - 1페이지로 전체 건수를 먼저 알아낸 뒤 나머지 페이지는 전부 동시에 요청한다.
async function fetchOdcloudRowsParallel(baseUrl, apiKey, { perPage = 300, maxPages = 30 } = {}) {
  const first = await axios.get(baseUrl, { params: { page: 1, perPage, serviceKey: apiKey }, timeout: 8000 });
  const firstRows = first.data?.data || [];
  const totalCount = typeof first.data?.totalCount === 'number' ? first.data.totalCount : firstRows.length;
  const totalPages = Math.min(Math.ceil(totalCount / perPage), maxPages);

  if (totalPages <= 1 || firstRows.length === 0) return firstRows;

  const remainingPageNumbers = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  const restPages = await Promise.all(
    remainingPageNumbers.map((page) =>
      axios
        .get(baseUrl, { params: { page, perPage, serviceKey: apiKey }, timeout: 8000 })
        .then((res) => res.data?.data || [])
    )
  );
  return firstRows.concat(...restPages);
}

// =========================================================================
// 서울특별시 — 공공데이터포털 "서울특별시_서울시 정비사업 데이터" (15097425)
// https://www.data.go.kr/data/15097425/fileData.do
// UDDI/엔드포인트 2026-07-24 실제 응답으로 확인 완료: ea9330ee-5759-4bc9-b2d6-c759ec615815
// (SEOUL_REDEVELOPMENT_API_URL 환경변수로 필요 시 덮어쓸 수 있음).
// ⚠️ "20211227" 스냅샷 고정 데이터 — 갱신주기 "수시(1회성)", 실제 고시일도 최대
//    2021-12-16까지뿐이라 그 이후 진행 상황은 반영되지 않음. 25개 자치구 중 19개 구만
//    포함(전체 200건) — 강남·강동·광진·금천·도봉·은평구 없음.
// ⚠️ 조합설립인가일/사업시행인가일/관리처분계획인가일 개별 필드 없음 —
//    "시행단계"(현재 단계 텍스트) + "고시일"(그 단계 1건의 고시일)만 제공.
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
  return fetchOdcloudRowsParallel(baseUrl, apiKey);
}

// 실제 API 응답은 번지를 "번"(본번)과 "지"(부번) 두 개의 숫자 필드로 나눠서 준다
// (합쳐진 "번지" 문자열 필드는 없음 — 2026-07-24 실제 응답으로 확인).
// searchHandler.js가 넘기는 bunji 포맷("137" 또는 "137-8")과 맞추기 위해 동일한 규칙으로 조립한다.
function seoulRowBunji(row) {
  const main = row['번'];
  if (main === undefined || main === null || main === '') return '';
  const sub = row['지'];
  return `${Number(main)}${sub && Number(sub) !== 0 ? `-${Number(sub)}` : ''}`;
}

function matchSeoulRow(row, { dong, bunji }) {
  const rowDong = dongRoot(row['법정동명']);
  const rowBunji = normalizeText(seoulRowBunji(row));
  const wantDong = dongRoot(dong);
  const wantBunji = normalizeText(bunji);
  if (wantDong && rowDong && rowDong !== wantDong) return false;
  if (!wantBunji || !rowBunji) return false;
  return rowBunji === wantBunji;
}

// 정확한 번지가 안 맞을 때(재건축 완료로 지번이 재편된 경우 등) 같은 법정동 후보를 찾는 용도.
function matchSeoulDongRow(row, { dong }) {
  const wantDong = dongRoot(dong);
  if (!wantDong) return false;
  return dongRoot(row['법정동명']) === wantDong;
}

function normalizeSeoulRow(row) {
  return {
    // ⚠️ 실제 응답 필드명은 공백 포함: "정비 구역명", "정비구역 면적(제곱미터)", "시행자 구분"
    // (공공데이터포털 파일데이터 자동변환 API 특성상 원본 엑셀 헤더의 공백이 그대로 남아있음).
    zoneName: row['정비 구역명'] || null,
    sigungu: row['시군구명'] || null,
    dong: row['법정동명'] || null,
    bunji: seoulRowBunji(row) || null,
    projectType: row['정비유형'] || null,
    implementationMethod: row['사업시행방식'] || null,
    implementerType: row['시행자 구분'] || null,
    stage: row['시행단계'] || null,
    noticeDate: row['고시일'] || null,
    noticeNumber: row['고시번호'] || null,
    zoneArea: row['정비구역 면적(제곱미터)'] || null,
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

  const numOfRows = 300;
  const maxPages = 30;

  async function fetchPage(pageNo) {
    const { data } = await axios.get(BUSAN_BASE_URL, {
      params: { ServiceKey: apiKey, pageNo, numOfRows, resultType: 'json' },
      timeout: 8000,
    });
    const body = data?.response?.body;
    const items = body?.items?.item;
    const pageRows = items ? (Array.isArray(items) ? items : [items]) : [];
    return { pageRows, totalCount: Number(body?.totalCount) || pageRows.length };
  }

  // 페이지를 하나씩 순서대로 기다리지 않고, 1페이지로 전체 건수를 먼저 알아낸 뒤
  // 나머지 페이지는 전부 동시에 요청한다 (콜드스타트 직후 첫 검색이 느려지는 원인이었다).
  const { pageRows: firstRows, totalCount } = await fetchPage(1);
  const totalPages = Math.min(Math.ceil(totalCount / numOfRows), maxPages);
  if (totalPages <= 1 || firstRows.length === 0) return firstRows;

  const remainingPageNumbers = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  const restPages = await Promise.all(remainingPageNumbers.map((pageNo) => fetchPage(pageNo).then((r) => r.pageRows)));
  return firstRows.concat(...restPages);
}

function matchBusanRow(row, { dong, bunji }) {
  const location = normalizeText(row['location']);
  if (!location) return false;
  const wantDong = dongRoot(dong);
  const wantBunji = mainLot(bunji);
  if (wantDong && !location.includes(wantDong)) return false;
  if (!wantBunji || !location.includes(wantBunji)) return false;
  return true;
}

function matchBusanDongRow(row, { dong }) {
  const location = normalizeText(row['location']);
  const wantDong = dongRoot(dong);
  if (!location || !wantDong) return false;
  return location.includes(wantDong);
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
// 인천광역시 — 공공데이터포털 "인천광역시_도시 및 주거환경 정비사업 추진현황" (15055212)
// https://www.data.go.kr/data/15055212/fileData.do
// ⚠️ 서울/부산과 달리 매월 새 파일이 올라올 때마다 UDDI 자체가 통째로 바뀐다
//    (2026-08 확인 시점 기준 ..._20260430 -> ..._20260531 처럼 매달 새 UDDI).
//    그래서 UDDI를 고정 상수로 박아두면 한 달 뒤 죽는다 — 대신 infuser.odcloud.kr의
//    OAS 문서에서 그 시점 "가장 최신 날짜" 항목을 직접 찾아 쓰고(resolveIncheonPath),
//    30일 캐시한다. 크롤링 없이 공식 API만으로 "월 1회 자동 최신화"가 되는 케이스.
// ⚠️ 조합설립인가일/사업시행인가일/관리처분계획인가일 개별 필드 없음 - "진행단계" 텍스트만.
// ⚠️ 응답 필드명에 공백 있음: "구 역 명" (2026-08 실제 응답으로 확인, "구역명" 아님).
// ⚠️ 법정동/번지 필드가 따로 없고 "위치" 텍스트 하나뿐 - 부산과 같은 방식(텍스트 포함
//    여부)으로 매칭한다.
// ⚠️ 2026-08 기준 이 dataset(15055212)에 대한 활용신청이 아직 안 되어 있어
//    INCHEON_REDEVELOPMENT_API_KEY 없이는 401을 받는다 - data.go.kr에서 활용신청 필요.
// =========================================================================
const INCHEON_DATASET_ID = '15055212';
let incheonPathCache = null; // { path, resolvedAt }
const INCHEON_PATH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

async function resolveIncheonPath() {
  if (incheonPathCache && Date.now() - incheonPathCache.resolvedAt < INCHEON_PATH_CACHE_TTL_MS) {
    return incheonPathCache.path;
  }
  const { data } = await axios.get('https://infuser.odcloud.kr/oas/docs', {
    params: { namespace: `${INCHEON_DATASET_ID}/v1` },
    timeout: 8000,
  });
  const paths = Object.keys(data?.paths || {});
  let best = null;
  for (const p of paths) {
    const summary = data.paths[p]?.get?.summary || '';
    const m = summary.match(/_(\d{8})$/); // "..._20260531" 형태에서 날짜만 추출
    if (!m) continue;
    if (!best || m[1] > best.dateStr) best = { path: p, dateStr: m[1] };
  }
  if (!best) {
    throw new Error('인천 정비사업 API의 최신 UDDI를 찾지 못했습니다 (OAS 문서 구조가 바뀌었을 수 있음).');
  }
  incheonPathCache = { path: best.path, resolvedAt: Date.now() };
  return best.path;
}

async function fetchIncheonRows() {
  const apiKey = process.env.INCHEON_REDEVELOPMENT_API_KEY;
  if (!apiKey) {
    const err = new Error(
      '인천 정비사업 데이터 키가 없습니다. data.go.kr "인천광역시_도시 및 주거환경 정비사업 추진현황"(15055212) 활용신청 후 ' +
        '.env의 INCHEON_REDEVELOPMENT_API_KEY 에 등록해주세요.'
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  const path = await resolveIncheonPath(); // 예: "/15055212/v1/uddi:..."
  const baseUrl = `https://api.odcloud.kr/api${path}`;
  return fetchOdcloudRowsParallel(baseUrl, apiKey);
}

function matchIncheonRow(row, { dong, bunji }) {
  const location = normalizeText(row['위치']);
  if (!location) return false;
  const wantDong = dongRoot(dong);
  const wantBunji = mainLot(bunji);
  if (wantDong && !location.includes(wantDong)) return false;
  if (!wantBunji || !location.includes(wantBunji)) return false;
  return true;
}

function matchIncheonDongRow(row, { dong }) {
  const location = normalizeText(row['위치']);
  const wantDong = dongRoot(dong);
  if (!location || !wantDong) return false;
  return location.includes(wantDong);
}

function normalizeIncheonRow(row) {
  return {
    zoneName: row['구 역 명'] || null,
    sigungu: row['구명'] || null,
    dong: null,
    bunji: null,
    location: row['위치'] || null,
    projectType: row['사업유형'] || null,
    implementationMethod: null,
    implementerType: null,
    stage: row['진행단계'] || null,
    noticeDate: null,
    noticeNumber: null,
    zoneArea: row['면적(제곱미터)'] || null,
    basicPlanName: null,
    source: '공공데이터포털 "인천광역시_도시 및 주거환경 정비사업 추진현황"(15055212, 매월 갱신)',
  };
}

// =========================================================================
// 경기도 — 경기데이터드림 "일반 정비 사업 추진 현황"
// https://data.gg.go.kr/portal/data/service/selectServicePage.do?infId=S62GFEEN7JMLMA0PH6CF19108891&infSeq=1
// ⚠️ data.go.kr이 아니라 경기도 자체 포털(경기데이터드림)이라 인증키가 별도다
//    (data.gg.go.kr 로그인 -> 마이페이지 -> 인증키발급). 정확한 서비스 Request URL은
//    경기데이터드림 자체 "서비스 목록 조회" API(https://openapi.gg.go.kr/opendatalist,
//    INF_NM 파라미터로 검색)로 2026-08 실제 응답에서 확인: GenrlimprvBizpropls.
// ⚠️ JSON 응답(Type=json)은 이 API에서 500 에러가 났다 - XML(Type=xml)만 정상 동작
//    확인됨 (2026-08). 그래서 axios가 아니라 xml2js로 파싱한다.
// ⚠️ 헤더에 User-Agent가 없으면 방화벽(WAF)이 차단한다 - 반드시 브라우저 UA를 보낸다.
// ✅ 서울/부산/인천과 달리 조합설립인가일/사업시행인가일/관리처분인가일/착공일/준공일/
//    이전고시일까지 전부 개별 날짜 필드로 제공한다 (분기 갱신, 데이터기준일 2025-09-30).
// ⚠️ 법정동/번지 필드가 따로 없고 LOCPLC_ADDR(전체 주소 텍스트) 하나뿐 - 부산/인천과
//    같은 방식(텍스트 포함 여부)으로 매칭한다.
// =========================================================================
const GYEONGGI_BASE_URL = 'https://openapi.gg.go.kr/GenrlimprvBizpropls';
const GYEONGGI_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// "20030630" -> "2003-06-30". 빈 값이면 null.
function formatCompactDate(d) {
  if (!d || d.length !== 8) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

async function fetchGyeonggiRows() {
  const apiKey = process.env.GYEONGGI_REDEVELOPMENT_API_KEY;
  if (!apiKey) {
    const err = new Error(
      '경기 정비사업 데이터 키가 없습니다. data.gg.go.kr 로그인 후 마이페이지 > 인증키발급으로 발급받아 ' +
        '.env의 GYEONGGI_REDEVELOPMENT_API_KEY 에 등록해주세요.'
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const pSize = 100;
  const maxPages = 30;
  const parser = new xml2js.Parser({ explicitArray: false, trim: true });

  async function fetchPage(pIndex) {
    const { data: xml } = await axios.get(GYEONGGI_BASE_URL, {
      params: { KEY: apiKey, Type: 'xml', pIndex, pSize },
      headers: { 'User-Agent': GYEONGGI_USER_AGENT },
      timeout: 8000,
    });
    const parsed = await parser.parseStringPromise(xml);
    const root = parsed?.GenrlimprvBizpropls;
    const code = root?.head?.RESULT?.CODE;
    if (code && code !== 'INFO-000') {
      throw new Error(`경기 정비사업 API 오류: ${root?.head?.RESULT?.MESSAGE || code}`);
    }
    const pageRowsRaw = root?.row;
    const pageRows = pageRowsRaw ? (Array.isArray(pageRowsRaw) ? pageRowsRaw : [pageRowsRaw]) : [];
    return { pageRows, totalCount: Number(root?.head?.list_total_count) || 0 };
  }

  // 페이지를 하나씩 순서대로 기다리지 않고, 1페이지로 전체 건수를 먼저 알아낸 뒤
  // 나머지 페이지는 전부 동시에 요청한다 (콜드스타트 직후 첫 검색이 느려지는 원인이었다).
  const { pageRows: firstRows, totalCount } = await fetchPage(1);
  const totalPages = Math.min(Math.ceil(totalCount / pSize), maxPages);
  if (totalPages <= 1 || firstRows.length === 0) return firstRows;

  const remainingPageNumbers = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  const restPages = await Promise.all(remainingPageNumbers.map((pIndex) => fetchPage(pIndex).then((r) => r.pageRows)));
  return firstRows.concat(...restPages);
}

function matchGyeonggiRow(row, { dong, bunji }) {
  const location = normalizeText(row['LOCPLC_ADDR']);
  if (!location) return false;
  const wantDong = dongRoot(dong);
  const wantBunji = mainLot(bunji);
  if (wantDong && !location.includes(wantDong)) return false;
  if (!wantBunji || !location.includes(wantBunji)) return false;
  return true;
}

function matchGyeonggiDongRow(row, { dong }) {
  const location = normalizeText(row['LOCPLC_ADDR']);
  const wantDong = dongRoot(dong);
  if (!location || !wantDong) return false;
  return location.includes(wantDong);
}

function normalizeGyeonggiRow(row) {
  return {
    zoneName: row['IMPRV_ZONE_NM'] || null,
    sigungu: row['SIGUN_NM'] || null,
    dong: null,
    bunji: null,
    location: row['LOCPLC_ADDR'] || null,
    projectType: row['BIZ_TYPE_NM'] || null,
    implementationMethod: null,
    implementerType: row['BIZ_IMPLMNTR_NM'] || null,
    stage: row['BIZ_STEP_NM'] || null,
    noticeDate: null,
    noticeNumber: null,
    zoneArea: row['ZONE_AR'] || null,
    basicPlanName: null,
    contractor: null,
    householdCount: row['EXISTNG_HOUSNG_HSHLD_CNT'] || null,
    unionMemberCount: row['ASOCNTMB_CNT'] || null,
    // 서울/부산/인천과 달리 개별 인허가 날짜를 전부 제공 - renderOfficialZoneCard에서
    // 이 필드들이 있으면 "현재 단계" 1건 대신 단계별 날짜를 그대로 보여준다.
    unionEstablishmentDate: formatCompactDate(row['ASSOCTN_FOUND_CONFMTN_DE']),
    projectImplementationDate: formatCompactDate(row['BIZ_IMPLMTN_CONFMTN_DE']),
    managementDispositionDate: formatCompactDate(row['MANAGE_DISPOSIT_CONFMTN_DE']),
    constructionStartDate: formatCompactDate(row['STRCONTR_DE']),
    completionDate: formatCompactDate(row['COMPLTN_DE']),
    transferNotificationDate: formatCompactDate(row['TRANSFR_NOTIFC_DE']),
    source: '경기데이터드림 "일반 정비 사업 추진 현황"(분기 갱신)',
  };
}

// =========================================================================
// 지역 레지스트리 — 새 지역은 이 배열에 추가한다.
// =========================================================================
const REGION_HANDLERS = [
  { name: 'seoul', match: (sido) => sido.includes('서울'), fetchRows: fetchSeoulRows, matchRow: matchSeoulRow, matchDongRow: matchSeoulDongRow, normalizeRow: normalizeSeoulRow },
  { name: 'busan', match: (sido) => sido.includes('부산'), fetchRows: fetchBusanRows, matchRow: matchBusanRow, matchDongRow: matchBusanDongRow, normalizeRow: normalizeBusanRow },
  { name: 'incheon', match: (sido) => sido.includes('인천'), fetchRows: fetchIncheonRows, matchRow: matchIncheonRow, matchDongRow: matchIncheonDongRow, normalizeRow: normalizeIncheonRow },
  { name: 'gyeonggi', match: (sido) => sido.includes('경기'), fetchRows: fetchGyeonggiRows, matchRow: matchGyeonggiRow, matchDongRow: matchGyeonggiDongRow, normalizeRow: normalizeGyeonggiRow },
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

const MAX_CANDIDATE_ZONES = 5;

/**
 * 시/도명으로 등록된 지역 핸들러를 찾아 정비구역을 조회한다.
 * 아직 등록되지 않은 지역이면 에러 없이 조용히 { zone: null, candidates: [] }를 반환한다
 * (전국 커버리지가 아직 없다는 뜻이지 오류가 아니다 — 메인 검색 흐름을 막지 않는다).
 *
 * 정확한 번지 매칭이 실패하면(재건축이 이미 끝나 지번이 재편되거나 옛 지번이 멸실된 경우
 * 등) 같은 법정동에 등록된 사업을 candidates로 대신 내려준다 — 사람이 세대수·사업유형·
 * 준공연도로 직접 확인할 수 있게 하기 위함이다. 정확 매칭이 있으면 candidates는 비운다.
 * @param {{ sido: string, dong: string, bunji: string }} location
 * @returns {Promise<{ zone: object|null, candidates: object[] }>}
 */
async function findRedevelopmentZone({ sido, dong, bunji }) {
  const empty = { zone: null, candidates: [] };
  if (!sido) return empty;
  const handler = REGION_HANDLERS.find((h) => h.match(sido));
  if (!handler) return empty;
  if (!dong && !bunji) return empty;

  const rows = await getCachedRows(handler);
  const match = rows.find((row) => handler.matchRow(row, { dong, bunji }));
  if (match) return { zone: handler.normalizeRow(match), candidates: [] };

  if (!handler.matchDongRow || !dong) return empty;
  const dongMatches = rows.filter((row) => handler.matchDongRow(row, { dong }));
  const candidates = dongMatches.slice(0, MAX_CANDIDATE_ZONES).map((row) => handler.normalizeRow(row));
  return { zone: null, candidates };
}

module.exports = { findRedevelopmentZone };
