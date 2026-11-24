/**
 * Gemini.gs — Gemini API 호출 (API 키 / 모델 순차 Fallback)
 *
 * 키 설정: Apps Script 편집기 → ⚙️ 프로젝트 설정 → 스크립트 속성
 *   GEMINI_API_KEY      (필수)
 *   GEMINI_API_KEY_1, GEMINI_API_KEY_2 …  (선택: 한도 초과 시 다음 키로 넘어감)
 *   GEMINI_MODELS       (선택: 쉼표로 구분한 모델 목록. 비우면 아래 기본 목록 사용)
 *
 * 변경점(매칭 도우미용): 응답에 사용한 모델명(_model)을 붙이고,
 * 429는 다음 모델로 먼저 넘긴다(한도는 모델별로 따로 계산되므로).
 */

const GEMINI_DEFAULT_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];

function getGeminiApiKeys() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const keys = [];
  if (props['GEMINI_API_KEY']) keys.push(props['GEMINI_API_KEY']);
  Object.keys(props).sort().forEach(function (name) {
    if (name.indexOf('GEMINI_API_KEY_') === 0 && props[name] && keys.indexOf(props[name]) < 0) keys.push(props[name]);
  });
  if (keys.length === 0) {
    throw new Error("Gemini API 키가 없어요. Apps Script ⚙️ 프로젝트 설정 → 스크립트 속성에 'GEMINI_API_KEY'를 추가해 주세요.");
  }
  return keys;
}

function geminiModels_() {
  const v = PropertiesService.getScriptProperties().getProperty('GEMINI_MODELS');
  const list = v ? v.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
  return list.length ? list : GEMINI_DEFAULT_MODELS;
}

/** 키 × 모델을 차례로 시도. 권한 오류는 다음 키로, 한도(429)/일시 오류는 다음 모델로 */
function callGeminiApiWithFallback(payload) {
  const apiKeys = getGeminiApiKeys();
  const models = geminiModels_();
  let lastError = '';

  for (let k = 0; k < apiKeys.length; k++) {
    const label = 'Key #' + (k + 1);
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKeys[k];
      try {
        const res = UrlFetchApp.fetch(url, {
          method: 'post', contentType: 'application/json',
          payload: JSON.stringify(payload), muteHttpExceptions: true,
        });
        const json = JSON.parse(res.getContentText());
        if (json.error) {
          const msg = json.error.message || '', code = json.error.code, status = json.error.status;
          lastError = '[' + label + ' | ' + model + '] ' + msg;
          console.log(lastError);
          if (code === 403 || status === 'PERMISSION_DENIED') break;  // 다음 키
          continue;                                                    // 429 포함: 다음 모델
        }
        console.log('[' + label + ' | ' + model + '] 호출 성공');
        json._model = model;
        return json;
      } catch (e) {
        lastError = '[' + label + ' | ' + model + '] ' + e;
        console.log(lastError);
      }
    }
  }
  throw new Error('Gemini 호출 실패 (모든 키·모델). 마지막 오류: ' + lastError);
}

/** 프롬프트를 보내고 JSON 객체로 받아옴 */
function geminiJson_(prompt) {
  const json = callGeminiApiWithFallback({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  });
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  const text = parts.map(function (p) { return p.text || ''; }).join('').replace(/```json|```/g, '').trim();
  if (!text) throw new Error('Gemini 응답이 비어 있어요.');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Gemini 응답을 읽지 못했어요: ' + text.slice(0, 120));
  }
}
