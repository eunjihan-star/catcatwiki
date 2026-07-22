'use strict';

const { resolveAddress } = require('./services/addressService');
const { getBuildingInfo } = require('./services/buildingService');
const { searchRedevelopmentInfo } = require('./services/naverService');

// 이 위키는 "거주용 건물" 정보만 다룬다. 상가/업무시설 등 비주거 건물의 사용승인일·면적을
// 정확히 알려주는 건 애초에 목적이 아니므로, 그런 건물이 걸리면 상세 정보를 보여주는 대신
// "찾으시는 게 맞는지" 정도만 알려주면 된다 — 정확한 상가 정보 재현은 불필요.
const RESIDENTIAL_BUILDING_TYPES = new Set([
  '아파트', '연립주택(빌라)', '다세대주택(빌라)', '다가구주택', '단독주택', '기숙사', '오피스텔', '공동주택',
]);
const MAX_CANDIDATES_TO_PROBE = 6; // 건축물대장 API 호출 횟수를 제한하기 위한 상한

/**
 * 도로명주소 API가 같은 단지명으로 여러 후보(동별로 별개 지번)를 돌려줄 때,
 * 그중 상가/관리동 등 비주거 건물이 1번 후보로 잡히는 경우가 있다
 * (예: "압구정 현대아파트" 1번 후보가 "현대상가제2동"). 실제 주거용 건물이
 * 나올 때까지 상위 후보를 순서대로 시도한다.
 *
 * 끝까지 주거용을 못 찾으면, 비주거 건물의 상세 정보를 정확히 보여주는 대신
 * "주거용 건물을 찾지 못함" 상태로 응답한다 — 상가 정보를 정밀하게 재현할 필요는
 * 없고, 찾는 주소가 주거용이 맞는지만 알려주면 충분하기 때문.
 */
async function pickResidentialCandidate(candidates) {
  const pool = candidates.slice(0, MAX_CANDIDATES_TO_PROBE);
  let firstCandidate = null;

  for (const candidate of pool) {
    const info = await getBuildingInfo(candidate).catch((err) => ({ found: false, error: err.message }));
    if (!firstCandidate) firstCandidate = candidate;
    if (info.found && RESIDENTIAL_BUILDING_TYPES.has(info.buildingType)) {
      return { candidate, info };
    }
  }

  return {
    candidate: firstCandidate,
    info: {
      found: false,
      buildingType: '이 주소 주변에서 거주용 건물을 찾지 못했습니다 (상가·업무시설 등 비주거 건물만 확인됨). 주소를 다시 확인해주세요.',
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
 * @returns {Promise<object>} 응답 바디로 그대로 내려줄 결과 객체
 * @throws {Error & { status?: number, parsed?: object }}
 */
async function handleSearch(address) {
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

  // 건축물대장은 지번 기준 조회. 대단지는 후보가 여러 개일 수 있어 주거용 건물이
  // 나올 때까지 순회한 뒤, 그 후보를 이후 응답(주소 표시, 네이버 검색어)에도 일관되게 사용한다.
  const { candidate: best, info: buildingInfo } = await pickResidentialCandidate(candidates);

  // 네이버 검색은 단지명이 있으면 단지명 위주로, 없으면 지번주소 기준으로 검색.
  // 지번주소는 검색어에 지역명(시/군/구/동)을 강제로 붙이는 데 별도로 사용된다 —
  // 그래야 "종암아이파크"처럼 흔한 브랜드명이 다른 지역 결과와 섞이지 않는다.
  const searchKeyword = best.buildingName || parsed.complexNameHint || best.jibunAddr;
  const naverInfo = await searchRedevelopmentInfo(searchKeyword, best.jibunAddr).catch((err) => ({
    error: err.message,
    events: null,
    articles: [],
  }));

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
