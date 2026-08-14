'use strict';

const axios = require('axios');

// 관리자 저장이 왜 안 되는지 실사용자 화면에서 바로 눈으로 확인하려고 만든 임시 진단
// 엔드포인트. 실제 위키 데이터(wiki-data-v1)는 절대 건드리지 않고, 완전히 별개의
// 테스트 키로 KV에 SET/GET/DEL을 직접 시도해서 진짜 연결이 되는지 확인한다.
// 시크릿 값 자체는 절대 응답에 포함하지 않고 존재 여부(boolean)만 알려준다.
async function handleDiag() {
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  const result = {
    vercelEnv: process.env.VERCEL_ENV || null,
    hasKvUrl: Boolean(KV_URL),
    hasKvToken: Boolean(KV_TOKEN),
    kvUrlHost: KV_URL ? new URL(KV_URL).host : null, // 값은 안 보여주고 도메인만
    kvRoundTrip: null,
    kvError: null,
  };

  if (KV_URL && KV_TOKEN) {
    const testKey = 'diag-test-key';
    try {
      await axios.post(KV_URL, ['SET', testKey, 'ok'], {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        timeout: 8000,
      });
      const { data } = await axios.post(KV_URL, ['GET', testKey], {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        timeout: 8000,
      });
      await axios.post(KV_URL, ['DEL', testKey], {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        timeout: 8000,
      });
      result.kvRoundTrip = data && data.result === 'ok' ? 'success' : 'unexpected-response';
    } catch (err) {
      result.kvRoundTrip = 'failed';
      result.kvError = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    }
  }

  return result;
}

module.exports = { handleDiag };
