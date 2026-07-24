'use strict';

const { resolveAddress } = require('./services/addressService');
const { getBuildingInfo } = require('./services/buildingService');
const { searchRedevelopmentInfo, searchUseApprovalDate } = require('./services/naverService');

// 이 위키는 "거주용 건물" 정보만 다룬다. 상가/업무시설 등 비주거 건물의 사용승인일·면적을
// 정확히 알려주는 건 애초에 목적이 아니므로, 그런 건물이 걸리면 상세 정보를 보여주는 대신
// "찾으시는 게 맞는지" 정도만 알려주면 된다 — 정확한 상가 정보 재현은 불필요.
const RESIDENTIAL_BUILDING_TYPES = new Set([
  '아파트', '연립주택(빌라)', '다세대주택(빌라)', '다가구주택', '단독주택', '기숙사', '오피스텔', '공동주택',
]);
const MAX_CANDIDATES_TO_PROBE = 6; // 건축물대장 API 호출 횟수를 제한하기 위한 상한

// 검색창 하단 "건물유형 체크박스"가 보내는 그룹 키 -> 실제 classifyBuildingType() 라벨.
// 양도세 신고서상 코드는 맞는데 실제로는 집이 아니거나 다른 유형인 극소수 사례를 걸러내기
// 위해, 사용자가 미리 기대하는 유형을 체크하면 그 유형에 맞는 후보만 채택한다.
const BUILDING_TYPE_GROUPS = {
  apartment: ['아파트'],
  villa: ['연립주택(빌라)', '다세대주택(빌라)'],
  officetel: ['오피스텔'],
  house: ['단독주택', '다가구주택'],
};

function expandExpectedTypes(groupKeys) {
  if (!Array.isArray(groupKeys) || groupKeys.length === 0) return null;
  const labels = new Set();
  for (const key of groupKeys) {
    (BUILDING_TYPE_GROUPS[key] || []).forEach((label) => labels.add(label));
  }
  return labels.size > 0 ? labels : null;
}

/**
 * 도로명주소 API가 같은 단지명으로 여러 후보(동별로 별개 지번)를 돌려줄 때,
 * 그중 상가/관리동 등 비주거 건물이 1번 후보로 잡히는 경우가 있다
 * (예: "압구정 현대아파트" 1번 후보가 "현대상가제2동"). 사용자가 기대하는 건물유형이
 * (체크박스로) 지정되어 있으면 그 유형에 맞는 후보가, 없으면 아무 주거용 건물이나
 * 나올 때까지 상위 후보를 순서대로 시도한다.
 *
 * @param {Set<string>|null} wantedTypes 체크박스로 지정된 기대 유형 (null이면 "전체"/제한 없음)
 */
async function pickResidentialCandidate(candidates, wantedTypes) {
  const pool = candidates.slice(0, MAX_CANDIDATES_TO_PROBE);
  const acceptTypes = wantedTypes || RESIDENTIAL_BUILDING_TYPES;

  let firstWrongType = null; // 주거용은 맞는데 체크한 유형과는 다른 첫 후보
  let firstNonResidential = null; // 아예 비주거인 첫 후보
  let firstApiError = null; // API 호출 자체가 실패한 경우 (일시적 오류 등)

  for (const candidate of pool) {
    let info;
    try {
      info = await getBuildingInfo(candidate);
    } catch (err) {
      if (!firstApiError) firstApiError = err;
      continue;
    }
    if (info.found && acceptTypes.has(info.buildingType)) {
      return { candidate, info };
    }
    if (info.found && RESIDENTIAL_BUILDING_TYPES.has(info.buildingType)) {
      if (!firstWrongType) firstWrongType = { candidate, info };
    } else if (!firstNonResidential) {
      firstNonResidential = { candidate, info };
    }
  }

  // 체크박스로 특정 유형을 기대했는데 실제로는 다른 주거용 유형이 확인된 경우:
  // "못 찾음"이 아니라 "체크한 것과 다르다"고 명확히 알려준다 — 양도세 코드 오류나
  // 주소 오기재를 사용자가 스스로 걸러낼 수 있는 지점이기 때문에 이게 핵심 기능이다.
  if (wantedTypes && firstWrongType) {
    return {
      candidate: firstWrongType.candidate,
      info: {
        found: false,
        buildingType: `체크하신 유형과 다릅니다 — 이 주소에서 실제 확인된 건물유형은 "${firstWrongType.info.buildingType}"입니다. 체크한 유형이나 주소가 맞는지 다시 확인해주세요 (양도세 코드가 실제 건물과 다르게 신고됐을 가능성도 있습니다).`,
        buildingName: null,
        useAprDay: null,
        raw: null,
        actualType: firstWrongType.info.buildingType,
      },
    };
  }

  // 주거용 건물 자체를 못 찾은 경우 (체크 유형 무관): "찾는 게 맞는지"만 알려준다
  const nonMatch = firstWrongType || firstNonResidential;
  if (nonMatch) {
    return {
      candidate: nonMatch.candidate,
      info: {
        found: false,
        buildingType: '이 주소 주변에서 거주용 건물을 찾지 못했습니다 (상가·업무시설 등 비주거 건물만 확인됨). 주소를 다시 확인해주세요.',
        buildingName: null,
        useAprDay: null,
        raw: null,
      },
    };
  }

  // 모든 후보에서 API 호출 자체가 실패한 경우 - "못 찾음"이 아니라 실제 오류를 알려줘야
  // 사용자가 주소가 틀렸다고 오해하지 않는다 (예: 공공데이터포털 일시 오류).
  return {
    candidate: pool[0],
    info: {
      found: false,
      buildingType: `건축물대장 조회 중 오류가 발생했습니다: ${firstApiError ? firstApiError.message : '알 수 없는 오류'}`,
      buildingName: null,
      useAprDay: null,
      raw: null,
    },
  };
}

