'use strict';

const axios = require('axios');
const xml2js = require('xml2js');

// 국토교통부 건축물대장정보 서비스 (공공데이터포털)
// https://www.data.go.kr/data/15057200/openapi.do
const BASE_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService';

// 표제부(건물 전체 개요) - 건물유형/사용승인일 확인용
const TITLE_INFO_PATH = '/getBrTitleInfo';

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
 * 건축물대장 표제부 API를 호출한다.
 * platGbCd: 0(대지) / 1(산)
 */
async function fetchTitleInfo({ sigunguCd, bjdongCd, platGbCd = '0', bun, ji }) {
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
    numOfRows: 10,
    pageNo: 1,
    _type: 'json',
  };

  const { data } = await axios.get(`${BASE_URL}${TITLE_INFO_PATH}`, { params, timeout: 8000 });

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
    totalFloorArea: '84.97',
    groundFloors: '15',
    undergroundFloors: '2',
    raw: null,
  };
}

/**
 * 도로명주소 API 결과(sigunguCd/bjdongCd/지번)로 건축물대장 표제부를 조회해
 * 화면에 필요한 형태로 가공한다.
 */
async function getBuildingInfo({ sigunguCd, bjdongCd, lnbrMnnm, lnbrSlno, mtYn, buildingName }) {
  if (!resolveApiKey()) {
    return buildMockInfo(buildingName);
  }

  const items = await fetchTitleInfo({
    sigunguCd,
    bjdongCd,
    platGbCd: mtYn === '1' ? '1' : '0',
    bun: lnbrMnnm,
    ji: lnbrSlno,
  });

  if (items.length === 0) {
    return {
      found: false,
      buildingType: '건축물대장 정보 없음 (나대지·상가·미등재 건물 등의 가능성)',
      buildingName: null,
      useAprDay: null,
      raw: null,
    };
  }

  // 동이 여러 개인 경우 첫 항목을 대표로 사용(표제부는 동별로 동일한 사용승인일을 갖는 경우가 대부분)
  const item = items[0];

  return {
    found: true,
    buildingType: classifyBuildingType(item),
    buildingName: item.bldNm || null,
    dongName: item.dongNm || null,
    useAprDay: formatDate(item.useAprDay),
    totalFloorArea: item.totArea || null,
    groundFloors: item.grndFlrCnt || null,
    undergroundFloors: item.ugrndFlrCnt || null,
    raw: item,
  };
}

module.exports = {
  getBuildingInfo,
};
