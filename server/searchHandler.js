'use strict';

const { resolveAddress } = require('./services/addressService');
const { getBuildingInfo } = require('./services/buildingService');
const { searchRedevelopmentInfo } = require('./services/naverService');

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

  const { parsed, candidates, best } = await resolveAddress(address);

  if (!best) {
    const err = new Error('입력한 주소와 일치하는 결과를 찾지 못했습니다. 주소를 다시 확인해주세요.');
    err.status = 404;
    err.parsed = parsed;
    throw err;
  }

  // 건축물대장은 지번 기준 조회이므로 candidate 정보만으로 바로 진행 가능
  const buildingInfoPromise = getBuildingInfo(best).catch((err) => ({
    found: false,
    error: err.message,
  }));

  // 네이버 검색은 단지명이 있으면 단지명 위주로, 없으면 지번주소 기준으로 검색
  const searchKeyword = best.buildingName || parsed.complexNameHint || best.jibunAddr;
  const naverInfoPromise = searchRedevelopmentInfo(searchKeyword).catch((err) => ({
    error: err.message,
    events: null,
    articles: [],
  }));

  const [buildingInfo, naverInfo] = await Promise.all([buildingInfoPromise, naverInfoPromise]);

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
    otherCandidates: candidates.slice(1, 5).map((c) => ({
      roadAddr: c.roadAddr,
      jibunAddr: c.jibunAddr,
      buildingName: c.buildingName,
    })),
    building: buildingInfo,
    redevelopment: naverInfo,
  };
}

module.exports = { handleSearch };
