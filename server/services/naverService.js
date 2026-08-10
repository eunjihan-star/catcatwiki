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

// ⚠️ 네이버 검색은 예전에 있던 AND/OR/~ 연산자를 더 이상 지원하지 않는다(2026-08 확인:
// "네이버에서 예전에 사용하던 검색 연산자 AND, OR, ~ 등은 모두 사라졌다"). 그런데 이
// 파일 곳곳에 "OR"를 문자 그대로 쿼리에 이어붙이는 코드가 있었다(예: "재건축 OR 재개발
// OR 관리처분인가 OR 사업시행인가") - 이러면 "OR"이 그냥 검색어 취급을 받아 전혀 무관한
// 문서가 걸리는 심각한 오탐 원인이 된다. 실제로 디에이치자이개포로 라이브 검증했더니
// 이 문자열 그대로 보낸 쿼리는 완전히 무관한 결과(자동차 배출가스 시스템 PDF 등)만
// 나왔는데, 단순히 "디에이치 자이 개포 재건축" 한 쿼리만 보내면 나무위키 문서가 1순위로
// 정확히 나왔다. OR로 묶으려던 키워드는 각각 별도 쿼리로 나눠 보낸 뒤 결과를 링크 기준
// 중복 제거해서 합치는 방식으로 대체한다 - "여러 개 중 하나라도 걸리면"이라는 원래
// 의도는 그대로 살리면서 실제로 동작하게 만든다.
async function searchNaverMulti(types, queries, display = 20) {
  const calls = [];
  for (const type of types) {
    for (const query of queries) {
      calls.push(searchNaver(type, query, display).catch(() => []));
    }
  }
  const settled = await Promise.all(calls);
  const merged = settled.flat();
  const seen = new Set();
  return merged.filter((item) => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });
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

/**
 * 관리처분인가·사용승인일 등은 전부 "이미 일어난" 행정 절차를 보도하는 값이라
 * 논리적으로 미래 날짜가 나올 수 없다 — 그런데도 "77" 같은 2자리 연도를 무조건
 * "20xx"로 해석하면 1977년을 2077년으로 잘못 읽어 실제로 이런 오탐이 나왔다.
 * 1) 2자리 연도는 "오늘 기준 미래가 되면 19xx로" 보정하고,
 * 2) 최종 날짜가 그래도 오늘보다 미래면 오추출로 보고 버린다.
 */
