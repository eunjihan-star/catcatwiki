'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// 이 파일은 "지역별 공식 API + 청약홈 + 네이버 텍스트마이닝"까지 전부 실패했을 때만 호출되는
// 마지막 폴백이다. 완공된 지 오래됐거나 단지명/지번이 통째로 바뀐 재건축(디에이치자이개포 등)은
// 네이버 검색 오픈API(뉴스/블로그 카테고리 한정)로는 원천적으로 도달 불가능한 자료(나무위키,
// 특집기사 등)가 있는데, 실제 웹 검색 도구를 가진 AI는 거기까지 닿을 수 있다.
//
// ⚠️ 절대 원칙: AI가 제시하는 날짜에는 반드시 실제 출처 URL이 있어야 한다. 출처 없는 날짜는
// 화면에 노출하지 않는다 (사용자의 명시적 요구사항) — 프롬프트로 지시할 뿐 아니라, 아래
// validateResult()에서 sourceUrl이 없거나 http(s)로 시작하지 않는 항목은 코드 레벨에서도 버린다.

const FIELD_LABELS = {
  unionEstablishment: '조합설립인가일',
  projectImplementationApproval: '사업시행인가일',
  managementDisposalApproval: '관리처분인가일',
  subscriptionWin: '청약 당첨일(분양일)',
  memberSuccession: '조합원 지위승계일',
};
const VALID_FIELDS = new Set(Object.keys(FIELD_LABELS));

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `당신은 한국의 재건축/재개발 행정 이력을 조사하는 리서처입니다. 오늘 날짜는 ${today}입니다.

사용자가 알려주는 아파트/주택 단지에 대해, 지정된 재건축/재개발 행정 절차 날짜(들)를 실제 웹 검색으로 찾으세요.

규칙:
1. 반드시 web_search 도구로 실제 검색하세요. 사전 지식만으로 답하지 마세요.
2. 나무위키, 뉴스 기사, 정비사업 조합 공지, 지자체 고시, "정비사업 정보몽땅" 등 신뢰할 수 있는 출처를 우선하세요.
3. ⚠️ 가장 중요한 규칙: 각 날짜에는 실제로 검색해서 확인한 출처 URL이 반드시 있어야 합니다. 출처 URL을 제시할 수 없는 날짜는 절대 보고하지 말고 그 항목을 통째로 생략하세요. 추측이나 사전지식만으로 날짜를 채우는 것은 금지됩니다.
4. 여러 출처에서 날짜가 다르면 더 공식적인 출처(조합/지자체 고시 > 뉴스 > 블로그/커뮤니티)를 채택하세요.
5. 이 건물이 이미 완공되었고 완공일(사용승인일)을 알고 있는 경우, 재건축 인허가 절차는 논리적으로 전부 그 이전에 일어났어야 합니다 — 완공일 이후 날짜가 나오면 다른 단지 얘기이거나 오류이니 채택하지 마세요.
6. 확신이 없으면 생략하세요.

작업을 마치면 반드시 마지막에 아래 형식의 JSON 코드블록 하나로 결과를 정리하세요 (코드블록 앞뒤에 설명 텍스트가 있어도 됩니다):

\`\`\`json
[
  {"field": "필드key", "date": "YYYY-MM-DD 또는 YYYY-MM", "sourceUrl": "https://...", "sourceTitle": "출처 제목", "note": "간단한 근거 설명"}
]
\`\`\`

- field는 다음 key만 사용: ${Object.keys(FIELD_LABELS).join(', ')}
- sourceUrl은 web_search로 실제 확인한 진짜 URL이어야 합니다.
- 찾은 게 하나도 없으면 빈 배열 []을 출력하세요.`;
}

function buildUserPrompt({ buildingName, regionLabel, knownCompletionDate, missingFields }) {
  const lines = [];
  lines.push(`단지명: ${buildingName}`);
  if (regionLabel) lines.push(`지역: ${regionLabel}`);
  if (knownCompletionDate) lines.push(`이미 확인된 사용승인일(준공일): ${knownCompletionDate} (이 날짜 이후의 인허가 날짜는 채택하지 마세요)`);
  lines.push('');
  lines.push('아래 항목의 날짜와 출처 URL을 찾아주세요:');
  for (const field of missingFields) {
    lines.push(`- ${FIELD_LABELS[field] || field}`);
  }
  return lines.join('\n');
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
 * 실제 웹 검색 기능이 있는 Claude에게 재건축 인허가 날짜를 찾아달라고 요청한다.
 * 지역별 공식 API + 청약홈 + 네이버 텍스트마이닝이 전부 빈손일 때만 호출되는 최후 폴백.
 *
 * @param {{buildingName: string, regionLabel?: string, knownCompletionDate?: string, missingFields: string[]}} params
 * @returns {Promise<{results: Array<object>, error: string|null}>}
 */
async function findRedevelopmentDatesViaAI({ buildingName, regionLabel, knownCompletionDate, missingFields }) {
  const anthropic = getClient();
  if (!anthropic) return { results: [], error: null }; // 키 미설정 시 조용히 비활성화 (다른 통합과 동일한 원칙)
  if (!buildingName || !Array.isArray(missingFields) || missingFields.length === 0) {
    return { results: [], error: null };
  }

  const system = buildSystemPrompt();
  const userText = buildUserPrompt({ buildingName, regionLabel, knownCompletionDate, missingFields });
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }];
  let messages = [{ role: 'user', content: userText }];

  try {
    let response = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system,
      tools,
      messages,
    });

    // 서버사이드 도구(web_search) 반복 한도(10회)에 걸리면 pause_turn 으로 멈춘다 - 이어서 재요청.
    let continuations = 0;
    while (response.stop_reason === 'pause_turn' && continuations < 2) {
      messages = [...messages, { role: 'assistant', content: response.content }];
      response = await anthropic.messages.create({
        model: 'claude-opus-5',
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        system,
        tools,
        messages,
      });
      continuations += 1;
    }

    if (response.stop_reason === 'refusal') {
      return { results: [], error: 'AI가 이 요청을 처리하지 않았습니다(안전 정책).' };
    }

    const fullText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const rawResults = extractJsonBlock(fullText);
    const results = rawResults.map(validateResult).filter(Boolean);

    return { results, error: null };
  } catch (err) {
    return { results: [], error: `AI 검색 중 오류: ${err.message}` };
  }
}

module.exports = { findRedevelopmentDatesViaAI, FIELD_LABELS };