// 도로명("선수촌로" 등)도, 아파트 브랜드명("한양아파트" 등)도 전국 여러 시/군/구에
// 동일한 이름이 존재할 수 있다. 이 경우 juso 후보들이 서로 다른 시군구코드로 갈라져서
// 나오는데, 그중 아무거나(candidates[0])를 골라버리면 완전히 엉뚱한 지역의 건물유형·
// 사용승인일·재건축 정보를 "그 주소 정보"인 것처럼 보여주게 된다. 서로 다른 시/군/구가
// 섞여 있으면 특정 불가로 보고 검색을 거부하고, 어떤 지역들이 걸렸는지 알려준다.
function describeRegion(candidate) {
  const tokens = (candidate.roadAddr || candidate.jibunAddr || '').trim().split(/\s+/);
  return [tokens[0], tokens[1]].filter(Boolean).join(' ');
}

function assertUnambiguousRegion(candidates) {
  const distinctSigungu = new Set(candidates.map((c) => c.sigunguCd).filter(Boolean));
  if (distinctSigungu.size <= 1) return;

  const seen = new Set();
  const regionList = [];
  for (const c of candidates) {
    const label = describeRegion(c);
    if (label && !seen.has(label)) {
      seen.add(label);
      regionList.push(label);
    }
    if (regionList.length >= 5) break;
  }

  const err = new Error(
    `입력하신 주소/건물명이 여러 지역에서 검색됩니다 (${regionList.join(', ')}${distinctSigungu.size > regionList.length ? ' 등' : ''}). ` +
    `동일한 이름의 도로·아파트가 여러 시/군/구에 있을 수 있어 정확한 지역을 특정할 수 없습니다. ` +
    `시/도·시/군/구까지 포함해서 다시 검색해주세요 (예: "서울 강남구 ○○아파트").`
  );
  err.status = 422;
  err.ambiguousRegions = regionList;
  throw err;
}

/**
 * 주소 검색 오케스트레이션 로직 — Express 라우트(로컬 개발)와 Vercel 서버리스
 * 함수(배포)가 이 함수 하나를 공유한다. HTTP 프레임워크에 대한 의존이 없어야
 * 두 환경 모두에서 동일하게 재사용 가능하다.
 *
 * @param {string} address
 * @param {string[]} [buildingTypeGroups] 검색창 하단 체크박스로 지정한 기대 건물유형
 *   그룹 키 배열 (예: ['apartment']). 비어있거나 생략하면 제한 없음("전체").
 * @returns {Promise<object>} 응답 바디로 그대로 내려줄 결과 객체
 * @throws {Error & { status?: number, parsed?: object }}
 */