function normalizeDate(y, m, d) {
  const now = new Date();
  const currentYear = now.getFullYear();

  let year;
  if (y.length <= 2) {
    const asIs2000 = 2000 + Number(y);
    year = asIs2000 > currentYear ? 1900 + Number(y) : asIs2000;
  } else {
    year = Number(y);
  }
  if (year < 1980) return null;

  const monthNum = Number(m);
  if (monthNum < 1 || monthNum > 12) return null;
  const month = String(monthNum).padStart(2, '0');

  if (year > currentYear) return null;
  if (year === currentYear && monthNum > now.getMonth() + 1) return null;

  if (!d) return `${year}-${month}`; // 일자 미상 - 연/월까지만 제공

  const dayNum = Number(d);
  if (dayNum < 1 || dayNum > 31) return null;
  if (year === currentYear && monthNum === now.getMonth() + 1 && dayNum > now.getDate()) return null;

  const day = String(dayNum).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const EVENT_KEYWORD_MAP = {
  unionEstablishment: ['조합설립인가', '조합 설립인가', '조합설립 인가'],
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
  '추진위원회', '안전진단', '구역지정', '정비구역', '정비계획',
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
 *
 * @param {Array} articles
 * @param {string} [maxDate] 사용승인일(준공일, "YYYY-MM-DD"). 재건축 인허가는 논리적으로
 *   전부 준공보다 먼저 일어나므로, 이 값이 있으면 그 이후 날짜는 다른 건물 얘기이거나
 *   오추출로 보고 버린다 (단지명 없이 넓게 검색하는 dong 폴백에서 특히 중요한 안전장치).
 */
function extractRedevelopmentEvents(articles, maxDate) {
  const eventsByType = {
    unionEstablishment: [],
    managementDisposalApproval: [],
    projectImplementationApproval: [],
    subscriptionWin: [],
    memberSuccession: [],
  };

  for (const article of articles) {
    const text = `${article.title} ${article.description}`;
    const found = extractEventsFromText(text, EVENT_KEYWORD_MAP, DISTRACTOR_KEYWORDS);
    for (const f of found) {
      if (maxDate && f.date >= maxDate) continue;
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
    unionEstablishment: eventsByType.unionEstablishment[0] || null,
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
 *
 * 경기도 다수 도시처럼 "성남시 분당구", "수원시 영통구", "안양시 동안구"같이
 * 시/군/구가 두 토큰(시+구)으로 이루어진 주소가 있다 — 이걸 한 토큰(시)으로만
 * 읽으면 그 다음 토큰("분당구")이 동네 이름인 줄 알고 동(dong) 추출에 실패해서,
 * 정작 진짜 동네(서현동 등) 없이 "경기 성남시"까지만 검색어가 만들어지는 버그가
 * 있었다 — "분당 한양아파트"가 여의도 한양아파트 재건축 소식과 섞인 원인이 이것.
 */
function extractRegionTokens(jibunAddr) {
  if (!jibunAddr) return { sido: '', sigungu: '', sigunguParts: [], dong: '', queryRegion: '' };
  const tokens = jibunAddr.trim().split(/\s+/);
  const sidoRaw = tokens[0] || '';
  const sido = SIDO_SHORT_MAP[sidoRaw] || sidoRaw;

  let idx = 1;
  const sigunguParts = [];
  if (tokens[idx] && /(시|군|구)$/.test(tokens[idx])) {
    sigunguParts.push(tokens[idx]);
    idx++;
    // "OO시" 다음에 "OO구"가 또 나오면(성남시 분당구 등) 같이 묶는다
    if (/시$/.test(sigunguParts[0]) && tokens[idx] && /구$/.test(tokens[idx])) {
      sigunguParts.push(tokens[idx]);
      idx++;
    }
  }
  const sigungu = sigunguParts.join(' ');
  const dong = tokens[idx] && /(동|읍|면|가)$/.test(tokens[idx]) ? tokens[idx] : '';

  const queryRegion = [sido, sigungu, dong].filter(Boolean).join(' ');
  return { sido, sigungu, sigunguParts, dong, queryRegion };
}

/**
 * 검색 결과 텍스트가 다른 지역(우리 지역명은 전혀 언급 없이, 다른 시/도명만 언급)에
 * 관한 글로 보이면 true. sigungu는 "성남시 분당구"처럼 두 토큰일 수 있어 부분(성남시,
 * 분당구 각각) 어느 쪽이든 언급되면 "우리 지역 언급"으로 인정한다.
 */
function isLikelyWrongRegion(text, region) {
  if (!region.sido) return false;
  const mentionsOwnRegion =
    text.includes(region.sido) || (region.sigunguParts || []).some((part) => text.includes(part));
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
  const regionTokens = new Set([region.sido, region.dong, ...(region.sigunguParts || [])].filter(Boolean));
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
 * 3) requiredBunji가 있으면(= 단지명 없는 일반 주소) 정확히 그 번지가 텍스트에 나와야만
 *    통과 — 단지명이 없으면 "동" 단위 필터만으로는 부족하다. 재개발은 같은 동 안에도
 *    "OO본동 1구역", "OO본동 3구역"처럼 서로 다른 여러 구역이 동시에 진행되는 경우가
 *    흔해서, 동만 맞고 번지가 다른 남의 구역 소식이 그대로 섞여 들어온 사례가 있었다
 *    (부천 소사본동 286-23 검색 시 소사본1-1구역(번지 88-39) 뉴스가 뜬 것).
 * 4) (단지명이 있는 경우) 단지명에서 뽑은 변별력 있는 토큰(예: "아이파크")이 하나도
 *    안 나오면 탈락 — 같은 동이어도 별개 정비사업과 헷갈리지 않도록
 * 위 기준으로 걸러낼 게 아무것도 없으면(지역/단지명/번지 정보 부족) 그냥 통과시킨다.
 */
function isRelevantArticle(text, region, distinctiveTokens, requiredBunji) {
  if (isLikelyWrongRegion(text, region)) return false;

  if (region.dong) {
    const dongRoot = region.dong.replace(/(동|읍|면|가)$/, '');
    if (dongRoot && !text.includes(dongRoot)) return false;
  }

  if (requiredBunji) return text.includes(requiredBunji);

  if (distinctiveTokens.length > 0 && !distinctiveTokens.some((t) => text.includes(t))) return false;

  return true;
}

/**
 * 주소(단지명 포함 가능) 기준으로 재건축/재개발 관련 뉴스+블로그를 검색하고
 * 이벤트를 추출한다.
 * @param {string} keyword 단지명 또는 번지 (예: "종암아이파크", "286-23")
 * @param {string} [jibunAddr] 지번주소 — 지역명을 뽑아 검색어에 강제로 포함시키기 위해 사용
 * @param {string} [requiredBunji] 단지명이 없는 일반 주소일 때만 넘긴다 — 해당 번지가
 *   본문에 정확히 언급된 기사만 인정 (동 단위 매칭은 재개발구역 오염에 취약하기 때문)
 * @param {string} [maxDate] 사용승인일(준공일, "YYYY-MM-DD"). 건축물대장에서 이미 확인된
 *   경우에만 넘긴다 — 이미 완공된 건물은 재건축 후 단지명이 바뀌거나("OO주공" -> "OO그라시움")
 *   지번이 재편되어 단지명 검색으로는 옛 인허가 뉴스를 못 찾는 경우가 많다. 1차 검색이
 *   빈손이면 단지명 없이 "동+재건축" 키워드로 넓게 한 번 더 찾되(2차 폴백), maxDate를
 *   지난 날짜는 다른 단지 얘기로 보고 버려서 오탐을 막는다.
 */
async function searchRedevelopmentInfo(keyword, jibunAddr, requiredBunji, maxDate) {
  const region = extractRegionTokens(jibunAddr);
  const queryPrefix = region.queryRegion ? `${region.queryRegion} ` : '';
  // "지역+건물명"만 떼어둔다 - 자동 추출이 실패했을 때, 프론트엔드가 여기에 필드명(조합설립인가
  // 등)만 붙여서 "네이버에서 검색" 링크를 만들 수 있게 하기 위함이다.
  const searchBase = `${queryPrefix}${keyword}`.trim();
  // "재건축 OR 재개발 OR ..."로 붙이던 걸 별도 쿼리로 나눔(파일 상단 searchNaverMulti
  // 주석 참고) - 재건축/재개발은 서로 다른 법적 사업 유형이라 둘 다 따로 검색해야 한다.
  // 관리처분인가/사업시행인가는 그 자체가 별도 주제가 아니라 재건축/재개발 기사 본문에
  // 언급되는 키워드라 별도 검색어로 쪼갤 필요 없이 extractRedevelopmentEvents가 본문에서
  // 알아서 찾는다.
  const queries = [`${searchBase} 재건축`, `${searchBase} 재개발`];
  const query = queries.join(' / '); // 응답에 담아 내려주는 참고용 표기

  // 'webkr'(웹문서)는 네이버 블로그/뉴스 카테고리에만 있는 게 아니라 나무위키·부동산
  // 정보사이트 등 일반 웹사이트까지 크롤링한 색인이다 - 실제로 "디에이치자이개포"로
  // 테스트했을 때 뉴스/블로그에서는 못 찾던 나무위키 문서(옛 단지명 "개포 상록아파트"
  // 언급 포함)를 웹문서 검색 1번째 결과로 바로 찾아낸 걸 확인했다(2026-08). 완공되고
  // 이름 바뀐 재건축을 찾는 이 기능의 핵심 시나리오에 정확히 들어맞아서 추가한다.
  const rawArticles = await searchNaverMulti(['news', 'blog', 'webkr'], queries, 20);

  const distinctiveTokens = extractDistinctiveTokens(keyword, region);
  let articles = rawArticles.filter((a) =>
    isRelevantArticle(`${a.title} ${a.description}`, region, distinctiveTokens, requiredBunji)
  );

  let events = extractRedevelopmentEvents(articles, maxDate);
  const hasAnyEvent = (ev) =>
    Boolean(ev.unionEstablishment || ev.projectImplementationApproval || ev.managementDisposalApproval.initial
      || ev.subscriptionWin || ev.memberSuccession);

  if (!hasAnyEvent(events) && maxDate && region.queryRegion) {
    const fallbackQueries = [`${region.queryRegion} 재건축`, `${region.queryRegion} 재개발`];
    const fbRawArticles = await searchNaverMulti(['news', 'blog', 'webkr'], fallbackQueries, 20);
    // 단지명이 없는 검색이라 distinctiveTokens/requiredBunji 필터는 못 쓰고, 동 일치만 확인한다.
    const fbArticles = fbRawArticles
      .filter((a) => isRelevantArticle(`${a.title} ${a.description}`, region, [], undefined))
      .filter((a) => !articles.some((existing) => existing.link === a.link));
    const fbEvents = extractRedevelopmentEvents(fbArticles, maxDate);
    if (hasAnyEvent(fbEvents)) {
      events = { ...fbEvents, viaDongFallback: true };
      articles = articles.concat(fbArticles);
    }
  }

  return {
    query,
    searchBase,
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
 * @param {string} [requiredBunji] 단지명 없는 일반 주소일 때만 넘김 (아래 searchRedevelopmentInfo 설명 참고)
 * @returns {Promise<{date:string, title:string, link:string, snippet:string}|null>}
 */
async function searchUseApprovalDate(keyword, jibunAddr, requiredBunji) {
  const region = extractRegionTokens(jibunAddr);
  const queryPrefix = region.queryRegion ? `${region.queryRegion} ` : '';
  // "사용승인일 OR 준공일 OR 준공승인"으로 붙이던 걸 별도 쿼리로 나눔(파일 상단
  // searchNaverMulti 주석 참고). 세 단어가 사실상 같은 개념의 다른 표현이라 대표로 두
  // 개만 검색어로 쓰고, 나머지 변형(준공승인일/준공인가 등)은 extractEventsFromText가
  // 어차피 본문 전체에서 다시 찾으므로 검색어까지 다 쪼갤 필요는 없다.
  const queries = [`${queryPrefix}${keyword} 사용승인일`, `${queryPrefix}${keyword} 준공일`];

  const articles = (await searchNaverMulti(['news', 'blog', 'webkr'], queries, 20)).filter((a) =>
    isRelevantArticle(`${a.title} ${a.description}`, region, extractDistinctiveTokens(keyword, region), requiredBunji)
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
