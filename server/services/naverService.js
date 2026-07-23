'use strict';

const axios = require('axios');

const SEARCH_BASE_URL = 'https://openapi.naver.com/v1/search';

/**
 * 네이버 검색 API(뉴스/블로그) 호출.
 * @param {'news'|'blog'} type
 * @param {string} query
 */
async function searchNaver(type, query, display = 20) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 설정되지 않았습니다. .env 파일을 확인해주세요.');
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const { data } = await axios.get(`${SEARCH_BASE_URL}/${type}.json`, {
    params: { query, display, sort: 'sim' },
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    },
    timeout: 8000,
  });

  return (data.items || []).map((item) => ({
    title: stripHtml(item.title),
    description: stripHtml(item.description),
    link: item.originallink || item.link,
    pubDate: item.pubdate || item.postdate || null,
    source: type,
  }));
}

function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

// "2023.5.12" / "2023-05-12" / "2023년 5월 12일" / "23.05.12" 뿐 아니라
// 뉴스/블로그 요약에서 흔한 "2018년 7월"처럼 일(day)이 생략된 형태도 인식한다.
const DATE_RE = /(\d{2,4})[.\-년]\s*(\d{1,2})[.\-월]\s*(\d{1,2})?\s*일?/g;

function normalizeDate(y, m, d) {
  let year = y.length === 2 ? Number(`20${y}`) : Number(y);
  const month = String(m).padStart(2, '0');
  if (year < 1980 || year > 2100) return null;
  if (!d) return `${year}-${month}`; // 일자 미상 - 연/월까지만 제공
  const day = String(d).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const EVENT_KEYWORD_MAP = {
  managementDisposalApproval: ['관리처분인가', '관리처분계획인가', '관리처분 인가'],
  projectImplementationApproval: ['사업시행인가', '사업시행계획인가', '사업시행 인가'],
  subscriptionWin: ['청약 당첨', '당첨자 발표', '분양 당첨'],
  memberSuccession: ['조합원 승계', '조합원지위 승계', '조합원 지위승계', '조합원 지위 양도'],
};

// 뉴스/블로그에는 "조합설립인가 2014.5.15 완료 사업시행인가 2024.5.30 완료 관리처분인가 2026.6.26 완료"
// 처럼 여러 정비사업 단계 날짜가 한 문장에 나란히 나오는 경우가 많다. 이런 문장에서 날짜를
// 엉뚱한 단계(EVENT_KEYWORD_MAP에 없는 키워드)에 잘못 배정하지 않도록, 추적 대상이 아닌
// 인접 단계 키워드도 "거리 비교용"으로만 함께 등록해둔다.
const DISTRACTOR_KEYWORDS = [
  '조합설립인가', '조합설립', '추진위원회', '안전진단', '구역지정', '정비구역', '정비계획',
  '착공', '준공', '입주', '이주', '철거', '시공사 선정', '분양신청', '구역 지정',
];

const MAX_KEYWORD_DATE_DISTANCE = 45; // 문자 거리 기준 최대 허용 간격

function findAllOccurrences(text, keyword) {
  const positions = [];
  let idx = text.indexOf(keyword);
  while (idx !== -1) {
    positions.push({ start: idx, end: idx + keyword.length, keyword });
    idx = text.indexOf(keyword, idx + keyword.length);
  }
  return positions;
}

function charDistance(a, b) {
  if (a.end <= b.start) return b.start - a.end;
  if (b.end <= a.start) return a.start - b.end;
  return 0; // 겹치는 경우
}

/**
 * 텍스트 전체를 대상으로, 각 날짜가 "가장 가까운" 키워드(추적 대상 + 인접 단계 방해 키워드
 * 모두 포함)에만 배정되도록 한다. 가장 가까운 키워드가 추적 대상이 아니거나 거리가 너무 멀면
 * 해당 날짜는 버린다.
 * @param {string} text
 * @param {Record<string, string[]>} keywordMap 추적할 이벤트타입 -> 키워드 목록
 * @param {string[]} distractorKeywords 거리 비교에만 쓰는 방해 키워드(추적 안 함)
 */
function extractEventsFromText(text, keywordMap, distractorKeywords) {
  const keywordHits = [];
  for (const [eventType, keywords] of Object.entries(keywordMap)) {
    for (const kw of keywords) {
      for (const pos of findAllOccurrences(text, kw)) {
        keywordHits.push({ ...pos, eventType });
      }
    }
  }
  for (const kw of distractorKeywords) {
    for (const pos of findAllOccurrences(text, kw)) {
      keywordHits.push({ ...pos, eventType: null });
    }
  }

  if (keywordHits.length === 0) return [];

  const results = [];
  DATE_RE.lastIndex = 0;
  let dm;
  while ((dm = DATE_RE.exec(text)) !== null) {
    const date = normalizeDate(dm[1], dm[2], dm[3]);
    if (!date) continue;

    const datePos = { start: dm.index, end: dm.index + dm[0].length };
    let nearest = null;
    let nearestDist = Infinity;
    for (const hit of keywordHits) {
      const dist = charDistance(datePos, hit);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = hit;
      }
    }

    if (!nearest || nearest.eventType === null || nearestDist > MAX_KEYWORD_DATE_DISTANCE) continue;

    const windowStart = Math.max(0, Math.min(nearest.start, datePos.start) - 10);
    const windowEnd = Math.min(text.length, Math.max(nearest.end, datePos.end) + 10);
    const snippet = text.slice(windowStart, windowEnd).trim();

    results.push({
      eventType: nearest.eventType,
      keyword: nearest.keyword,
      date,
      hasChangeMarker: /변경|수정|정정/.test(snippet),
      snippet,
    });
  }

  return results;
}