async function handleSearch(address, buildingTypeGroups) {
  if (!address || !address.trim()) {
    const err = new Error('주소를 입력해주세요.');
    err.status = 400;
    throw err;
  }

  const { parsed, candidates, best: firstCandidate } = await resolveAddress(address);

  if (!firstCandidate) {
    const err = new Error('입력한 주소와 일치하는 결과를 찾지 못했습니다. 주소를 다시 확인해주세요.');
    err.status = 404;
    err.parsed = parsed;
    throw err;
  }

  assertUnambiguousRegion(candidates);

  const wantedTypes = expandExpectedTypes(buildingTypeGroups);

  // 건축물대장은 지번 기준 조회. 대단지는 후보가 여러 개일 수 있어 주거용 건물이
  // 나올 때까지 순회한 뒤, 그 후보를 이후 응답(주소 표시, 네이버 검색어)에도 일관되게 사용한다.
  const { candidate: best, info: buildingInfo } = await pickResidentialCandidate(candidates, wantedTypes);

  // 단지명(아파트/오피스텔 등)이 있으면 그 이름으로, 없으면(단독주택 등) 번지로 검색한다.
  // 번지는 지역명(시/군/구/동)과 별도로 붙는데, 예전엔 여기에 jibunAddr 전체를 넣어서
  // "경기 부천시 소사구 소사본동 경기도 부천시 소사구 소사본동 286-23" 처럼 지역명이
  // 중복 삽입되는 버그가 있었다 — 번지만 깔끔하게 뽑아 쓴다.
  const bunji = best.lnbrMnnm
    ? `${Number(best.lnbrMnnm)}${best.lnbrSlno && Number(best.lnbrSlno) !== 0 ? `-${Number(best.lnbrSlno)}` : ''}`
    : '';
  const searchKeyword = best.buildingName || parsed.complexNameHint || bunji || best.jibunAddr;

  // 단지명이 없는 일반 주소(단독주택 등)는 "동" 단위 필터만으로는 부족하다 — 같은 동 안에
  // "OO본동 1구역", "OO본동 3구역"처럼 서로 다른 재개발구역이 동시에 진행되는 경우가 흔해서,
  // 정확한 번지가 본문에 언급된 기사만 인정하도록 강제한다 (아래 함수 설명 참고).
  const requiredBunji = !best.buildingName && !parsed.complexNameHint && bunji ? bunji : undefined;

  const [naverInfo, naverApproval] = await Promise.all([
    searchRedevelopmentInfo(searchKeyword, best.jibunAddr, requiredBunji).catch((err) => ({
      error: err.message,
      events: null,
      articles: [],
    })),
    searchUseApprovalDate(searchKeyword, best.jibunAddr, requiredBunji).catch(() => null),
  ]);

  // 사용승인일: 건축물대장 값이 있으면 그걸 주(main) 표시값으로 쓰고, 네이버 검색에서
  // 찾은 값은 참고/교차확인용으로 함께 내려준다 (네이버 단독 신뢰는 위험 — 은마아파트
  // 테스트에서 명백히 틀린 날짜를 집어온 사례가 있었음, 아래 useAprDayMismatch 참고).
  //
  // 다만 건축물대장 조회 자체가 실패한 경우(비주거 판정·API 오류 등)에도 네이버에서
  // 사용승인일을 찾았다면 절대 숨기지 않는다 — 이 서비스의 최우선순위는 "사용승인일을
  // 보여주는 것"이다. 건축물대장이 안 되면 네이버 값이라도 메인으로 노출한다.
  if (naverApproval) {
    buildingInfo.useAprDayNaver = naverApproval.date;
    buildingInfo.useAprDayNaverLink = naverApproval.link;
    buildingInfo.useAprDayNaverTitle = naverApproval.title;
    if (buildingInfo.found) {
      buildingInfo.useAprDaySource = 'official';
      buildingInfo.useAprDayMismatch = naverApproval.date.slice(0, 10) !== (buildingInfo.useAprDay || '').slice(0, 10);
    } else {
      // 건축물대장 실패 시 네이버 값을 메인으로 승격
      buildingInfo.useAprDay = naverApproval.date;
      buildingInfo.useAprDaySource = 'naver-only';
    }
  } else if (buildingInfo.found) {
    buildingInfo.useAprDaySource = 'official';
  }

  return {
    input: {
      original: parsed.original,
      cleanedQuery: parsed.cleanedQuery,
      dong: parsed.dong,
      ho: parsed.ho,
      duplicateJibunRemoved: parsed.duplicateJibunRemoved,
    },
    address: {
      roadAddr: best.roadAddr,
      jibunAddr: best.jibunAddr,
      buildingName: best.buildingName,
      zipNo: best.zipNo,
    },
    candidateCount: candidates.length,
    otherCandidates: candidates
      .filter((c) => c !== best)
      .slice(0, 4)
      .map((c) => ({
        roadAddr: c.roadAddr,
        jibunAddr: c.jibunAddr,
        buildingName: c.buildingName,
      })),
    building: buildingInfo,
    redevelopment: naverInfo,
  };
}

module.exports = { handleSearch };
