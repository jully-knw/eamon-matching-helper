// ==UserScript==
// @name         SDB 책 저자 매칭 도우미
// @namespace    jully.kim
// @version      1.0.0
// @description  표준 인물 : 책 저자 매칭 보조 - AI 순서, 다음 검색/교보문고 분할 팝업, 매칭+나머지 금칙, 되돌리기
// @match        https://eamon-matching-op.daumtools.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/jully-knw/eamon-matching-helper/main/book_author_match_helper.user.js
// @downloadURL  https://raw.githubusercontent.com/jully-knw/eamon-matching-helper/main/book_author_match_helper.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 설정 ================= */
  const CFG = {
    PAGE_SIZE: 20,          // AI 한 번에 판정할 후보 수 (운영툴 한 페이지 크기와 같게)
    CLICK_DELAY_MS: 350,    // 버튼 클릭 사이 간격
    UNDO_SECONDS: 20,       // 되돌리기 알림 노출 시간
    LIMIT_PRIMARY: 500,     // 주 모델 하루 요청 한도 (표시용)
    MAX_FIELD_CHARS: 400,   // AI에 보내는 저자정보/저서 최대 글자 수
    CACHE_DAYS: 14,
  };

  const VERDICT = {
    high:   { label: '높음',      rank: 0, bg: '#d6f5f2', fg: '#00574f' },
    mid:    { label: '중간',      rank: 1, bg: '#dbe9fb', fg: '#0c447c' },
    unsure: { label: '불확실',    rank: 2, bg: '#fdeccf', fg: '#633806' },
    no:     { label: '다른 사람', rank: 3, bg: '#fbdcdc', fg: '#791f1f' },
  };

  /* ================= 유틸 ================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function waitFor(fn, ms = 2500, step = 80) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
    return fn();
  }

  /* ================= 저장소: 설정/캐시/사용량 ================= */
  const store = {
    get gasUrl() { return GM_getValue('gasUrl', ''); },
    get token() { return GM_getValue('proxyToken', ''); },
  };
  GM_registerMenuCommand('AI 중계 주소 설정', () => {
    const v = prompt('Apps Script 웹앱 주소(/exec로 끝남)', store.gasUrl);
    if (v != null) GM_setValue('gasUrl', v.trim());
  });
  GM_registerMenuCommand('AI 중계 토큰 설정', () => {
    const v = prompt('PROXY_TOKEN', store.token);
    if (v != null) GM_setValue('proxyToken', v.trim());
  });
  GM_registerMenuCommand('AI 판정 캐시 비우기', () => { GM_setValue('judgeCache', {}); alert('캐시를 비웠어요.'); });

  const pacificDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  function getUsage() {
    const u = GM_getValue('usage', null);
    return u && u.day === pacificDay() ? u : { day: pacificDay(), counts: {} };
  }
  function addUsage(model) {
    const u = getUsage();
    u.counts[model] = (u.counts[model] || 0) + 1;
    GM_setValue('usage', u);
  }
  function usageText() {
    const u = getUsage();
    const names = Object.keys(u.counts);
    const primary = u.counts['gemini-3.1-flash-lite'] || 0;
    const other = names.filter((n) => n !== 'gemini-3.1-flash-lite').reduce((s, n) => s + u.counts[n], 0);
    return `AI 오늘 ${primary} / ${CFG.LIMIT_PRIMARY}` + (other ? ` (+대체 ${other})` : '');
  }

  function loadCache() {
    const c = GM_getValue('judgeCache', {});
    const limit = Date.now() - CFG.CACHE_DAYS * 86400000;
    Object.keys(c).forEach((k) => { if (!c[k].ts || c[k].ts < limit) delete c[k]; });
    return c;
  }
  const CACHE = loadCache();
  const saveCache = () => GM_setValue('judgeCache', CACHE);
  const ckey = (stdId, candId) => `${stdId}:${candId}`;

  /* ================= 운영툴 DOM 파싱 ================= */
  // 후보 행 = td.target-title-col 이 있는 tr, 표준 인물 그룹은 td.source-border 가 있는 tr 에서 시작
  function getGroups() {
    const groups = [];
    let cur = null;
    document.querySelectorAll('tr').forEach((tr) => {
      const candTd = tr.querySelector(':scope > td.target-title-col');
      if (!candTd) return;
      const src = tr.querySelector(':scope > td.source-border');
      if (src || !cur) {
        cur = {
          id: txt(src && src.querySelector('.source-id-text')),
          name: src ? txt(Array.from(src.children).find((c) => c.tagName === 'DIV' && !c.classList.contains('source-id-text') && !c.classList.contains('mh-ai-wrap'))) : '',
          srcTd: src || null,
          rows: [],
        };
        groups.push(cur);
      }
      cur.rows.push(tr);
    });
    return groups;
  }
  const candId = (tr) => txt(tr.querySelector('td.target-title-col > div'));
  const candName = (tr) => txt(tr.querySelector('td.target-title-col span.font-weight-bold'));
  const toggleBtns = (tr) => { const m = {}; tr.querySelectorAll('.v-btn-toggle button[value]').forEach((b) => (m[b.value] = b)); return m; };
  function curState(tr) {
    const b = toggleBtns(tr);
    for (const k of ['A', 'D', 'W']) if (b[k] && b[k].classList.contains('v-btn--active')) return k;
    return 'W';
  }

  // 후보 바로 다음 tr 의 상세표 -> {라벨: [기준값, 매칭값]}
  function detailOf(tr) {
    const out = {};
    const next = tr.nextElementSibling;
    if (!next) return out;
    next.querySelectorAll('.collection-item-table tbody tr').forEach((r) => {
      const tds = r.querySelectorAll(':scope > td');
      if (tds.length < 4) return;
      const val = (td) => { const i = td.querySelector('input,textarea'); return i ? i.value || '' : txt(td); };
      const l1 = txt(tds[0].querySelector('.field-label'));
      const l2 = txt(tds[2].querySelector('.field-label'));
      if (l1) (out[l1] = out[l1] || ['', ''])[0] = val(tds[1]);
      if (l2) (out[l2] = out[l2] || ['', ''])[1] = val(tds[3]);
    });
    return out;
  }
  const hasDetail = (tr) => !!(tr.nextElementSibling && tr.nextElementSibling.querySelector('.collection-item-table'));

  // 상세표가 없으면 후보를 눌러 펼치고, 저자정보가 없으면 "전체 필드 보기"를 켠다
  async function ensureDetail(tr) {
    if (!hasDetail(tr)) {
      const td = tr.querySelector('td.target-title-col');
      if (td) td.click();
      await waitFor(() => hasDetail(tr), 2500);
    }
    if (hasDetail(tr) && !('저자정보' in detailOf(tr))) {
      const cb = tr.nextElementSibling.querySelector('input[type=checkbox]');
      if (cb && !cb.checked && !tr.dataset.mhFull) {
        tr.dataset.mhFull = '1'; // 행마다 한 번만 시도
        cb.click();
        await waitFor(() => '저자정보' in detailOf(tr), 1200);
      }
    }
    return detailOf(tr);
  }

  function readCandidate(tr, d) {
    return {
      id: candId(tr),
      name: candName(tr),
      info: ((d['저자정보'] || [])[1] || '').trim(),
      books: ((d['저서'] || [])[1] || '').trim(),
      url: ((d['서비스 url'] || [])[1] || '').trim(),
    };
  }
  function readStandard(d) {
    return {
      job: ((d['직업'] || [])[0] || '').trim(),
      birth: ((d['출생일(양력)'] || [])[0] || '').trim(),
      gender: ((d['성별'] || [])[0] || '').trim(),
    };
  }

  /* ================= 글자 비교 칩 (AI 없이) ================= */
  const birthYear = (s) => { const m = (s || '').match(/(1[89]\d{2}|20[0-2]\d)/); return m ? m[1] : ''; };
  const jobTokens = (s) => (s || '').split(/[,;·/\s]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
  function localCompare(std, cand) {
    const hay = (cand.info || '') + ' ' + (cand.books || '');
    const hasText = hay.trim().length > 0;
    const y = birthYear(std.birth);
    const job = hasText && jobTokens(std.job).length ? jobTokens(std.job).some((j) => hay.includes(j)) : null;
    let birth = null;
    if (hasText && y) {
      if (hay.includes(y)) birth = true;
      else { const other = (cand.info || '').match(/(1[89]\d{2}|20[0-2]\d)\s*년/); birth = other ? false : null; }
    }
    return { job, birth };
  }
  function localVerdict(c) {
    if (c.job === true && c.birth === true) return { verdict: 'high', reason: '직업, 출생 모두 일치' };
    if (c.birth === false) return { verdict: 'no', reason: '출생년도가 다름' };
    if (c.job === true || c.birth === true) return { verdict: 'mid', reason: '직업 또는 출생 일치(글자 비교)' };
    return { verdict: 'unsure', reason: '비교할 근거 없음' };
  }
  const chipHtml = (ok, label) =>
    `<span class="mh-chip" style="background:${ok === true ? '#d6f5f2' : ok === false ? '#fbdcdc' : '#eee'};color:${ok === true ? '#00574f' : ok === false ? '#791f1f' : '#666'}">${label}${ok === true ? ' ✓' : ok === false ? ' ✗' : ' -'}</span>`;
  const badgeHtml = (v) => (VERDICT[v] ? `<span class="mh-chip" style="background:${VERDICT[v].bg};color:${VERDICT[v].fg}">AI ${VERDICT[v].label}</span>` : '');

  /* ================= Gemini (Apps Script 중계) ================= */
  function callProxy(system, user) {
    return new Promise((resolve, reject) => {
      if (!store.gasUrl || !store.token) {
        reject(new Error('AI 중계 주소/토큰이 설정되지 않았어요. 템퍼몽키 메뉴에서 설정해 주세요.'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: store.gasUrl,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        data: JSON.stringify({ token: store.token, system, user }),
        timeout: 60000,
        onload: (r) => {
          let j;
          try { j = JSON.parse(r.responseText); } catch (e) { reject(new Error('중계 응답을 읽을 수 없어요 (HTTP ' + r.status + ')')); return; }
          if (!j.ok) { reject(new Error(j.error || '중계 오류')); return; }
          addUsage(j.model);
          resolve(j.text);
        },
        onerror: () => reject(new Error('중계 서버에 연결하지 못했어요')),
        ontimeout: () => reject(new Error('중계 서버 응답 시간 초과')),
      });
    });
  }

  const SYSTEM_PROMPT =
    '당신은 인물 데이터 운영자를 돕는 도우미입니다. 기준 인물(표준 인물)과 교보문고 책 저자 후보가 같은 사람인지 판단합니다. ' +
    '제공된 정보만 근거로 하고 추측하지 마세요. 같은 이름의 다른 사람이 많으니 직업, 출생년도, 성별, 저서 분야를 비교하세요. ' +
    '판정: high = 출생년도와 직업 등 2개 이상 근거가 일치하고 상충이 없음. mid = 근거 1개가 일치하고 상충이 없음. ' +
    'unsure = 비교할 근거가 없거나 판단 불가. no = 출생년도, 직업, 성별 중 명확히 다른 것이 있음. ' +
    'reason은 40자 이내 한국어 한 문장. 출력은 JSON 배열만: [{"id":"후보id","verdict":"high|mid|unsure|no","reason":"..."}]. 모든 후보를 빠짐없이 한 번씩 포함하세요.';

  async function judgeWithAI(group, std, cands) {
    const payload = {
      standard: { id: group.id, name: group.name, job: std.job, birth: std.birth, gender: std.gender },
      candidates: cands.map((c) => ({
        id: c.id, name: c.name,
        info: c.info.slice(0, CFG.MAX_FIELD_CHARS),
        books: c.books.slice(0, CFG.MAX_FIELD_CHARS),
      })),
    };
    const raw = await callProxy(SYSTEM_PROMPT, JSON.stringify(payload));
    let arr;
    try { arr = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (e) { throw new Error('AI 응답 형식 오류'); }
    if (!Array.isArray(arr)) throw new Error('AI 응답 형식 오류');
    const byId = {};
    arr.forEach((o) => { if (o && o.id != null) byId[String(o.id)] = o; });
    return cands.map((c) => {
      const o = byId[c.id];
      if (o && VERDICT[o.verdict]) return { id: c.id, verdict: o.verdict, reason: String(o.reason || '').slice(0, 80) };
      return { id: c.id, verdict: 'unsure', reason: 'AI 응답에 이 후보가 빠짐' };
    });
  }

  /* ================= 상태 ================= */
  // 표준 인물별 진행 상태 (메모리)
  const ST = {}; // stdId -> {judged: n, std, error}
  const getSt = (id) => (ST[id] = ST[id] || { judged: 0, std: null, error: '', busy: false });
  let ui = { open: false, stdId: null, selId: null };

  const rowsOf = (stdId) => { const g = getGroups().find((x) => x.id === stdId); return g || null; };
  function findTr(stdId, id) {
    const g = rowsOf(stdId);
    return g ? g.rows.find((tr) => candId(tr) === id) || null : null;
  }

  /* ================= AI 판정 흐름 ================= */
  // 아직 판정하지 않은 후보 중 다음 PAGE_SIZE 명을 판정
  async function judgeNext(stdId) {
    const s = getSt(stdId);
    const g = rowsOf(stdId);
    if (!g) return;
    s.error = '';
    const slice = g.rows.slice(s.judged, s.judged + CFG.PAGE_SIZE);
    if (!slice.length) return;

    const cands = [];
    for (const tr of slice) {
      const d = await ensureDetail(tr);
      if (!s.std) s.std = readStandard(d);
      cands.push(readCandidate(tr, d));
    }
    const std = s.std || { job: '', birth: '', gender: '' };

    // 캐시에 없는 후보만 판정
    const need = cands.filter((c) => !CACHE[ckey(stdId, c.id)]);
    if (need.length) {
      if (g.rows.length === 1) {
        need.forEach((c) => { CACHE[ckey(stdId, c.id)] = Object.assign(localVerdict(localCompare(std, c)), { ts: Date.now() }); });
      } else {
        const res = await judgeWithAI(g, std, need);
        res.forEach((r) => { CACHE[ckey(stdId, r.id)] = { verdict: r.verdict, reason: r.reason, ts: Date.now() }; });
      }
      saveCache();
    }
    s.judged += slice.length;
  }

  function findMoreButton(group) {
    const last = group.rows[group.rows.length - 1];
    let el = last && last.nextElementSibling; // 상세 tr
    for (let i = 0; i < 3 && el; i++, el = el.nextElementSibling) {
      if (el.querySelector && el.querySelector('td.target-title-col')) break;
      const b = Array.from(el.querySelectorAll('button')).find((x) => /후보 더보기/.test(x.textContent));
      if (b) return b;
    }
    return null;
  }

  async function loadMore(stdId) {
    const g = rowsOf(stdId);
    if (!g) return false;
    const btn = findMoreButton(g);
    if (!btn) return false;
    const before = g.rows.length;
    btn.click();
    await waitFor(() => { const x = rowsOf(stdId); return x && x.rows.length > before; }, 6000, 150);
    const after = rowsOf(stdId);
    return !!(after && after.rows.length > before);
  }

  async function startAI(stdId) {
    const s = getSt(stdId);
    if (s.busy) return;
    s.busy = true; refreshAll();
    try {
      if (s.judged === 0) await judgeNext(stdId);
    } catch (e) { s.error = e.message; }
    s.busy = false;
    openPopup(stdId);
  }

  async function nextPage(stdId) {
    const s = getSt(stdId);
    if (s.busy) return;
    s.busy = true; renderPopup();
    try {
      const g = rowsOf(stdId);
      if (g && g.rows.length <= s.judged) await loadMore(stdId);
      await judgeNext(stdId);
    } catch (e) { s.error = e.message; }
    s.busy = false; renderPopup(); refreshAll();
  }

  /* ================= 매칭 + 나머지 금칙 ================= */
  async function setState(tr, val) {
    const b = toggleBtns(tr)[val];
    if (!b || curState(tr) === val) return;
    b.click();
    await sleep(CFG.CLICK_DELAY_MS);
  }
  async function matchOne(stdId, chosenId) {
    const g = rowsOf(stdId);
    if (!g) return;
    const before = g.rows.map((tr) => [candId(tr), curState(tr)]);
    const label = `${g.id} ${g.name}`;
    toast(`${label}: 처리 중...`);
    let n = 0;
    const chosen = g.rows.find((tr) => candId(tr) === chosenId);
    if (chosen) await setState(chosen, 'A');
    for (const tr of g.rows) {
      if (candId(tr) === chosenId) continue;
      if (curState(tr) !== 'D') { await setState(tr, 'D'); n++; }
    }
    const hasMore = !!findMoreButton(rowsOf(stdId) || g);
    toast(`${label}: 1명 매칭, ${n}명 금칙` + (hasMore ? ' (더보기 안 한 후보는 그대로)' : ''), async () => {
      for (const [id, st] of before) { const tr = findTr(stdId, id); if (tr) await setState(tr, st); }
      toast(`${label}: 원래 상태로 복구`);
    });
    renderPopup();
  }

  /* ================= 화면: 버튼/칩 주입 ================= */
  function css() {
    if (document.getElementById('mh-style')) return;
    const s = document.createElement('style');
    s.id = 'mh-style';
    s.textContent =
      '.mh-chip{display:inline-block;padding:0 7px;margin-right:4px;border-radius:9px;font-size:11px;line-height:18px}' +
      '.mh-btn{padding:3px 9px;border:0;border-radius:4px;background:#0F6E56;color:#fff;font-size:12px;cursor:pointer;white-space:nowrap}' +
      '.mh-btn.sub{background:#eee;color:#333}.mh-btn:disabled{opacity:.5;cursor:default}' +
      '.mh-name{border-bottom:1px dashed #888;cursor:pointer}' +
      '#mh-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99998;display:none;align-items:center;justify-content:center}' +
      '#mh-panel{width:92vw;height:88vh;background:#fff;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;font-size:13px;color:#222}' +
      '#mh-panel .hd{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #ddd}' +
      '#mh-panel .bd{flex:1;display:flex;min-height:0}' +
      '#mh-side{width:300px;border-right:1px solid #ddd;overflow:auto;padding:6px 8px}' +
      '#mh-main{flex:1;display:flex;flex-direction:column;min-width:0}' +
      '#mh-frames{flex:1;display:flex;min-height:0}#mh-frames>div{flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid #ddd}' +
      '#mh-frames .cap{font-size:11px;color:#888;padding:3px 8px}#mh-frames iframe{flex:1;border:0;width:100%}' +
      '#mh-info{padding:6px 12px;border-top:1px solid #ddd;font-size:12px;color:#444;max-height:70px;overflow:auto}' +
      '#mh-act{display:flex;gap:8px;padding:8px 12px;border-top:1px solid #ddd}' +
      '.mh-item{padding:6px 4px;border-top:1px solid #eee;cursor:pointer}.mh-item.sel{background:#eef4ff}' +
      '#mh-toast{position:fixed;right:16px;bottom:16px;z-index:99999;background:#1E2761;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;display:none;max-width:380px}';
    document.head.appendChild(s);
  }

  function injectUI() {
    css();
    getGroups().forEach((g) => {
      const s = getSt(g.id);
      // 표준 인물 번호 옆 [AI순으로 보기]
      if (g.srcTd) {
        let b = g.srcTd.querySelector('.mh-ai-btn');
        if (!b) {
          const wrap = document.createElement('div');
          wrap.className = 'mh-ai-wrap';
          b = document.createElement('button');
          b.type = 'button';
          b.className = 'mh-btn mh-ai-btn';
          b.style.marginTop = '4px';
          b.addEventListener('click', (e) => { e.stopPropagation(); startAI(g.id); });
          wrap.appendChild(b);
          g.srcTd.querySelector('.source-id-text').insertAdjacentElement('afterend', wrap);
        }
        const label = s.busy ? '판정 중…' : s.judged ? 'AI 순서 다시 보기' : 'AI순으로 보기';
        if (b.textContent !== label) b.textContent = label;
        b.disabled = s.busy;
      }
      g.rows.forEach((tr) => {
        // 후보 이름 -> 팝업
        const nameEl = tr.querySelector('td.target-title-col span.font-weight-bold');
        if (nameEl && !nameEl.classList.contains('mh-name')) {
          nameEl.classList.add('mh-name');
          nameEl.title = '다음 검색 / 교보문고 나란히 보기';
          nameEl.addEventListener('click', (e) => { e.stopPropagation(); ui.selId = candId(tr); openPopup(g.id); }, true);
        }
        // ★ 버튼
        const td = tr.querySelector('.v-btn-toggle') && tr.querySelector('.v-btn-toggle').closest('td');
        if (td && !td.querySelector('.mh-star')) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'mh-btn mh-star';
          b.style.marginLeft = '6px';
          b.textContent = '★ 매칭+나머지 금칙';
          b.addEventListener('click', (e) => { e.stopPropagation(); matchOne(g.id, candId(tr)); });
          td.appendChild(b);
        }
        // 비교 칩 + AI 뱃지
        const cell = tr.querySelector('td.target-title-col');
        if (cell) {
          let box = cell.querySelector('.mh-compare');
          if (!box) { box = document.createElement('div'); box.className = 'mh-compare'; box.style.cssText = 'margin-top:4px;font-size:12px'; cell.appendChild(box); }
          const d = detailOf(tr);
          let html = '';
          if (hasDetail(tr)) {
            const std = readStandard(d);
            const c = readCandidate(tr, d);
            const lc = localCompare(std, c);
            html += chipHtml(lc.job, '직업') + chipHtml(lc.birth, '출생');
            if (c.info) html += `<div style="color:#555;max-width:420px;white-space:normal">${esc(c.info.slice(0, 80))}</div>`;
          }
          const cv = CACHE[ckey(g.id, candId(tr))];
          if (cv) html = badgeHtml(cv.verdict) + html;
          if (box.innerHTML !== html) box.innerHTML = html;
        }
      });
    });
  }
  const refreshAll = () => injectUI();

  /* ================= 팝업 ================= */
  function ensureOverlay() {
    let o = document.getElementById('mh-overlay');
    if (o) return o;
    o = document.createElement('div');
    o.id = 'mh-overlay';
    o.innerHTML =
      '<div id="mh-panel"><div class="hd"><b id="mh-title"></b><span id="mh-usage" class="mh-chip" style="background:#eee;color:#555"></span>' +
      '<button class="mh-btn sub" id="mh-close" style="margin-left:auto">닫기 (Esc)</button></div>' +
      '<div class="bd"><div id="mh-side"></div><div id="mh-main"><div id="mh-frames">' +
      '<div><div class="cap" id="mh-cap1"></div><iframe id="mh-f1" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></div>' +
      '<div><div class="cap" id="mh-cap2"></div><iframe id="mh-f2" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></div>' +
      '</div><div id="mh-info"></div><div id="mh-act"></div></div></div></div>';
    document.body.appendChild(o);
    o.addEventListener('mousedown', (e) => { if (e.target === o) closePopup(); });
    o.querySelector('#mh-close').addEventListener('click', closePopup);
    return o;
  }
  function closePopup() { ui.open = false; const o = document.getElementById('mh-overlay'); if (o) o.style.display = 'none'; }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.open) closePopup(); });

  function openPopup(stdId) {
    ensureOverlay();
    ui.open = true; ui.stdId = stdId;
    document.getElementById('mh-overlay').style.display = 'flex';
    renderPopup();
    refreshAll();
  }

  function sortedJudged(stdId) {
    const g = rowsOf(stdId), s = getSt(stdId);
    if (!g) return [];
    return g.rows.slice(0, s.judged)
      .map((tr, i) => ({ tr, i, id: candId(tr), name: candName(tr), v: CACHE[ckey(stdId, candId(tr))] }))
      .filter((x) => x.v)
      .sort((a, b) => VERDICT[a.v.verdict].rank - VERDICT[b.v.verdict].rank || a.i - b.i);
  }

  function selectCand(id) { ui.selId = id; renderPopup(); }

  function renderPopup() {
    if (!ui.open) return;
    ensureOverlay();
    const stdId = ui.stdId, s = getSt(stdId), g = rowsOf(stdId);
    document.getElementById('mh-title').textContent = g ? `${g.id} ${g.name}` : stdId;
    document.getElementById('mh-usage').textContent = usageText();
    const list = sortedJudged(stdId);
    if (!ui.selId || !list.some((x) => x.id === ui.selId)) {
      if (!(ui.selId && g && g.rows.some((tr) => candId(tr) === ui.selId))) ui.selId = list[0] ? list[0].id : null;
    }

    const hasHigh = list.some((x) => x.v.verdict === 'high');
    const more = g ? (g.rows.length > s.judged || !!findMoreButton(g)) : false;
    const side = document.getElementById('mh-side');
    let h = '';
    if (s.error) h += `<div style="color:#a32d2d;padding:6px 4px;font-size:12px">${esc(s.error)}</div>`;
    h += list.map((x, i) =>
      `<div class="mh-item ${x.id === ui.selId ? 'sel' : ''}" data-id="${esc(x.id)}"><b>${i + 1}. ${esc(x.id)} ${esc(x.name)}</b><br>${badgeHtml(x.v.verdict)}<span style="color:#666;font-size:12px">${esc(x.v.reason)}</span></div>`).join('');
    if (!list.length && !s.error) h += '<div style="padding:8px 4px;color:#888">판정 결과가 없어요.</div>';
    if (more) {
      h += `<div style="padding:8px 4px">${hasHigh ? '' : '<div style="color:#633806;font-size:12px;margin-bottom:4px">높음이 없어요.</div>'}` +
        `<button class="mh-btn" id="mh-next" ${s.busy ? 'disabled' : ''}>${s.busy ? '판정 중…' : `다음 ${s.judged + 1}–${s.judged + CFG.PAGE_SIZE} 확인 (AI 1회)`}</button></div>`;
    } else if (list.length) {
      h += '<div style="padding:8px 4px;color:#888;font-size:12px">더 확인할 후보가 없어요. 일치하는 사람이 없으면 대기로 두세요.</div>';
    }
    side.innerHTML = h;
    side.querySelectorAll('.mh-item').forEach((el) => el.addEventListener('click', () => selectCand(el.dataset.id)));
    const nb = side.querySelector('#mh-next');
    if (nb) nb.addEventListener('click', () => nextPage(stdId));

    // 오른쪽: 프레임/정보/버튼
    const tr = ui.selId ? findTr(stdId, ui.selId) : null;
    const f1 = document.getElementById('mh-f1'), f2 = document.getElementById('mh-f2');
    let daum = '', kyobo = '', info = '';
    if (tr && g) {
      const d = detailOf(tr), c = readCandidate(tr, d);
      daum = `https://search.daum.net/search?w=profile2&DA=PRF&coll=person-main&q=${encodeURIComponent(g.name)}&spId=${encodeURIComponent(g.id)}`;
      kyobo = c.url;
      const v = CACHE[ckey(stdId, c.id)];
      info = `<b>${esc(c.id)} ${esc(c.name)}</b> ${v ? badgeHtml(v.verdict) : ''} · ${esc(c.info || '(저자정보 없음)')}`;
    }
    document.getElementById('mh-cap1').textContent = daum ? `다음 검색 · q=${g.name} spId=${g.id}` : '다음 검색';
    document.getElementById('mh-cap2').textContent = kyobo ? '교보문고 · ' + kyobo : '교보문고 (서비스 url 없음)';
    if (f1.dataset.src !== daum) { f1.dataset.src = daum; f1.src = daum || 'about:blank'; }
    if (f2.dataset.src !== kyobo) { f2.dataset.src = kyobo; f2.src = kyobo || 'about:blank'; }
    document.getElementById('mh-info').innerHTML = info || '목록에서 후보를 선택하세요.';

    const act = document.getElementById('mh-act');
    act.innerHTML = '<button class="mh-btn" id="mh-match">★ 매칭 + 나머지 금칙</button><button class="mh-btn sub" id="mh-skip">대기로 두고 다음</button>';
    act.querySelector('#mh-match').addEventListener('click', () => { if (ui.selId) matchOne(stdId, ui.selId); });
    act.querySelector('#mh-skip').addEventListener('click', () => {
      const i = list.findIndex((x) => x.id === ui.selId);
      selectCand(list[i + 1] ? list[i + 1].id : ui.selId);
    });
  }

  /* ================= 알림 (되돌리기) ================= */
  let toastTimer = null;
  function toast(msg, undoFn) {
    let box = document.getElementById('mh-toast');
    if (!box) { box = document.createElement('div'); box.id = 'mh-toast'; document.body.appendChild(box); }
    box.textContent = msg + ' ';
    box.style.display = 'block';
    clearTimeout(toastTimer);
    if (undoFn) {
      const b = document.createElement('button');
      b.textContent = '되돌리기';
      b.className = 'mh-btn';
      b.style.cssText = 'margin-left:8px;background:#00B4A6';
      b.onclick = async () => { box.style.display = 'none'; await undoFn(); };
      box.appendChild(b);
    }
    toastTimer = setTimeout(() => (box.style.display = 'none'), CFG.UNDO_SECONDS * 1000);
  }

  /* ================= 감시 ================= */
  let timer = null;
  const run = () => { if (document.querySelector('td.target-title-col')) injectUI(); };
  const mine = (n) => n && n.closest && n.closest('#mh-overlay,#mh-toast,.mh-compare,.mh-ai-btn,.mh-star');
  new MutationObserver((muts) => {
    if (muts.every((m) => mine(m.target.nodeType === 1 ? m.target : m.target.parentElement))) return;
    clearTimeout(timer);
    timer = setTimeout(run, 400);
  }).observe(document.body, { childList: true, subtree: true });
  run();

  // 테스트용 노출 (실사용에는 영향 없음)
  if (typeof window !== 'undefined') window.__mh = { getGroups, startAI, nextPage, matchOne, ui, ST, CACHE, localCompare, usageText };
})();
