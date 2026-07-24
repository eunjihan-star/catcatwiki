'use strict';

const axios = require('axios');
const xml2js = require('xml2js');

// 국토교통부 건축물대장정보 서비스 (공공데이터포털)
// https://www.data.go.kr/data/15057200/openapi.do
const BASE_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService';

// 표제부(건물 전체 개요) - 건물유형/사용승인일 확인용
const TITLE_INFO_PATH = '/getBrTitleInfo';
// 총괄표제부 - 대지면적은 동별 표제부가 아니라 여기(단지 전체 기준)에 있다
const RECAP_TITLE_INFO_PATH = '/getBrRecapTitleInfo';

// 사람마다 .env / Vercel 환경변수에 다른 이름으로 등록하는 경우가 많아
// (예: "공공데이터 API 키" -> PUBLIC_DATA_API_KEY), 흔히 쓰는 이름들을
// 모두 인식하도록 방어적으로 처리한다. 가장 먼저 값이 있는 것을 사용.
const API_KEY_ENV_ALIASES = [
  'BUILDING_REGISTER_API_KEY',
  'PUBLIC_DATA_API_KEY',
  'DATA_GO_KR_API_KEY',
  'BUILDING_LEDGER_API_KEY',
];

function resolveApiKey() {
  for (const name of API_KEY_ENV_ALIASES) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

/**
 * 건축물대장 표제부/총괄표제부 공용 호출 로직 (재시도 + XML 폴백 포함).
 * platGbCd: 0(대지) / 1(산)
 */
async function callBuildingRegisterApi(path, { sigunguCd, bjdongCd, platGbCd = '0', bun, ji }) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    const err = new Error(
      `건축물대장 API 키가 설정되지 않았습니다. .env(로컬) 또는 Vercel 환경변수에 다음 중 하나로 등록해주세요: ${API_KEY_ENV_ALIASES.join(', ')}`
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const params = {
    serviceKey: apiKey,
    sigunguCd,
    bjdongCd,
    platGbCd,
    bun: (bun || '0000').padStart(4, '0'),
    ji: (ji || '0000').padStart(4, '0'),
    // 큰 단지는 한 지번 아래 동이 수십 개까지 등록되기도 해서 넉넉히 받아온다
    // (대표 동을 고를 때 첫 페이지에 다 안 잡히면 소용없음).
    numOfRows: 100,
    pageNo: 1,
    _type: 'json',
  };

  // 공공데이터포털 게이트웨이가 요청 크기와 무관하게 꽤 자주(체감상 20~40%) 일시적인
  // 500/타임아웃을 던지는 게 관찰되어(같은 파라미터로 재요청하면 대부분 바로 성공),
  // 넉넉히 재시도한다. 실패 응답 자체는 빠르게 오므로 재시도를 늘려도 체감 지연은 크지 않다.
  // 4xx(요청 자체가 잘못됨)는 재시도해도 소용없으므로 그대로 던진다.
  const MAX_ATTEMPTS = 5;
  let data;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      ({ data } = await axios.get(`${BASE_URL}${path}`, { params, timeout: 8000 }));
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (err.response && err.response.status < 500) throw err;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  if (lastErr) throw lastErr;

  // 일부 오류 응답은 _type=json 을 무시하고 XML로 내려오므로 방어적으로 처리
  if (typeof data === 'string') {
    return parseXmlResponse(data);
  }

  const header = data?.response?.header;
  if (!header || header.resultCode !== '00') {
    const err = new Error(`건축물대장 API 오류: ${header?.resultMsg || '알 수 없는 오류'} (${header?.resultCode})`);
    err.code = header?.resultCode;
    throw err;
  }

  const items = data?.response?.body?.items?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function fetchTitleInfo(query) {
  return callBuildingRegisterApi(TITLE_INFO_PATH, query);
}

// 총괄표제부는 단지 전체 기준 대지면적을 담고 있다. 단독주택 등은 총괄표제부 자체가
// 없는 경우가 많아(일반건축물대장만 존재) 빈 배열이 정상일 수 있다 — 호출 실패로 취급하지 않는다.
async function fetchRecapTitleInfo(query) {
  try {
    return await callBuildingRegisterApi(RECAP_TITLE_INFO_PATH, query);
  } catch (err) {
    if (err.code === 'MISSING_API_KEY') throw err;
    return [];
  }
}

async function parseXmlResponse(xml) {
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, trim: true });
  const header = parsed?.response?.header;
  if (!header || header.resultCode !== '00') {
    const err = new Error(`건축물대장 API 오류: ${header?.resultMsg || '알 수 없는 오류'} (${header?.resultCode})`);
    err.code = header?.resultCode;
    throw err;
  }
  const items = parsed?.response?.body?.items?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

/**
 * 건축물대장 표제부(getBrTitleInfo)의 mainPurpsCdNm 은 "공동주택"/"단독주택"처럼
 * 건축법상 대분류만 내려주고, 실생활에서 쓰는 "아파트/연립주택/다세대주택" 구분은
 * 별도 필드로 주지 않는다 (예: "은마아파트"조차 mainPurpsCdNm="공동주택").
 * 따라서 건축법 시행령 별표1 기준(층수·면적)으로 직접 분류한다:
 *   - 아파트: 주택으로 쓰는 층수 5개 층 이상
 *   - 연립주택: 4개 층 이하 + 1개 동 바닥면적 합계(연면적) 660㎡ 초과
 *   - 다세대주택: 4개 층 이하 + 1개 동 바닥면적 합계 660㎡ 이하
 * 오피스텔은 mainPurpsCdNm 이 "업무시설"로 잡히므로 etcPurps/건물명에서 별도 확인.
 */
function classifyBuildingType(item) {
  const mainPurpsCdNm = item.mainPurpsCdNm || '';
  const etcPurps = item.etcPurps || '';
  const buildingName = item.bldNm || '';
  const haystack = [mainPurpsCdNm, etcPurps, buildingName].join(' ');
  const grndFlrCnt = Number(item.grndFlrCnt) || 0;
  const totArea = Number(item.totArea) || 0;

  if (haystack.includes('오피스텔')) return '오피스텔';

  if (mainPurpsCdNm.includes('단독주택')) {
    return haystack.includes('다가구') ? '다가구주택' : '단독주택';
  }

  if (mainPurpsCdNm.includes('공동주택')) {
    if (haystack.includes('기숙사')) return '기숙사';
    if (grndFlrCnt >= 5) return '아파트';
    if (grndFlrCnt >= 1) return totArea > 660 ? '연립주택(빌라)' : '다세대주택(빌라)';
    return '공동주택'; // 층수 정보가 없어 세부 구분 불가
  }

  if (mainPurpsCdNm.includes('근린생활시설')) return '상가(근린생활시설)';
  if (mainPurpsCdNm.includes('업무시설')) return '업무시설';

  return mainPurpsCdNm || '확인 불가';
}

/**
 * 하나의 지번(예: "예하리 1286")에 여러 동이 함께 등록된 경우, 그중 대표로 삼을
 * 1개를 고른다.
 *  1) mainAtchGbCd(주부속구분)가 "부속건축물"(경비실·관리동·환경관리원 휴게소 등)인
 *     항목은 제외한다 — 실거주 단지 정보를 찾는 게 목적이므로 부속건물은 대표가 될 수 없다.
 *     (실제로 "다세대주택"으로 오분류됐던 사례가 있었는데, 알고 보니 17㎡짜리
 *     "환경관리원 휴게소" 부속건물이 items[0]으로 뽑혔던 것이었음)
 *  2) 주건축물끼리는 층수 → 연면적이 가장 큰 동을 대표로 사용 (가장 "단지답게" 큰 동).
 *
 * 동/호를 특정하지 않고 검색하면 이렇게 "대표 동"을 임의로 골라 보여주게 되는데,
 * 동마다 층수·면적·사용승인일이 실제로 다를 수 있어 이 사실을 화면에도 알려야 한다.
 * 그래서 대표 동뿐 아니라 후보 풀 전체(pool)와, 그 안에서 값이 실제로 갈리는지도 반환한다.
 */
function pickRepresentativeItem(items) {
  const mainOnly = items.filter((it) => it.mainAtchGbCd === '0' || it.mainAtchGbCdNm === '주건축물');
  const pool = mainOnly.length > 0 ? mainOnly : items;

  const sorted = pool.slice().sort((a, b) => {
    const floorDiff = (Number(b.grndFlrCnt) || 0) - (Number(a.grndFlrCnt) || 0);
    if (floorDiff !== 0) return floorDiff;
    return (Number(b.totArea) || 0) - (Number(a.totArea) || 0);
  });
  const item = sorted[0];

  const varies =
    pool.length > 1 &&
    pool.some(
      (it) =>
        it.grndFlrCnt !== item.grndFlrCnt || it.totArea !== item.totArea || it.useAprDay !== item.useAprDay
    );

  return { item, dongCount: pool.length, varies };
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * BUILDING_REGISTER_API_KEY 발급(공공데이터포털 승인) 전까지 사용하는 임시 목데이터.
 * 실제 건축물대장 값이 아니므로 isMock: true 로 명시하고, 프론트엔드에서 반드시
 * 별도 배지로 구분 표시한다. 키가 채워지는 즉시 이 분기는 타지 않고 실제 API로 전환된다.
 */
function buildMockInfo(buildingNameHint) {
  let buildingType = '단독주택';
  if (buildingNameHint) {
    if (buildingNameHint.includes('오피스텔')) buildingType = '오피스텔';
    else if (buildingNameHint.includes('아파트')) buildingType = '아파트';
    else buildingType = '다세대주택(빌라)';
  }

  return {
    found: true,
    isMock: true,
    buildingType,
    buildingName: buildingNameHint || '(목데이터) 건물명 미상',
    dongName: null,
    useAprDay: '1998-05-14',
    siteArea: '312.4',
    totalFloorArea: '84.97',
    groundFloors: '15',
    undergroundFloors: '2',
    dongCount: 1,
    isRepresentativeDong: false,
    representativeVaries: false,
    raw: null,
  };
}

/**
 * 도로명주소 API가 주는 sigunguCd/bjdongCd(admCd 기반, 최신 행정구역 코드)와
 * 건축물대장 API가 실제로 색인하는 코드가 어긋나는 경우가 있다 — 예를 들어
 * 2025년 인천 중구+동구가 "제물포구"로 통합되면서, juso는 새 코드(28125)를 주지만
 * 건축물대장은 아직 옛 코드(28110/중구)로만 조회된다. 이런 행정구역 개편 지역은
 * 앞으로도 계속 생길 수 있어 매번 지역별로 예외처리하는 대신, juso가 함께 주는
 * bdMgtSn(건물관리번호)의 앞 10자리(시군구5+법정동5)가 건축물대장 색인과 일치하는
 * "레거시" 코드이므로 이를 우선 사용한다. bdMgtSn이 없으면 admCd 기반 코드로 폴백.
 */
function resolveRegistryCodes({ sigunguCd, bjdongCd, bdMgtSn }) {
  if (bdMgtSn && bdMgtSn.length >= 10 && /^\d{10,}$/.test(bdMgtSn)) {
    return { sigunguCd: bdMgtSn.slice(0, 5), bjdongCd: bdMgtSn.slice(5, 10) };
  }
  return { sigunguCd, bjdongCd };
}

/**
 * 도로명주소 API 결과(sigunguCd/bjdongCd/지번)로 건축물대장 표제부를 조회해
 * 화면에 필요한 형태로 가공한다.
 */
async function getBuildingInfo({ sigunguCd, bjdongCd, lnbrMnnm, lnbrSlno, mtYn, buildingName, bdMgtSn }) {
  if (!resolveApiKey()) {
    return buildMockInfo(buildingName);
  }

  const registry = resolveRegistryCodes({ sigunguCd, bjdongCd, bdMgtSn });
  const platGbCd = mtYn === '1' ? '1' : '0';
  let usedCodes = registry;

  let items = await fetchTitleInfo({
    sigunguCd: registry.sigunguCd,
    bjdongCd: registry.bjdongCd,
    platGbCd,
    bun: lnbrMnnm,
    ji: lnbrSlno,
  });

  // bdMgtSn 기반 코드로도 못 찾았고 admCd 기반 코드와 실제로 달랐다면, 혹시 몰라
  // admCd 기반으로도 한 번 더 시도해본다 (반대 방향의 코드 불일치 가능성 대비).
  if (items.length === 0 && (registry.sigunguCd !== sigunguCd || registry.bjdongCd !== bjdongCd)) {
    usedCodes = { sigunguCd, bjdongCd };
    items = await fetchTitleInfo({ sigunguCd, bjdongCd, platGbCd, bun: lnbrMnnm, ji: lnbrSlno });
  }

  if (items.length === 0) {
    return {
      found: false,
      buildingType: '건축물대장 정보 없음 (나대지·상가·미등재 건물 등의 가능성)',
      buildingName: null,
      useAprDay: null,
      raw: null,
    };
  }

  const { item, dongCount, varies } = pickRepresentativeItem(items);

  // 대지면적은 동별 표제부가 아니라 총괄표제부(단지 전체 기준)에 있다. 단독주택 등은
  // 총괄표제부가 아예 없을 수 있어(일반건축물대장만 존재) 실패해도 무시하고 null로 둔다.
  const recapItems = await fetchRecapTitleInfo({
    sigunguCd: usedCodes.sigunguCd,
    bjdongCd: usedCodes.bjdongCd,
    platGbCd,
    bun: lnbrMnnm,
    ji: lnbrSlno,
  }).catch(() => []);
  const siteArea = recapItems[0]?.platArea || item.platArea || null;

  return {
    found: true,
    buildingType: classifyBuildingType(item),
    buildingName: item.bldNm || null,
    dongName: item.dongNm || null,
    useAprDay: formatDate(item.useAprDay),
    siteArea,
    totalFloorArea: item.totArea || null,
    groundFloors: item.grndFlrCnt || null,
    undergroundFloors: item.ugrndFlrCnt || null,
    // 동을 특정하지 않고 검색한 경우, 이 값이 "그 지번의 여러 동 중 하나(대표 동)"의
    // 값이라는 걸 화면에서 알 수 있도록 넘겨준다. dongCount>1이면 다른 동이 더 있다는
    // 뜻이고, representativeVaries는 그 동들 간 층수·면적·사용승인일이 실제로 다른지.
    dongCount,
    isRepresentativeDong: dongCount > 1,
    representativeVaries: varies,
    raw: item,
  };
}

module.exports = {
  getBuildingInfo,
};
