'use strict';

const axios = require('axios');

// 지역별 공식 API + 청약홈 + 네이버 텍스트마이닝까지 전부 실패했을 때만 호출되는 마지막
// 폴백. 완공된 지 오래됐거나 단지명/지번이 통째로 바뀐 재건축(디에이치자이개포 등)은
// 네이버 검색 오픈API(뉴스/블로그 카테고리 한정)로는 원천적으로 도달 불가능한 자료(나무위키,
// 특집기사 등)가 있는데, 실시간 웹검색 도구를 가진 Gemini는 거기까지 닿을 수 있다.
//
// 모델 선택 이유 + 2026-08-06 이후 발생한 변화:
// 최신 모델(3.x)은 무료 티어에서 실시간 웹검색(Google Search grounding) 자체가 아예
// 제공되지 않는다(공식 가격표에 "Not available"로 명시) - 유료 결제를 켜야만(월 5,000건
// 무료 포함) 검색이 가능하다. 2.5 세대(Flash/Flash-Lite)만 무료 티어에서 하루 500건까지
// 웹검색 포함 완전 무료다.
//
// ⚠️ 2026-08-XX: gemini-2.5-flash가 신규 발급 API 키에서 "no longer available to new
// users"(404)로 막히기 시작했다 - 공식 지원종료일(2026-10-16)보다 훨씬 이르게, 신규
// 사용자만 선제 차단하는 방식(구글 개발자 포럼에 다수 보고됨). gemini-2.5-flash-lite로
// 교체 - 공식 가격표상 아직 신규 사용자 포함 무료 웹검색을 제공하는 걸로 확인되나(하루
// 500건), 같은 세대라 구글이 언제든 똑같이 막을 수 있다는 점은 감안해야 한다. 이런
// 이유로 모델명을 하드코딩 대신 환경변수로도 즉시 바꿀 수 있게 해뒀다(코드 배포 없이
// GEMINI_MODEL 환경변수만 바꾸면 됨).
//
// ⚠️ 절대 원칙: AI가 제시하는 날짜에는 반드시 실제 출처 URL이 있어야 한다. 출처 없는 날짜는
// 화면에 노출하지 않는다(사용자의 명시적 요구사항) - 프롬프트로 지시할 뿐 아니라, 아래
// validateResult()에서 sourceUrl이 없거나 http(s)로 시작하지 않는 항목은 코드 레벨에서도 버린다.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
function geminiApiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

const FIELD_LABELS = {
  unionEstablishment: '조합설립인가일',
  projectImplementationApproval: '사업시행인가일',
  managementDisposalApproval: '관리처분인가일',
  subscriptionWin: '청약 당첨일(분양일)',
  memberSuccession: '조합원 지위승계일',
};
const VALID_FIELDS = new Set(Object.keys(FIELD_LABELS));

