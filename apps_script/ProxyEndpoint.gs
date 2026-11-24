/**
 * ProxyEndpoint.gs - 책 저자 매칭 도우미용 웹앱 진입점
 * 기존 Gemini.gs(callGeminiApiWithFallback)를 그대로 사용합니다.
 *
 * 스크립트 속성: PROXY_TOKEN (템퍼몽키와 같은 값), GEMINI_API_KEY (기존),
 *               GEMINI_MODELS = gemini-3.1-flash-lite,gemini-3.5-flash-lite
 * Gemini.gs 수정 2곳은 README 참고.
 */
function doGet() { return proxyJson_({ ok: true, msg: 'gemini proxy alive' }); }

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('PROXY_TOKEN');
    if (!token || body.token !== token) return proxyJson_({ ok: false, error: 'unauthorized' });
    if (!body.user) return proxyJson_({ ok: false, error: 'user prompt missing' });

    var payload = {
      contents: [{ role: 'user', parts: [{ text: body.user }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 4000 },
    };
    if (body.system) payload.systemInstruction = { parts: [{ text: body.system }] };

    var json = callGeminiApiWithFallback(payload);
    var parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    var text = parts.map(function (p) { return p.text || ''; }).join('');
    if (!text) return proxyJson_({ ok: false, error: 'empty response' });
    return proxyJson_({ ok: true, model: json._model || '', text: text });
  } catch (err) {
    return proxyJson_({ ok: false, error: String(err) });
  }
}

function proxyJson_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
