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

  const wantedTypes = expandExpectedTypes(buildingTypeGroups);

  // 건축물대장은 지번 기준 조회. 대단지는 후보가 여러 개일 수 있어 주거용 건물이
  // 나올 때까지 순회한 뒤, 그 후보를 이후 응답(주소 표시, 네이버 검색어)에도 일관되게 사용한다.
  const { candidate: best, info: buildingInfo } = await pickResidentialCandidate(candidates, wantedTypes);

  // 네이버 검색은 단지명이 있으면 단지명 위주로, 없으면 지번주소 기준으로 검색.
  // 지번주소는 검색어에 지역명(시/군/구/동)을 강제로 붙이는 데 별도로 사용된다 —
  // 그래야 "종암아이파크"처럼 흔한 브랜드명이 다른 지역 결과와 섞이지 않는다.
  const searchKeyword = best.buildingName || parsed.complexNameHint || best.jibunAddr;
  const [naverInfo, naverApproval] = await Promise.all([
    searchRedevelopmentInfo(searchKeyword, best.jibunAddr).catch((err) => ({
      error: err.message,
      events: null,
      articles: [],
    })),
    searchUseApprovalDate(searchKeyword, best.jibunAddr).catch(() => null),
  ]);

  // 사용승인일: 건축물대장 값을 계속 주(main) 표시값으로 유지하고, 네이버 검색에서 찾은
  // 값은 "참고/교차확인용"으로 별도 필드에 함께 내려준다 — 네이버 값이 더 정확할 거라는
  // 요청으로 실제 우선 노출을 시도해봤지만, 은마아파트(1979년 준공) 테스트에서 네이버가
  // "사용승인일 2000년 07월 31일"이라는 명백히 틀린 날짜를 집어와 검증에 실패했다.
  // 정규식 텍스트 추출이라는 한계는 관리처분인가 등과 동일하게 적용되므로, 사용승인일처럼
  // 하나의 정답만 있는 값을 뉴스/블로그 스크래핑으로 "최우선" 신뢰하는 건 위험 — 특히 이
  // 값이 양도세 취득일 판단 등에 쓰일 수 있는 맥락에서는 더더욱.
  if (buildingInfo.found) {
    buildingInfo.useAprDaySource = 'official';
    if (naverApproval) {
      buildingInfo.useAprDayNaver = naverApproval.date;
      buildingInfo.useAprDayNaverLink = naverApproval.link;
      buildingInfo.useAprDayNaverTitle = naverApproval.title;
      buildingInfo.useAprDayMismatch = naverApproval.date.slice(0, 10) !== (buildingInfo.useAprDay || '').slice(0, 10);
    }
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
