'use strict';

const axios = require('axios');
const { parseAddress, dedupeCandidates } = require('../utils/addressParser');

// 발급받은 승인키 유형(개별/사업자)에 따라 안내되는 호스트가 다를 수 있습니다.
// 오픈API 신청 완료 메일/마이페이지에서 안내하는 정확한 요청 URL을 확인해 필요시 이 값을 교체하세요.
const JUSO_API_URL = 'https://www.juso.go.kr/addrlink/addrLinkApi.do';

/**
 * 행정안전부 도로명주소 API로 후보 주소 목록을 조회한다.
 * 반환 필드 중 admCd(행정구역코드, 10자리) = sigunguCd(5) + bjdongCd(5) 이고,
 * lnbrMnnm/lnbrSlno 는 지번 본번/부번, bdMgtSn 은 건물관리번호(19자리)이다.
 *
 * @param {string} keyword 정제된 검색어
 * @param {number} page
 */
async function callJusoApi(keyword, page = 1) {
  const apiKey = process.env.JUSO_API_KEY;
  if (!apiKey) {
    const err = new Error('JUSO_API_KEY가 설정되지 않았습니다. .env 파일을 확인해주세요.');
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const { data } = await axios.get(JUSO_API_URL, {
    params: {
      confmKey: apiKey,
      currentPage: page,
      countPerPage: 10,
      keyword,
      resultType: 'json',
      hstryYn: 'N',
      addInfoYn: 'Y', // 지번, 건물관리번호 등 부가정보 포함
    },
    timeout: 8000,
  });

  const result = data && data.results;
  if (!result) {
    throw new Error('도로명주소 API 응답 형식이 올바르지 않습니다.');
  }
  if (result.common.errorCode !== '0') {
    const err = new Error(`도로명주소 API 오류: ${result.common.errorMessage} (${result.common.errorCode})`);
    err.code = result.common.errorCode;
    throw err;
  }

  const juso = result.juso || [];
  return juso.map((j) => ({
    roadAddr: j.roadAddr,
    jibunAddr: j.jibunAddr,
    zipNo: j.zipNo,
    buildingName: j.bdNm || null,
    admCd: j.admCd, // 10자리: sigunguCd(5) + bjdongCd(5)
    sigunguCd: j.admCd ? j.admCd.slice(0, 5) : null,
    bjdongCd: j.admCd ? j.admCd.slice(5, 10) : null,
    rn: j.rn,
    udrtYn: j.udrtYn, // 지하여부
    buldMnnm: j.buldMnnm,
    buldSlno: j.buldSlno,
    lnbrMnnm: j.lnbrMnnm, // 지번 본번
    lnbrSlno: j.lnbrSlno, // 지번 부번
    mtYn: j.mtYn, // 산 여부 (0: 대지, 1: 산)
    bdMgtSn: j.bdMgtSn || null, // 건물관리번호(19자리)
  }));
}

/**
 * 사용자가 입력한 원문 주소를 정제하고, 도로명주소 API로 후보를 조회해
 * 중복을 제거한 뒤 가장 유력한 1건 + 전체 후보 목록을 반환한다.
 *
 * 아파트명이 생략되었거나 배열이 다른 경우를 감안해, 1차 검색이 0건이면
 * 괄호로 병기된 단지명 힌트나, 지번을 뺀 도로명만으로 재검색을 시도한다.
 *
 * @param {string} rawAddress
 */
async function resolveAddress(rawAddress) {
  const parsed = parseAddress(rawAddress);

  let candidates = await callJusoApi(parsed.cleanedQuery);

  // 1차 검색 결과가 없고, 중복 지번을 떼어냈다면 원본 그대로도 한번 시도
  if (candidates.length === 0 && parsed.duplicateJibunRemoved) {
    candidates = await callJusoApi(parsed.original);
  }

  // 그래도 없으면 괄호 병기 정보(단지명 등)를 붙여 재검색
  if (candidates.length === 0 && parsed.complexNameHint) {
    candidates = await callJusoApi(`${parsed.cleanedQuery} ${parsed.complexNameHint}`);
  }

  const deduped = dedupeCandidates(candidates);

  return {
    parsed,
    candidates: deduped,
    best: deduped[0] || null,
  };
}

module.exports = {
  resolveAddress,
  callJusoApi,
};