/**
 * 뉴스/블로그 검색 결과에서 재건축/재개발 관련 이벤트 날짜를 휴리스틱하게 추출한다.
 * 정규식/키워드 기반 텍스트 마이닝이므로 100% 정확하지 않으며, 반드시 원문(link)으로
 * 교차 확인해야 한다 — 결과에 원문 리스트를 함께 반환하는 이유.
 */
function extractRedevelopmentEvents(articles) {
  const eventsByType = {
    managementDisposalApproval: [],
    projectImplementationApproval: [],
    subscriptionWin: [],
    memberSuccession: [],
  };

  for (const article of articles) {
    const text = `${article.title} ${article.description}`;
    const found = extractEventsFromText(text, EVENT_KEYWORD_MAP, DISTRACTOR_KEYWORDS);
    for (const f of found) {
      eventsByType[f.eventType].push({
        ...f,
        title: article.title,
        link: article.link,
        pubDate: article.pubDate,
        sourceType: article.source,
      });
    }
  }

  // 이벤트 타입별 날짜순 정렬 + 동일 날짜 중복 제거
  for (const key of Object.keys(eventsByType)) {
    const dedupedMap = new Map();
    for (const ev of eventsByType[key]) {
      const dedupKey = `${ev.date}|${ev.link}`;
      if (!dedupedMap.has(dedupKey)) dedupedMap.set(dedupKey, ev);
    }
    eventsByType[key] = Array.from(dedupedMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  const managementDisposal = eventsByType.managementDisposalApproval;

  return {
    managementDisposalApproval: {
      initial: managementDisposal[0] || null,
      changes: managementDisposal.slice(1),
    },
    projectImplementationApproval: eventsByType.projectImplementationApproval[0] || null,
    subscriptionWin: eventsByType.subscriptionWin[0] || null,
    memberSuccession: eventsByType.memberSuccession[0] || null,
    allEvents: eventsByType,
  };
}

// 검색어에 지역명을 붙이기 위한 시/도 축약 표기 (뉴스·블로그에서 흔히 쓰는 표현에 맞춤)
const SIDO_SHORT_MAP = {
  '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
  '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종',
  '경기도': '경기', '강원특별자치도': '강원', '강원도': '강원',
  '충청북도': '충북', '충청남도': '충남',
  '전북특별자치도': '전북', '전라북도': '전북', '전라남도': '전남',
  '경상북도': '경북', '경상남도': '경남', '제주특별자치도': '제주',
};
const ALL_SIDO_SHORT_NAMES = [...new Set(Object.values(SIDO_SHORT_MAP))];

/**
 * 지번주소(예: "서울특별시 성북구 종암동 123-4")에서 시/도·시군구·읍면동을 뽑아
 * 검색어에 붙일 지역 문자열("서울 성북구 종암동")을 만든다.
 * "종암아이파크"처럼 전국에 같은/유사한 이름의 단지가 있는 경우, 지역명 없이
 * 단지명만으로 검색하면 엉뚱한 지역의 글이 섞여 들어오기 때문에 반드시 붙인다.
 */
function extractRegionTokens(jibunAddr) {
  if (!jibunAddr) return { sido: '', sigungu: '', dong: '', queryRegion: '' };
  const tokens = jibunAddr.trim().split(/\s+/);
  const sidoRaw = tokens[0] || '';
  const sido = SIDO_SHORT_MAP[sidoRaw] || sidoRaw;
  const sigungu = tokens[1] || '';
  const dong = tokens[2] && /(동|읍|면|가)$/.test(tokens[2]) ? tokens[2] : '';
  const queryRegion = [sido, sigungu, dong].filter(Boolean).join(' ');
  return { sido, sigungu, dong, queryRegion };
}

/**
 * 검색 결과 텍스트가 다른 지역(우리 지역명은 전혀 언급 없이, 다른 시/도명만 언급)에
 * 관한 글로 보이면 true.
 */
function isLikelyWrongRegion(text, region) {
  if (!region.sido) return false;
  const mentionsOwnRegion = text.includes(region.sido) || (region.sigungu && text.includes(region.sigungu));
  if (mentionsOwnRegion) return false;
  return ALL_SIDO_SHORT_NAMES.some((name) => name !== region.sido && text.includes(name));
}

// 검색어에서 "지역명이 아닌, 이 단지를 특정 짓는 키워드"만 뽑아낸다.
// "재개발/재건축/아파트/빌라" 같은 범용 단어와 순수 숫자(번지)는 제외 — 이런 단어만으로는
// 다른 정비구역 글까지 다 걸리므로 실제로 변별력 있는 토큰(예: "아이파크")만 남긴다.
const GENERIC_WORDS = new Set([
  '아파트', '빌라', '연립주택', '다세대주택', '오피스텔', '단독주택', '다가구주택',
  '재건축', '재개발', '주택', '동', '단지',
]);

function extractDistinctiveTokens(keyword, region) {
  if (!keyword) return [];
  const regionTokens = new Set([region.sido, region.sigungu, region.dong].filter(Boolean));
  return keyword
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^\d+(-\d+)?$/.test(t)) // 순수 숫자(번지) 제외
    .filter((t) => !regionTokens.has(t) && !GENERIC_WORDS.has(t));
}

/**
 * 이 글이 "우리가 찾는 그 건물"에 관한 글인지 판단한다.
 * 1) 다른 지역(시/도) 얘기면 탈락
 * 2) 동(읍/면) 이름이 있는데 언급이 전혀 없으면 탈락 — 같은 구라도 다른 동/다른 정비구역
 *    (예: "봉천4-1-3구역")의 관리처분인가 소식이 엉뚱하게 섞이는 걸 막기 위함
 * 3) 단지명에서 뽑은 변별력 있는 토큰(예: "아이파크")이 하나도 안 나오면 탈락 —
 *    같은 동이어도 "종암동 3-10 일대" 같은 별개 정비사업과 헷갈리지 않도록
 * 위 기준으로 걸러낼 게 아무것도 없으면(지역/단지명 정보 부족) 그냥 통과시킨다.
 */
function isRelevantArticle(text, region, distinctiveTokens) {
  if (isLikelyWrongRegion(text, region)) return false;

  if (region.dong) {
    const dongRoot = region.dong.replace(/(동|읍|면|가)$/, '');
    if (dongRoot && !text.includes(dongRoot)) return false;
  }

  if (distinctiveTokens.length > 0 && !distinctiveTokens.some((t) => text.includes(t))) return false;

  return true;
}

/**
 * 주소(단지명 포함 가능) 기준으로 재건축/재개발 관련 뉴스+블로그를 검색하고
 * 이벤트를 추출한다.
 * @param {string} keyword 단지명 또는 지번주소 (예: "종암아이파크")
 * @param {string} [jibunAddr] 지번주소 — 지역명을 뽑아 검색어에 강제로 포함시키기 위해 사용
 */
async function searchRedevelopmentInfo(keyword, jibunAddr) {
  const region = extractRegionTokens(jibunAddr);
  const queryPrefix = region.queryRegion ? `${region.queryRegion} ` : '';
  const query = `${queryPrefix}${keyword} 재건축 OR 재개발 OR 관리처분인가 OR 사업시행인가`;

  const [news, blog] = await Promise.all([
    searchNaver('news', query, 20).catch(() => []),
    searchNaver('blog', query, 20).catch(() => []),
  ]);

  const distinctiveTokens = extractDistinctiveTokens(keyword, region);
  let articles = [...news, ...blog];
  articles = articles.filter((a) => isRelevantArticle(`${a.title} ${a.description}`, region, distinctiveTokens));

  const events = extractRedevelopmentEvents(articles);

  return {
    query,
    articleCount: articles.length,
    events,
    articles, // 사람이 직접 교차 확인할 수 있도록 원문 리스트도 함께 제공
  };
}

// 사용승인일/준공일 전용 키워드. 재건축 검색("재건축 OR 재개발 OR ...")과는 별도 검색이
// 필요하다 — 재건축 중이 아닌 대다수의 평범한 단지는 그 쿼리로는 아예 걸리는 글이 없기 때문.
const USE_APPROVAL_KEYWORD_MAP = {
  useApprovalDate: ['사용승인일', '사용승인', '준공승인일', '준공일', '준공승인', '준공인가'],
};
// 착공일 등 인접 날짜가 준공일로 잘못 배정되지 않도록 거리 비교용으로만 등록
const USE_APPROVAL_DISTRACTORS = ['착공일', '착공', '설계', '분양', '입주예정', '입주 예정'];

/**
 * 네이버 뉴스/블로그에서 "사용승인일/준공일" 언급을 찾는다.
 * 건축물대장 API보다 이쪽 값을 우선 노출해달라는 요청에 따른 보조 조회 — 다만 이것도
 * 결국 텍스트에서 정규식으로 날짜를 추출하는 휴리스틱이라는 점은 동일하다 (100% 정확 X).
 * 네이버부동산/네이버지도가 보여주는 값은 비공개 API라 직접 가져올 방법이 없어서,
 * 이 위키가 이미 쓰고 있는 네이버 검색 오픈API(뉴스/블로그)로 최대한 근접하게 흉내낸 것.
 *
 * @param {string} keyword
 * @param {string} [jibunAddr]
 * @returns {Promise<{date:string, title:string, link:string, snippet:string}|null>}
 */
async function searchUseApprovalDate(keyword, jibunAddr) {
  const region = extractRegionTokens(jibunAddr);
  const queryPrefix = region.queryRegion ? `${region.queryRegion} ` : '';
  const query = `${queryPrefix}${keyword} 사용승인일 OR 준공일 OR 준공승인`;

  const [news, blog] = await Promise.all([
    searchNaver('news', query, 20).catch(() => []),
    searchNaver('blog', query, 20).catch(() => []),
  ]);

  const distinctiveTokens = extractDistinctiveTokens(keyword, region);
  const articles = [...news, ...blog].filter((a) =>
    isRelevantArticle(`${a.title} ${a.description}`, region, distinctiveTokens)
  );

  // 검색 결과는 관련도순(sort=sim)으로 오므로, 가장 먼저 매칭되는 걸 채택한다
  // (여러 날짜 중 임의로 "가장 이른 날짜"를 고르면 오히려 무관한 매칭을 주울 위험이 있음).
  for (const article of articles) {
    const text = `${article.title} ${article.description}`;
    const found = extractEventsFromText(text, USE_APPROVAL_KEYWORD_MAP, USE_APPROVAL_DISTRACTORS);
    const hit = found.find((f) => f.eventType === 'useApprovalDate');
    if (hit) {
      return {
        date: hit.date,
        title: article.title,
        link: article.link,
        pubDate: article.pubDate,
        sourceType: article.source,
        snippet: hit.snippet,
      };
    }
  }

  return null;
}

module.exports = {
  searchRedevelopmentInfo,
  searchUseApprovalDate,
};