function buildPrompt({ buildingName, regionLabel, knownCompletionDate, missingFields }) {
  const today = new Date().toISOString().slice(0, 10);
  const wanted = missingFields.map((f) => `- ${FIELD_LABELS[f] || f} (field key: "${f}")`).join('\n');

  return `당신은 한국의 재건축/재개발 행정 이력을 조사하는 리서처입니다. 오늘 날짜는 ${today}입니다.

아래 단지에 대해, 지정된 재건축/재개발 행정 절차 날짜(들)를 실제 웹검색으로 찾으세요.

단지명: ${buildingName}
${regionLabel ? `지역: ${regionLabel}` : ''}
${knownCompletionDate ? `이미 확인된 사용승인일(준공일): ${knownCompletionDate} (이 날짜 이후의 인허가 날짜는 채택하지 마세요)` : ''}

찾아야 할 항목:
${wanted}

규칙:
1. 반드시 실제 웹검색으로 확인하세요. 사전 지식만으로 답하지 마세요.
2. 나무위키, 뉴스 기사, 정비사업 조합 공지, 지자체 고시 등 신뢰할 수 있는 출처를 우선하세요.
3. ⚠️ 가장 중요한 규칙: 각 날짜에는 실제로 검색해서 확인한 출처 URL이 반드시 있어야 합니다. 출처 URL을 제시할 수 없는 날짜는 절대 보고하지 말고 그 항목을 통째로 생략하세요. 추측이나 사전지식만으로 날짜를 채우는 것은 금지됩니다.
4. 여러 출처에서 날짜가 다르면 더 공식적인 출처(조합/지자체 고시 > 뉴스 > 블로그/커뮤니티)를 채택하세요.
5. 이 건물이 이미 완공되었고 완공일을 알고 있는 경우, 재건축 인허가 절차는 논리적으로 전부 그 이전에 일어났어야 합니다.
6. 확신이 없으면 생략하세요.

작업을 마치면 반드시 마지막에 아래 형식의 JSON 코드블록 하나로 결과를 정리하세요 (코드블록 앞뒤에 설명 텍스트가 있어도 됩니다):

\`\`\`json
[
  {"field": "필드key", "date": "YYYY-MM-DD 또는 YYYY-MM", "sourceUrl": "https://...", "sourceTitle": "출처 제목", "note": "간단한 근거 설명"}
]
\`\`\`

- field는 위에 나열된 field key만 사용하세요.
- sourceUrl은 실제 검색으로 확인한 진짜 URL이어야 합니다.
- 찾은 게 하나도 없으면 빈 배열 []을 출력하세요.`;
}

function extractJsonBlock(text) {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length === 0) return [];
  const last = matches[matches.length - 1][1];
  try {
    const parsed = JSON.parse(last);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function validateResult(item) {
  if (!item || typeof item !== 'object') return null;
  const { field, date, sourceUrl } = item;
  if (!VALID_FIELDS.has(field)) return null;
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}(-\d{2})?$/.test(date)) return null;
  if (!sourceUrl || typeof sourceUrl !== 'string' || !/^https?:\/\//.test(sourceUrl)) return null;
  return {
    field,
    date,
    sourceUrl,
    sourceTitle: typeof item.sourceTitle === 'string' ? item.sourceTitle : null,
    note: typeof item.note === 'string' ? item.note : null,
  };
}

/**
 * 실제 웹검색 기능이 있는 Gemini에게 재건축 인허가 날짜를 찾아달라고 요청한다.
 * 지역별 공식 API + 청약홈 + 네이버 텍스트마이닝이 전부 빈손일 때만 호출되는 최후 폴백.
 *
 * @param {{buildingName: string, regionLabel?: string, knownCompletionDate?: string, missingFields: string[]}} params
 * @returns {Promise<{results: Array<object>, error: string|null}>}
 */
async function findRedevelopmentDatesViaGemini({ buildingName, regionLabel, knownCompletionDate, missingFields }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { results: [], error: null }; // 키 미설정 시 조용히 비활성화 (다른 통합과 동일한 원칙)
  if (!buildingName || !Array.isArray(missingFields) || missingFields.length === 0) {
    return { results: [], error: null };
  }

  const prompt = buildPrompt({ buildingName, regionLabel, knownCompletionDate, missingFields });

  try {
    const { data } = await axios.post(
      geminiApiUrl(GEMINI_MODEL),
      {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      },
      {
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    const candidate = data?.candidates?.[0];
    if (!candidate) return { results: [], error: null };

    // Gemini가 안전정책 등으로 응답을 거부하면 finishReason이 STOP이 아닌 값으로 온다.
    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      return { results: [], error: null };
    }

    const fullText = (candidate.content?.parts || [])
      .map((p) => p.text || '')
      .join('\n');

    const rawResults = extractJsonBlock(fullText);
    const results = rawResults.map(validateResult).filter(Boolean);

    return { results, error: null };
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    return { results: [], error: `Gemini 검색 중 오류: ${message}` };
  }
}

module.exports = { findRedevelopmentDatesViaGemini, FIELD_LABELS };
