'use strict';

/**
 * 사용자가 입력한 자유 형식 한국 주소 문자열을 정제한다.
 *
 * 대응하는 입력 특성:
 *  - "도로명주소 + 지번주소"가 한 문자열에 같이 들어오는 경우 (뒤쪽 지번 중복 제거)
 *  - 아파트/빌라 등 단지명 뒤에 붙는 "동 호" 표기 분리
 *  - 단지명이 없거나, 단지명 배열이 다른 경우(예: "센텀부산푸르지오" vs "부산센텀푸르지오")
 *    -> 단지명은 검색 키워드에서 별도로 분리해 보관하고, 지번/도로명 API 매칭에는
 *       영향을 주지 않도록 한다 (건축물대장은 지번 기준으로 조회되기 때문).
 */

// 동/호 표기 패턴: "101동 202호", "101-202", "제101동 제202호" 등
const DONG_HO_RE = /\s*(?:제\s*)?(\d{1,4})\s*동\s*(?:제\s*)?(\d{1,5})\s*호\s*$/;
const HO_ONLY_RE = /\s*(?:제\s*)?(\d{1,5})\s*호\s*$/;

// 지번 패턴 (예: "123-4", "산 12-3")
const JIBUN_TAIL_RE = /(산\s*)?(\d{1,5})(-(\d{1,4}))?\s*번?지?\s*$/;

// 도로명 + 건물번호 패턴 (예: "테헤란로 123", "테헤란로123길 45-6")
const ROAD_RE = /([가-힣0-9]+(?:로|길))\s*(\d{1,5}(-\d{1,4})?)/;

/**
 * 문자열에서 맨 끝의 "동 호" 또는 "호"만 분리해낸다.
 * @param {string} raw
 * @returns {{ base: string, dong: string|null, ho: string|null }}
 */
function splitDongHo(raw) {
  let base = raw.trim();
  let dong = null;
  let ho = null;

  const dongHoMatch = base.match(DONG_HO_RE);
  if (dongHoMatch) {
    dong = dongHoMatch[1];
    ho = dongHoMatch[2];
    base = base.slice(0, dongHoMatch.index).trim();
    return { base, dong, ho };
  }

  const hoMatch = base.match(HO_ONLY_RE);
  if (hoMatch) {
    ho = hoMatch[1];
    base = base.slice(0, hoMatch.index).trim();
  }

  return { base, dong, ho };
}

/**
 * 괄호 안에 병기된 단지명/지번 (예: "서울 강남구 테헤란로 123 (역삼동, OO아파트)")을 분리한다.
 */
function extractParenthetical(raw) {
  const m = raw.match(/\(([^)]+)\)/);
  if (!m) return { base: raw.replace(/\(([^)]*)\)/g, '').trim(), paren: null };
  const base = raw.replace(m[0], '').trim();
  return { base, paren: m[1].trim() };
}

/**
 * 도로명주소 뒤에 지번주소가 중복으로 붙어 있는 경우
 * (예: "서울 강남구 테헤란로 123 역삼동 736-1") 뒤쪽 지번 조각을 별도로 분리한다.
 * 도로명 패턴이 문자열 앞부분에서 이미 매칭되었는데, 그 뒤에 "동 + 숫자-숫자" 조각이
 * 추가로 남아있으면 중복 지번으로 간주한다.
 */
function splitDuplicateJibun(base) {
  const roadMatch = base.match(ROAD_RE);
  if (!roadMatch) return { base, duplicateJibun: null };

  const afterRoad = base.slice(roadMatch.index + roadMatch[0].length).trim();
  if (!afterRoad) return { base, duplicateJibun: null };

  // "역삼동 736-1" 형태로 남아있는지 확인
  const dupMatch = afterRoad.match(/^([가-힣]+동)?\s*(산\s*)?(\d{1,5}(-\d{1,4})?)\s*(번지)?$/);
  if (dupMatch) {
    const cleanBase = base.slice(0, roadMatch.index + roadMatch[0].length).trim();
    return { base: cleanBase, duplicateJibun: afterRoad };
  }

  return { base, duplicateJibun: null };
}

/**
 * 입력 주소를 정제한다.
 * @param {string} raw 사용자가 입력한 원본 주소
 * @returns {{
 *   original: string,
 *   cleanedQuery: string,   // 도로명주소 API 검색에 사용할 정제된 문자열
 *   dong: string|null,
 *   ho: string|null,
 *   complexNameHint: string|null, // 괄호 등으로 병기된 단지명 후보 (검색 API 실패 시 보조용)
 *   duplicateJibunRemoved: string|null
 * }}
 */
function parseAddress(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('주소를 입력해주세요.');
  }

  let text = raw.replace(/\s+/g, ' ').trim();

  // 1) 괄호 병기 정보 분리 (단지명/법정동 등 보조정보로 활용, 검색 문자열에서는 제거)
  const { base: withoutParen, paren } = extractParenthetical(text);
  text = withoutParen;

  // 2) 동/호 표기 분리
  const { base: withoutDongHo, dong, ho } = splitDongHo(text);
  text = withoutDongHo;

  // 3) 도로명주소 뒤 중복 지번 제거
  const { base: dedupedBase, duplicateJibun } = splitDuplicateJibun(text);
  text = dedupedBase;

  const cleanedQuery = text.replace(/\s+/g, ' ').trim();

  return {
    original: raw.trim(),
    cleanedQuery,
    dong,
    ho,
    complexNameHint: paren,
    duplicateJibunRemoved: duplicateJibun,
  };
}

/**
 * 도로명주소 API 후보 결과 목록에서 동일 건물을 가리키는 중복 항목을 제거한다.
 * 도로명주소(roadAddr)와 지번주소(jibunAddr)가 모두 같으면 같은 건물로 간주.
 * @param {Array<{roadAddr: string, jibunAddr: string}>} candidates
 */
function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const c of candidates) {
    const key = `${(c.roadAddr || '').replace(/\s+/g, '')}|${(c.jibunAddr || '').replace(/\s+/g, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

module.exports = {
  parseAddress,
  dedupeCandidates,
};
