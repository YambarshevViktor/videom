/* Video Manager — isolated world content script (document_start, all_frames).
 * - грузит настройки, проверяет вкл/сайты, шлёт настройки в MAIN-мир;
 * - DOM-адаптер качества (меню сайта: rezka и generic) — клик по пункту меню;
 * - бейдж поверх плеера (Shadow DOM, стекло), мини-панель, хоткей, фуллскрин;
 * - диагностика для popup/options.
 */
(() => {
  if (window.__VM_ISO_LOADED__) return;
  window.__VM_ISO_LOADED__ = true;
  const VM_VERSION = '0.1.38'; // <-- сверяйте с manifest.json; если в диагностике версия меньше — вкладка не перезагружена

  // ---------- «Добавлено»: дата заливки серии/фильма (data/updates.json в репозитории)
  // Сборщик .github/workflows/updates-collect.yml раз в день парсит главную
  // («Горячие обновления»: дата + тайтл + сезон/серия + озвучка как есть) и
  // дописывает records в data/updates.json. Бэкфилл — снапшоты главной из
  // веб-архива (~1 в неделю, окно каждого ~3 дня).
  // Форматы ключей — как в scripts/collect_updates.py:
  //   сериал: "<id>:s<season>e<episode>:<voice_norm>"
  //   фильм:  "<id>:m:<voice_norm>" (без сезона/серии)
  //   «Завершён»: "<id>:done:<voice_norm>" (строка уровня тайтла)
  //   перезаливы — отдельные записи: тот же key, другая date + reupload=true.
  // Расширение тянет JSON с raw.githubusercontent (CORS открыт), ищет точное
  // совпадение, иначе «залито целиком», иначе «неизвестно».
  // Что ещё тянет сборщик и зачем: title/url/type/year — для сверки и отладки
  // (видны в --dump); quality и рейтинг осознанно НЕ тащим — скачут и врут в истории.
  const DEFAULT_UPDATES_URL = 'https://raw.githubusercontent.com/YambarshevViktor/videom/main/data/updates.json';
  // ^-- поменяйте на свой репозиторий (или задайте updatesUrl в storage через
  // консоль options: chrome.storage.local.set({updatesUrl: 'https://.../updates.json'})).
  const UPDATES_TTL = 24 * 3600 * 1000;
  const updatesCache = { at: 0, byKey: new Map(), byId: new Map(), loaded: false, error: '', url: '' };
  function normVoiceJs(v) {
    try {
      return String(v || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
    } catch (e) { return ''; }
  }
  function updatesUrl() {
    try {
      if (S.updatesUrl) return S.updatesUrl;
    } catch (e) {}
    return DEFAULT_UPDATES_URL;
  }
  function updatesIndex(records) {
    updatesCache.byKey.clear(); updatesCache.byId.clear();
    for (const r of (records || [])) {
      if (!r || !r.key) continue;
      if (!updatesCache.byKey.has(r.key)) updatesCache.byKey.set(r.key, []);
      updatesCache.byKey.get(r.key).push(r);
      const id = Number(r.id) || 0;
      if (id) {
        if (!updatesCache.byId.has(id)) updatesCache.byId.set(id, []);
        updatesCache.byId.get(id).push(r);
      }
    }
    for (const [, arr] of updatesCache.byKey) arr.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
  }
  function updatesEnsure() {
    try {
      const url = updatesUrl();
      if (!url || /USERNAME\/REPO/.test(url)) return; // URL-заглушка — не дёргаем сеть
      if (updatesCache.loaded && Date.now() - updatesCache.at < UPDATES_TTL && updatesCache.url === url) return;
      if (updatesCache._busy) return;
      updatesCache._busy = true;
      const done = (records, err) => {
        updatesCache._busy = false;
        if (records) {
          updatesIndex(records);
          updatesCache.loaded = true; updatesCache.error = ''; updatesCache.at = Date.now(); updatesCache.url = url;
          try { chrome.storage.local.set({ vmUpdatesCache: { at: updatesCache.at, records } }); } catch (e) {}
          try { refreshVideoInfos(); } catch (e) {}
        } else if (err) {
          updatesCache.error = String(err).slice(0, 120);
        }
      };
      // сначала кэш из storage (чтобы «Добавлено» было сразу), потом сеть
      try {
        chrome.storage.local.get(['vmUpdatesCache'], (o) => {
          try {
            const c = o && o.vmUpdatesCache;
            if (c && c.records && c.records.length && Date.now() - (c.at || 0) < UPDATES_TTL) {
              updatesIndex(c.records);
              updatesCache.loaded = true; updatesCache.at = c.at; updatesCache.url = url;
              try { refreshVideoInfos(); } catch (e) {}
              if (Date.now() - c.at < UPDATES_TTL) { updatesCache._busy = false; return; }
            }
          } catch (e) {}
          fetch(url, { credentials: 'omit' }).then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          }).then((j) => done((j && j.records) || [], '')).catch((e) => done(null, (e && e.message) || e));
        });
      } catch (e) {
        fetch(url, { credentials: 'omit' }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then((j) => done((j && j.records) || [], '')).catch((e2) => done(null, (e2 && e2.message) || e2));
      }
    } catch (e) {}
  }
  function rezkaVoiceName() {
    try {
      const docs = [document];
      try { if (window.top && window.top !== window && window.top.document) docs.push(window.top.document); } catch (e) {}
      for (const d of docs) {
        try {
          const a = d.querySelector('#translators-list .active');
          if (a && a.textContent && a.textContent.trim()) return a.textContent.trim();
        } catch (e) {}
      }
    } catch (e) {}
    return '';
  }
  function fmtDateRu(iso) {
    try {
      const m = String(iso || '').match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return String(iso || '');
      const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
      return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1] + ' ' + m[1];
    } catch (e) { return String(iso || ''); }
  }
  function updatesLinesSync() {
    // Синхронно для mediaRowsPlain/диагностики (там только строки). Сеть — в фоне.
    try {
      const p = (typeof rezkaStreamParams === 'function') ? rezkaStreamParams() : null;
      if (!p) return [];
      try {
        const u = updatesUrl();
        if (!u || /USERNAME\/REPO/.test(u)) return; // URL не настроен — строки «Добавлено» нет
      } catch (e) { return []; }
      updatesEnsure();
      const voiceRaw = rezkaVoiceName();
      const vn = normVoiceJs((voiceRaw || '').split(',')[0]);
      const lines = [];
      const fmtRec = (r) => {
        let s = fmtDateRu(r.date);
        if (r.season && r.episode) s += ' — ' + r.season + ' сезон ' + r.episode + ' серия';
        else if (r.episode) s += ' — ' + r.episode + ' серия';
        if (r.voice) s += ' (' + r.voice + ')';
        if (r.reupload) s += ' — перезалив';
        return s;
      };
      if (!updatesCache.loaded) {
        return updatesCache.error ? ['История недоступна: ' + updatesCache.error] : ['Загружаю историю заливок…'];
      }
      const exactKey = p.isSeries
        ? (p.id + ':s' + (p.season || 0) + 'e' + (p.episode || 0) + ':' + (vn || '-'))
        : (p.id + ':m:' + (vn || '-'));
      const exact = updatesCache.byKey.get(exactKey) || [];
      for (const r of exact) lines.push(fmtRec(r));
      // «Завершён» — строка уровня тайтла, показываем вместе с серией
      if (p.isSeries) {
        const doneRecs = updatesCache.byKey.get(p.id + ':done:' + (vn || '-')) || [];
        for (const r of doneRecs) lines.push(fmtDateRu(r.date) + ' — сериал завершён' + (r.voice ? ' (' + r.voice + ')' : ''));
      }
      if (lines.length) return lines;
      // Точного совпадения нет: та же озвучка целиком? или вообще что-то по id?
      const pool = updatesCache.byId.get(p.id) || [];
      if (!pool.length) return ['Дата заливки неизвестна — в истории нет этого тайтла'];
      const sameVoice = vn ? pool.filter((r) => (r.voice_norm || '') === vn) : [];
      if (sameVoice.length) {
        const ds = sameVoice.map((r) => r.date).sort();
        return ['Точная серия не найдена — в этой озвучке залито целиком (' + fmtDateRu(ds[0]) + (ds.length > 1 ? ' … ' + fmtDateRu(ds[ds.length - 1]) : '') + ')'];
      }
      return ['Точная серия не найдена — залито целиком, озвучка другая'];
    } catch (e) { return []; }
  }

  const DEFAULTS = {
    enabled: true, mode: 'smart', cap: 2160, considerSize: true,
    badgeDefaultVisible: true, hotkey: 'v', closePanelOnShow: true,
    siteMode: 'blacklist', sites: [], perSite: {}, badgeHiddenTabs: {},
    speed: 1, speedStep: 0.25, preferredSpeed: 1.8, speedHotkeys: true, lastSpeedBeforeReset: 0,
    updatesUrl: '', // свой URL updates.json (по умолчанию DEFAULT_UPDATES_URL)
  };
  let S = { ...DEFAULTS };
  let mainState = { players: [], videos: [], events: [] };
  let mainAlive = false;
  let myTabId = null; // id своей вкладки (для повкладочного скрытия бейджа)

  // id вкладки — спрашиваем у background (в контент-скрипте его иначе не узнать)
  function requestTabId() {
    return new Promise((resolve) => {
      if (myTabId !== null && myTabId !== undefined) { resolve(myTabId); return; }
      try {
        chrome.runtime.sendMessage({ type: 'vm-tab-id' }, (res) => {
          const id = res && res.tabId !== undefined && res.tabId !== null ? res.tabId : null;
          if (id !== null) myTabId = id;
          resolve(id);
        });
      } catch (e) { resolve(null); }
    });
  }

  // ---------- настройки
  async function loadSettings() {
    try {
      const got = await chrome.storage.local.get(Object.keys(DEFAULTS).concat(['badgeHidden']));
      S = { ...DEFAULTS, ...got };
      delete S.badgeHidden; // legacy-флаг больше не используем
      if (S.mode !== 'smart' && S.mode !== 'max' && S.mode !== 'manual') {
        S.mode = 'smart'; // откат «быстрого»: чиним застрявшее значение
        try { chrome.storage.local.set({ mode: 'smart' }); } catch (e) {}
      }
      // старый общий флаг скрытия больше не используем — разово чистим;
      // новая загрузка страницы и так показывает бейдж (сброс в init)
      if (got.badgeHidden !== undefined) {
        try { await chrome.storage.local.remove('badgeHidden'); } catch (e) {}
      }
    } catch (e) { S = { ...DEFAULTS }; }
  }
  function pushSettingsToMain() {
    try {
      window.postMessage({
        source: 'vm-cmd', type: 'vm-settings',
        settings: { enabled: S.enabled, mode: S.mode, cap: S.cap, considerSize: S.considerSize },
      }, '*');
    } catch (e) {}
  }
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((chg, area) => {
      if (area !== 'local') return;
      let need = false;
      for (const k of Object.keys(DEFAULTS)) {
        if (chg[k]) { S[k] = chg[k].newValue; need = true; }
      }
      if (need) {
        pushSettingsToMain();
        // скрытие повкладочное: панели закрываем только в той вкладке, где скрыли
        if (chg.badgeHiddenTabs && S.closePanelOnShow !== false && myTabId !== null && myTabId !== undefined) {
          try {
            const ov = chg.badgeHiddenTabs.oldValue && chg.badgeHiddenTabs.oldValue[myTabId];
            const nv = chg.badgeHiddenTabs.newValue && chg.badgeHiddenTabs.newValue[myTabId];
            if (nv && !ov) {
              for (const rec of badges.values()) {
                rec.open = false;
                if (rec.panel) rec.panel.classList.remove('open');
              }
            }
          } catch (e) {}
        }
        // скорость могли поменять из попапа/настроек/другого фрейма —
        // доводим до видео принудительно (включая сброс в 1.0)
        if (chg.speed) { try { applySpeedAll(true); } catch (e) {} }
        refreshAllBadges();
      }
    });
  }

  // ---------- сайты
  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
  }
  function patternMatch(pattern, host) {
    const p = String(pattern || '').trim().toLowerCase();
    if (!p) return false;
    if (p === host) return true;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    // "rezka.ag" матчит и поддомены
    return host === p || host.endsWith('.' + p);
  }
  function siteAllowed(host) {
    if (S.perSite && S.perSite[host] === true) return true;
    if (S.perSite && S.perSite[host] === false) return false;
    const listed = (S.sites || []).some((p) => patternMatch(p, host));
    return S.siteMode === 'allowlist' ? listed : !listed;
  }
  function isActive() {
    if (!S.enabled) return false;
    try {
      if (window.top !== window) {
        // во фрейме: уважаем и хост фрейма, и хост топа (берём топ, если доступен)
        const topHost = hostOf(window.top.location.href);
        if (topHost && !siteAllowed(topHost)) return false;
      }
    } catch (e) { /* cross-origin top — проверяем свой хост */ }
    return siteAllowed(hostOf(location.href));
  }

  // ---------- мост с MAIN
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.source === 'vm-main' && (m.type === 'vm-state')) {
      mainAlive = true;
      mainState = m;
      onMainState();
    }
  });
  // fallback: если MAIN-мир недоступен (старый Chromium без world:MAIN) —
  // инжектим script-тегом. На сайтах со строгим CSP (YouTube) это режется
  // самим сайтом — тогда работает только DOM-адаптер из isolated-мира.
  // ВАЖНО: флаг window.__VM_MAIN_LOADED__ из isolated-мира не виден
  // (у миров разный JS-контекст), единственный сигнал — postMessage.
  setTimeout(() => {
    if (mainAlive) return;
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected_main.js');
      s.onload = () => s.remove();
      s.onerror = () => s.remove();
      (document.documentElement || document.head || document.body).appendChild(s);
      setTimeout(() => {
        try { window.postMessage({ source: 'vm-cmd', type: 'vm-ping' }, '*'); } catch (e) {}
      }, 800);
    } catch (e) {}
  }, 2500);

  setInterval(() => {
    try { window.postMessage({ source: 'vm-cmd', type: 'vm-ping' }, '*'); } catch (e) {}
  }, 10000);

  // ---------- DOM-адаптер качества (меню сайта)
  // Строгий парсер: голые числа принимаем только из известных высот,
  // иначе годы («2024») и прочий мусор ломали бы выбор уровня.
  const KNOWN_H = [144, 240, 360, 480, 540, 720, 800, 1080, 1440, 2160, 2880, 4320];
  function parseQLabel(text) {
    const t = String(text || '').trim();
    const ultra = /ultra/i.test(t);
    let m = t.match(/(\d{3,4})\s*p\b/i);
    if (!m) {
      const bare = t.match(/^(\d{3,4})$/);
      if (bare && KNOWN_H.includes(parseInt(bare[1], 10))) m = bare;
    }
    if (m) {
      const h = parseInt(m[1], 10);
      let rank = h >= 2000 ? 5 : h >= 1300 ? 4 : h >= 1000 ? 3 : h >= 650 ? 2 : h >= 430 ? 1 : 0;
      if (ultra && h === 1080) rank = 3.5;
      return { label: t, height: h, ultra, rank };
    }
    if (/4k|uhd/i.test(t)) return { label: t, height: 2160, rank: 5 };
    if (/2k/i.test(t)) return { label: t, height: 1440, rank: 4 };
    if (/fhd/i.test(t)) return { label: t, height: 1080, rank: 3 };
    if (/^hd$/i.test(t)) return { label: t, height: 720, rank: 2 };
    if (/^sd$/i.test(t)) return { label: t, height: 480, rank: 1 };
    return null;
  }
  // Вытаскивает чистый токен качества из составного текста
  // («Качество 360p» -> «360p», «1080p Ultra» -> «1080p Ultra»).
  function extractQToken(t) {
    const s = String(t || '');
    let m = s.match(/(\d{3,4}\s*p\s*ultra)/i);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
    m = s.match(/(\d{3,4}\s*p)\b/i);
    if (m) return m[1].replace(/\s+/g, '').trim();
    m = s.match(/\b(4k|uhd|2k|fhd)\b/i);
    if (m) return m[1].toUpperCase();
    m = s.match(/^(hd|sd)$/i);
    if (m) return m[1].toUpperCase();
    m = s.match(/(\d{3,4})/);
    if (m && KNOWN_H.includes(parseInt(m[1], 10))) return m[1] + 'p';
    return null;
  }
  function capRank() {
    const map = { 360: 0, 480: 1, 720: 2, 1080: 3, 1081: 3.5, 1440: 4, 2160: 5 };
    return map[S.cap] !== undefined ? map[S.cap] : 5;
  }
  function sizeCapRankFor(video) {
    try {
      const fs = document.fullscreenElement;
      let h = fs ? (fs.clientHeight || screen.height) : (video ? (video.clientHeight || 0) : 0);
      if (!h || h < 120) return 5;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const t = h * dpr;
      if (t <= 400) return 0;
      if (t <= 560) return 1;
      if (t <= 900) return 2;
      if (t <= 1200) return 3;
      if (t <= 1700) return 4;
      return 5;
    } catch (e) { return 5; }
  }
  function targetRank(video) {
    let r = capRank();
    if (S.mode === 'max') return 5; // максимум берёт высший доступный (потолок не применяется)
    if (S.mode === 'smart' && S.considerSize) r = Math.min(r, sizeCapRankFor(video));
    return r;
  }
  // max: всегда высший доступный уровень (потолок не применяется — так задумано)

  function visible(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (e) { return false; }
  }
  function findQualityItems(root) {
    const out = [];
    try {
      // pjsdiv/[fid]/[f2id] — кастомные теги меню CDN-плеера (rezka и зеркала)
      const SEL = 'button,li,div,span,a,pjsdiv,[fid],[f2id],[role="menuitem"],[role="option"]';
      const els = (root && root !== document) ? root.querySelectorAll(SEL) : deepQueryAll(SEL);
      for (const el of els) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!txt || txt.length > 24) continue;
        // пункт должен выглядеть как качество, а не контейнер с кучей текста
        if (el.children.length > 2) continue;
        const q = parseQLabel(txt.split('\n')[0]);
        if (!q) continue;
        if (!visible(el)) continue;
        out.push({ el, q });
      }
    } catch (e) {}
    return out;
  }
  // ---------- глубокий поиск по DOM + открытым shadowRoot (плеер может жить в тени)
  let rootCache = { t: 0, roots: [] };
  function scanRoots() {
    const now = Date.now();
    if (rootCache.roots.length && now - rootCache.t < 10000) return rootCache.roots;
    const roots = [document];
    try {
      const queue = [document];
      let guard = 0;
      while (queue.length && roots.length < 50 && guard++ < 50000) {
        const node = queue.shift();
        let all;
        try { all = node.querySelectorAll ? node.querySelectorAll('*') : []; }
        catch (e) { continue; }
        for (const el of all) {
          try {
            if (el.shadowRoot && !roots.includes(el.shadowRoot)) {
              roots.push(el.shadowRoot);
              queue.push(el.shadowRoot);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    rootCache = { t: now, roots };
    return roots;
  }
  function deepQueryAll(sel) {
    const out = [];
    for (const r of scanRoots()) {
      try { for (const el of r.querySelectorAll(sel)) out.push(el); }
      catch (e) {}
    }
    return out;
  }
  function describeEl(el) {
    try {
      const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const attrs = [];
      if (el.getAttribute) {
        for (const a of ['fid', 'f2id', 'aria-label', 'title', 'role', 'id']) {
          const v = el.getAttribute(a);
          if (v) attrs.push(a + '=' + String(v).slice(0, 30));
        }
        const cl = (el.getAttribute('class') || '').slice(0, 40);
        if (cl) attrs.push('class=' + cl);
      }
      return (el.tagName || '?').toLowerCase() + ' "' + t + '"' + (attrs.length ? ' [' + attrs.join(' ') + ']' : '');
    } catch (e) { return '?'; }
  }
  // «Человеческий» клик: серия событий с координатами + el.click().
  // Часть плееров слушает mousedown, а не click — покрываем оба.
  function mouseClick(el) {
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
      try { el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true })); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
      try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {}
      try { el.click(); } catch (e) {}
    } catch (e) {}
  }
  function isActiveItem(item) {
    const el = item.el;
    try {
      if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') return true;
      const c = (el.className || '').toString().toLowerCase();
      // pjs-cdnplayer-active-menu — активный пункт CDN-плеера (rezka и зеркала)
      if (/active-menu/.test(c)) return true;
      if (/inactive/.test(c)) return false;
      if (/(^|\s)active(\s|$)/.test(' ' + c + ' ') || /(selected|current|checked)/.test(c)) return true;
      if (el.parentElement) {
        const pc = (el.parentElement.className || '').toString().toLowerCase();
        if (/active|selected/.test(pc) && el.parentElement.querySelectorAll) {
          // эвристика: родитель подсвечен — считаем активным только если нет соседей с подсветкой
        }
      }
    } catch (e) {}
    return false;
  }

  let gidSeq = 0;
  // Группируем кандидатов по контейнеру-меню. Настоящее меню качества —
  // это 2+ пункта с разными рангами в одном контейнере. Одиночные совпадения
  // (годы, «HD»-плашки, жанры) отбрасываем — это был главный источник мусора.
  function groupByMenu(items) {
    const groups = new Map();
    for (const it of items) {
      let cont = null;
      try {
        cont = it.el.closest('[role="menu"],[role="listbox"],ul,[class*="menu" i],[class*="quality" i],[class*="settings" i],[class*="resolution" i]') || it.el.parentElement;
      } catch (e) { cont = null; }
      const k = cont ? (cont.__vm_gid || (cont.__vm_gid = ++gidSeq)) : 0;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    let best = null;
    for (const g of groups.values()) {
      const ranks = new Set(g.map((x) => x.q.rank));
      if (ranks.size < 2) continue; // не меню
      if (!best || g.length > best.length) best = g;
    }
    return best || [];
  }
  // Кнопка, открывающая меню качества. ВАЖЕН ПОРЯДОК:
  // 1) строка «Качество ...» ([fid]) — кликать надо именно её, а не внутреннюю
  //    подпись-значение (у неё pointer-events:none, клик по ней ничего не строит);
  // 2) aria/title про качество; 3) маленькие кнопки с уровнем (вне [fid]-строк).
  function findQualityOpener() {
    try {
      const els = deepQueryAll('button,[role="button"],pjsdiv,[fid]');
      // 1) строка «Качество»
      for (const el of els) {
        const txt = (el.innerText || el.textContent || '').trim() || '';
        if (!/качеств/i.test(txt)) continue;
        if (!extractQToken(txt)) continue;
        try {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        } catch (e) { continue; }
        // предпочитаем саму строку [fid], а не её внутренности
        if (el.hasAttribute && el.hasAttribute('fid')) return el;
      }
      for (const el of els) {
        const txt = (el.innerText || el.textContent || '').trim() || '';
        if (!/качеств/i.test(txt)) continue;
        if (!extractQToken(txt)) continue;
        try {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        } catch (e) { continue; }
        return el;
      }
      // 2) aria/title
      for (const el of els) {
        const a = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''));
        if (/качеств|quality|resolution/i.test(a) && visible(el)) return el;
      }
      // 3) маленькая кнопка с уровнем — но НЕ внутри [fid]-строки
      for (const el of els) {
        try {
          if (el.closest && el.closest('[fid]')) continue;
        } catch (e) {}
        const txt = (el.innerText || el.textContent || '').trim().split('\n')[0] || '';
        if (!txt || txt.length > 14) continue;
        if (el.children.length > 1) continue;
        if (parseQLabel(txt) && visible(el)) return el;
      }
    } catch (e) {}
    return null;
  }

  // ---------- pjs-адаптер (CDN-плеер rezka и зеркал: <pjsdiv f2id="1..7">)
  // Пункты существуют в DOM всегда (пусть и скрытые), клик по скрытому пункту
  // работает — плеер перезагружает поток. Поэтому видимость здесь не требуем,
  // а применение проверяем по переезду класса активного пункта.
  // Если подменю нет в DOM — открываем цепочку: шестерёнка -> «Качество».
  function pjsRows(root) {
    const out = [];
    try {
      const els = (root && root !== document && root.querySelectorAll)
        ? root.querySelectorAll('[f2id]')
        : deepQueryAll('[f2id]');
      for (const el of els) {
        const txt = (el.innerText || el.textContent || '').trim().split('\n')[0] || '';
        const tok = extractQToken(txt);
        if (!tok) continue; // заголовок «Качество» (f2id=0) отсеивается сам
        const q = parseQLabel(tok);
        if (!q) continue;
        out.push({ el, q });
      }
    } catch (e) {}
    return out;
  }
  // Кандидаты в шестерёнки: видимые кликабельные иконки без текста.
  // Полноэкранный режим синтетическим кликом не включается (нужен жест),
  // play/pause/mute — откатываем назад, риск минимален.
  function gearCandidates(root) {
    const out = [];
    try {
      const scope = (root && root.querySelectorAll) ? root : document;
      const els = scope.querySelectorAll('pjsdiv,button,div,span,a,[role="button"]');
      for (const el of els) {
        try {
          if (el.tagName === 'VIDEO') continue;
          if (el.querySelector && el.querySelector('video')) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if ((cs.cursor || '') !== 'pointer') continue;
          const r = el.getBoundingClientRect();
          if (!r || r.width < 16 || r.height < 16 || r.width > 70 || r.height > 70) continue;
          const txt = (el.innerText || el.textContent || '').trim();
          if (txt.length > 0) continue;
          if (!el.querySelector || !el.querySelector('svg')) continue;
          out.push(el);
        } catch (e) {}
      }
    } catch (e) {}
    return out;
  }
  function fpOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return el.tagName + '|' + (el.className || '').toString().slice(0, 60) + '|' +
        Math.round(r.left) + 'x' + Math.round(r.top) + '|' + (el.innerHTML || '').length;
    } catch (e) { return 'x' + Math.random(); }
  }
  function settingsVisible() {
    try {
      const s = deepQueryAll('#cdnplayer_settings')[0] || document.getElementById('cdnplayer_settings');
      if (s) {
        const cs = getComputedStyle(s);
        if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
      }
      const fids = deepQueryAll('[fid]');
      for (const f of fids) {
        try {
          const cs = getComputedStyle(f);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const t = (f.innerText || f.textContent || '').trim();
          if (/качеств/i.test(t)) return true;
        } catch (e) {}
      }
    } catch (e) {}
    return false;
  }
  function snapPlayback(v) {
    try { return { paused: v.paused, muted: v.muted, volume: v.volume }; }
    catch (e) { return {}; }
  }
  function revertPlayback(v, s) {
    if (!s) return;
    try {
      if (typeof s.muted === 'boolean' && v.muted !== s.muted) v.muted = s.muted;
      if (typeof s.volume === 'number' && Math.abs(v.volume - s.volume) > 0.01) v.volume = s.volume;
      if (s.paused === false && v.paused === true) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
      if (s.paused === true && v.paused === false) v.pause();
    } catch (e) {}
  }
  // Перебор кнопок-кандидатов: по одной за раз, с проверкой результата.
  // Возвращает true, если цепочкой занимается (generic-путь пропускаем).
  function gearStep(video, ctl) {
    const now = Date.now();
    if (ctl.gearTest) {
      const t = ctl.gearTest;
      if (now - t.t < 800) return true; // ждём реакцию плеера
      const opened = settingsVisible();
      revertPlayback(video, t.snap);
      ctl.gearTest = null;
      if (opened) {
        ctl.gear = t.el;
        logDom('DOM: шестерёнка найдена, настройки открыты');
      } else {
        logDom('DOM: кнопка не открыла настройки, пробую следующую');
      }
      return true;
    }
    if (ctl.gear) {
      if (settingsVisible()) return true;
      if (now - (ctl.lastGearTry || 0) < 2500) return true;
      ctl.lastGearTry = now;
      try { mouseClick(ctl.gear); logDom('DOM: клик по известной шестерёнке -> ' + describeEl(ctl.gear)); } catch (e) {}
      return true;
    }
    if (now - (ctl.lastGearTry || 0) < 2500) return true;
    let list = gearCandidates(containerOf(video));
    if (!list.length) list = gearCandidates(document);
    if (!list.length) return false;
    if (!ctl.gearTried) ctl.gearTried = new Set();
    const next = list.find((el) => !ctl.gearTried.has(fpOf(el)));
    if (!next) {
      if (now - (ctl.gearReset || 0) > 60000) { ctl.gearTried = new Set(); ctl.gearReset = now; }
      else logDom('DOM: все кнопки перебраны, шестерёнка не найдена');
      return true;
    }
    ctl.gearTried.add(fpOf(next));
    ctl.lastGearTry = now;
    const snap = snapPlayback(video);
    try { mouseClick(next); } catch (e) {}
    ctl.gearTest = { el: next, t: now, snap };
    logDom('DOM: пробую кнопку настроек (' + ctl.gearTried.size + '/' + list.length + ') -> ' + describeEl(next));
    return true;
  }
  function pjsTick(video, ctl) {
    const now = Date.now();
    const root = containerOf(video);
    let rows = pjsRows(root);
    if (!rows.length && root !== document) rows = pjsRows(document);
    if (rows.length < 2) return false; // не pjs-меню — пусть работает generic-путь
    const seen = new Map();
    for (const r of rows) {
      const k = r.q.rank;
      if (!seen.has(k)) seen.set(k, r);
    }
    const uniq = [...seen.values()].sort((a, b) => a.q.rank - b.q.rank);
    ctl.uniq = uniq;
    ctl.items = uniq.map((u) => ({ label: u.q.label, rank: u.q.rank }));
    ctl.pjs = true;
    const active = uniq.find((u) => isActiveItem({ el: u.el }));
    // проверка прошлого клика: класс активного переехал?
    if (ctl.pendingRank != null) {
      if (active && Math.abs(active.q.rank - ctl.pendingRank) < 1e-9) {
        logDom('DOM pjs OK: применилось ' + active.q.label);
        ctl.pendingRank = null;
        ctl.curRank = active.q.rank;
      } else if (now - ctl.pendingSince > 9000) {
        logDom('DOM pjs НЕ применилось за 9с — попробуем ещё раз');
        ctl.pendingRank = null;
      } else {
        ctl.curRank = active ? active.q.rank : ctl.curRank;
        return true; // ждём перезагрузку потока
      }
    }
    if (active) ctl.curRank = active.q.rank;
    const wantMax = S.mode === 'max';
    const tr = wantMax ? 99 : targetRank(video);
    let want = null;
    for (const u of uniq) { if (u.q.rank <= tr + 1e-9) want = u; }
    if (!want) want = uniq[0];
    const activeRank = active ? active.q.rank : -1;
    if (Math.abs(activeRank - want.q.rank) < 1e-9) return true; // уже то
    if (now - ctl.lastClick < 6000) return true;
    if (ctl.clicks >= 4 && !ctl.stallArmed) return true;
    try {
      mouseClick(want.el);
      ctl.lastClick = now; ctl.clicks++;
      ctl.pendingRank = want.q.rank; ctl.pendingSince = now;
      ctl.curRank = want.q.rank;
      logDom('DOM pjs click -> ' + want.q.label + ' @ ' + describeEl(want.el));
    } catch (e) {}
    return true;
  }

  const domCtl = new WeakMap(); // video -> {items, clicks, lastClick, stable}
  function containerOf(video) {
    try {
      const c = video.closest('[class*="player" i],[id*="player" i],[class*="video" i],[class*="media" i]');
      if (c) return c;
      return video.parentElement || document;
    } catch (e) { return document; }
  }

  function domTick(video, force) {
    if (!isActive()) return;
    if (video.dataset && video.dataset.vmVid) {
      // этим видео управляет API-плеер — DOM не трогаем
      const bound = (mainState.players || []).some((p) => p.id === video.dataset.vmVid);
      if (bound) return;
    }
    let ctl = domCtl.get(video);
    if (!ctl) { ctl = { clicks: 0, lastClick: 0, curRank: -1, lastScan: 0 }; domCtl.set(video, ctl); }
    // CDN-плеер rezka: сначала точечный pjs-адаптер (работает и со скрытым меню)
    try {
      if (pjsTick(video, ctl)) {
        const rec = badges.get(video);
        if (rec) updateBadge(rec);
        return;
      }
    } catch (e) {}
    const now = Date.now();
    let uniq = ctl.uniq || null;
    if (!uniq || force || now - ctl.lastScan >= 3000) {
      ctl.lastScan = now;
      const root = containerOf(video);
      // меню может быть в оверлее на уровне body (rezka) — ищем и в контейнере, и в body
      let items = findQualityItems(root);
      if (!items.length && root !== document) items = findQualityItems(document);
      let grouped = groupByMenu(items);
      if (!grouped.length) {
        // меню закрыто — пробуем открыть кнопку качества (не чаще раза в 10 c)
        const op = findQualityOpener();
        if (op) {
          const tok = extractQToken((op.innerText || op.textContent || '').trim());
          const oq = tok ? parseQLabel(tok) : null;
          if (oq) { // на кнопке написан текущий уровень — показываем его в бейдже
            ctl.items = [{ label: oq.label, rank: oq.rank }];
            ctl.curRank = oq.rank;
          }
          if (now - (ctl.lastOpener || 0) > 10000) {
            ctl.lastOpener = now;
            try { mouseClick(op); logDom('DOM: клик-открывалка -> ' + describeEl(op)); } catch (e) {}
          }
        } else {
          // не на что нажать — ищем шестерёнку перебором (с откатом состояния)
          try { gearStep(video, ctl); } catch (e) {}
        }
        if (!ctl.items) return;
        uniq = ctl.uniq || null;
        if (!uniq) return;
      } else {
        // дедуплика по label
        const seen = new Map();
        for (const it of grouped) {
          const key = it.q.rank + '|' + it.q.label.toLowerCase();
          if (!seen.has(key)) seen.set(key, it);
        }
        uniq = [...seen.values()].sort((a, b) => a.q.rank - b.q.rank);
        ctl.uniq = uniq;
        ctl.items = uniq.map((u) => ({ label: u.q.label, rank: u.q.rank }));
      }
    }
    let active = uniq.find((u) => isActiveItem(u));
    const wantMax = S.mode === 'max';
    const tr = wantMax ? 99 : targetRank(video);
    let want = null;
    for (const u of uniq) { if (u.q.rank <= tr + 1e-9) want = u; }
    if (!want) want = uniq[0];
    const activeRank = active ? active.q.rank : -1;
    ctl.curRank = activeRank;
    if (Math.abs(activeRank - want.q.rank) < 1e-9) return; // уже то
    // защита от циклов: не чаще 1 клика в 6 c, не больше 4 авто-кликов, кроме отката при stall
    if (now - ctl.lastClick < 6000) return;
    if (ctl.clicks >= 4 && !ctl.stallArmed) return;
    try {
      mouseClick(want.el);
      ctl.lastClick = now; ctl.clicks++;
      ctl.curRank = want.q.rank;
      logDom('DOM click -> ' + want.q.label + ' (mode=' + S.mode + ')');
    } catch (e) {}
  }

  // stall-детект для DOM-плееров: два подряд waiting>2.5с — шаг вниз
  const stallMap = new WeakMap();
  function watchStall(video) {
    if (stallMap.has(video)) return;
    const st = { waitingSince: 0, bad: 0 };
    stallMap.set(video, st);
    video.addEventListener('waiting', () => { st.waitingSince = Date.now(); });
    video.addEventListener('playing', () => {
      st.waitingSince = 0;
      const ctl = domCtl.get(video);
      if (ctl) ctl.stallArmed = false;
    });
    setInterval(() => {
      try {
        if (!st.waitingSince) return;
        if (Date.now() - st.waitingSince < 2500) return;
        st.waitingSince = Date.now();
        st.bad++;
        if (st.bad < 2) return; // один stall прощаем
        st.bad = 0;
        if (S.mode !== 'smart') return;
        if (video.dataset && video.dataset.vmVid) return; // API-плеер сам разрулит
        const ctl = domCtl.get(video);
        if (!ctl || !ctl.items || !ctl.items.length) return;
        ctl.stallArmed = true; // разрешаем клик сверх лимита
        // кликаем на шаг ниже текущего
        const cur = ctl.curRank;
        const lower = ctl.items.filter((x) => x.rank < cur - 1e-9).pop();
        const target = lower || ctl.items[0];
        // найти элемент заново (findQualityItems кэширует seen — сбросим флаги)
        const root = containerOf(video);
        const items = findQualityItems(root);
        const cand = items.find((u) => Math.abs(u.q.rank - target.rank) < 1e-9) ||
          (root !== document ? findQualityItems(document).find((u) => Math.abs(u.q.rank - target.rank) < 1e-9) : null);
        if (cand) {
          try { mouseClick(cand.el); ctl.lastClick = Date.now(); ctl.curRank = target.rank; logDom('DOM step down -> ' + target.label + ' @ ' + describeEl(cand.el)); } catch (e) {}
        }
      } catch (e) {}
    }, 1500);
  }

  // ---------- Скорость видео (напрямую video.playbackRate, без меню плеера)
  // Ставится в isolated-мире: video-элемент общий для обоих миров, поэтому
  // MAIN-мир не нужен — работает и на generic/mp4, и под строгим CSP.
  // Качество по-прежнему переключается через меню сайта, скорость — только так.
  const SPEED_MIN = 0.07, SPEED_MAX = 16; // широкий диапазон: 0.07–16
  const speedApplyAt = new WeakMap(); // media -> ts последнего применения (анти-зацикливание)
  const speedRetry = new WeakMap(); // media -> id таймера дотяжки (чтобы не копились)
  // Пропущенное из-за 400мс-троттлинга применение не теряем: одна отложенная
  // дотяжка, которая перечитает свежее want. Анти-зацикливание сохраняется —
  // чаще ~2 раз в секунду элемент не дёргаем.
  function queueSpeedRetry(m, force) {
    try {
      if (speedRetry.has(m)) return; // уже ждёт — она перечитает актуальное want
      const id = setTimeout(() => {
        try { speedRetry.delete(m); } catch (e) {}
        try { applySpeed(m, force); } catch (e) {}
      }, 420);
      speedRetry.set(m, id);
    } catch (e) {}
  }
  const speedTouched = new WeakSet(); // media, которым скорость ставили МЫ (их доводим всегда, даже до 1.0)
  function clampSpeed(n) {
    n = Number(n);
    if (!isFinite(n)) return 1;
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(n * 100) / 100));
  }
  function desiredSpeed() {
    const v = Number(S.speed);
    return isFinite(v) ? clampSpeed(v) : 1;
  }
  function speedStep() {
    const v = Number(S.speedStep);
    return v > 0 && isFinite(v) ? Math.min(4, v) : 0.25;
  }
  // force=true — явный выбор пользователя (кнопка/хоткей/попап): доводим до видео
  // всегда, включая сброс в 1.0. Без force нетронутое видео при want==1 не трогаем.
  function applySpeed(m, force) {
    if (!isActive()) return;
    const want = desiredSpeed();
    try {
      if (Math.abs((m.playbackRate || 1) - want) < 1e-6) return;
      if (!force && Math.abs(want - 1) < 1e-9 && !speedTouched.has(m)) return;
      const last = speedApplyAt.get(m) || 0;
      if (Date.now() - last < 400) { queueSpeedRetry(m, force); return; }
      speedApplyAt.set(m, Date.now());
      m.playbackRate = want;
      speedTouched.add(m);
      logDom('DOM speed -> ' + want + '×');
    } catch (e) {}
  }
  function applySpeedAll(force) {
    try {
      for (const m of document.querySelectorAll('video,audio')) applySpeed(m, force);
    } catch (e) {}
  }
  async function setSpeed(n) {
    const v = clampSpeed(n);
    S.speed = v;
    try { await chrome.storage.local.set({ speed: v }); } catch (e) {}
    applySpeedAll(true);
    refreshAllBadges();
  }
  function watchSpeed(m) {
    if (!m || m.__vm_speedWatched) return;
    m.__vm_speedWatched = true;
    // fightback: сайт сбросил скорость — возвращаем выбранную.
    // Нетронутое нами видео при want==1 оставляем сайту; наши доводим всегда.
    m.addEventListener('ratechange', () => {
      try {
        const want = desiredSpeed();
        if (!isActive()) return;
        if (Math.abs((m.playbackRate || 1) - want) < 1e-6) return;
        if (Math.abs(want - 1) < 1e-9 && !speedTouched.has(m)) return;
        setTimeout(() => { try { applySpeed(m); } catch (e) {} }, 120);
      } catch (e) {}
    });
    // новый поток / перемотка на новый src — сайт мог сбросить скорость
    m.addEventListener('loadedmetadata', () => { try { applySpeed(m); } catch (e) {} });
    m.addEventListener('play', () => { try { applySpeed(m); } catch (e) {} });
  }

  const domLog = [];
  function logDom(t) {
    domLog.push({ t: new Date().toISOString(), text: t });
    if (domLog.length > 20) domLog.shift();
  }

  // ---------- Бейдж (Shadow DOM, стекло)
  const badges = new Map(); // video -> {host, shadow, els}
  function badgeAllowed() {
    // скрытие — только для своей вкладки; новая вкладка всегда начинает с видимого бейджа
    return S.badgeDefaultVisible && !(S.badgeHiddenTabs && myTabId !== null && myTabId !== undefined && S.badgeHiddenTabs[myTabId]);
  }
  function playerForVideo(video) {
    const id = video.dataset && video.dataset.vmVid;
    if (!id) return null;
    return (mainState.players || []).find((p) => p.id === id) || null;
  }
  function currentLabel(video) {
    const p = playerForVideo(video);
    if (p && p.levels && p.levels.length && p.current >= 0 && p.levels[p.current]) {
      return { text: p.levels[p.current].label, state: S.mode, api: true, player: p };
    }
    const ctl = domCtl.get(video);
    if (ctl && ctl.items && ctl.items.length && ctl.curRank >= 0) {
      const it = ctl.items.find((x) => Math.abs(x.rank - ctl.curRank) < 1e-9) || ctl.items[ctl.items.length - 1];
      return { text: it.label, state: S.mode, api: false, player: null };
    }
    return { text: 'Поиск…', state: 'unknown', api: false, player: null };
  }

  const DOT = { max: '#38d977', smart: '#3aa0ff', manual: '#a8adb7', unknown: '#ff5d5d' };

  function ensureBadge(video) {
    if (badges.has(video)) return badges.get(video);
    const host = document.createElement('div');
    host.setAttribute('data-vm-badge', '1');
    const sh = host.attachShadow({ mode: 'open' });
    const css = document.createElement('style');
    css.textContent = `
      :host{position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:2147483646;font-family:Inter,-apple-system,'SF Pro Text','Segoe UI',Roboto,sans-serif;pointer-events:auto}
      .b{display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.02em;color:#fff;cursor:pointer;user-select:none;
        background:linear-gradient(135deg,rgba(30,32,44,.62),rgba(30,32,44,.42));border:1px solid rgba(255,255,255,.22);
        -webkit-backdrop-filter:blur(14px) saturate(1.4);backdrop-filter:blur(14px) saturate(1.4);
        box-shadow:0 4px 18px rgba(0,0,0,.35);transition:opacity .25s,transform .25s}
      .b:hover{transform:translateY(-1px)}
      .b{touch-action:none}
      .dot{width:8px;height:8px;border-radius:50%;background:#3aa0ff;box-shadow:0 0 6px currentColor}
      .panel{position:absolute;left:50%;transform:translateX(-50%);top:calc(100% + 8px);width:230px;padding:12px;border-radius:18px;color:#f2f3f6;display:none;
        background:linear-gradient(160deg,rgba(38,40,54,.78),rgba(24,25,34,.72));border:1px solid rgba(255,255,255,.18);
        -webkit-backdrop-filter:blur(20px) saturate(1.5);backdrop-filter:blur(20px) saturate(1.5);box-shadow:0 12px 40px rgba(0,0,0,.45)}
      .panel.open{display:block}
      .pt{font-size:11px;opacity:.65;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.08em}
      .panel>.pt:first-child{margin-top:2px}
      .row{display:flex;gap:6px;margin-bottom:8px}
      .mbtn{flex:1;padding:7px 0;font-size:11.5px;font-weight:600;text-align:center;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#fff;cursor:pointer}
      .mbtn.on{background:linear-gradient(135deg,#5b8cff,#8b5cf6);border-color:transparent}
      .caps{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .c{padding:5px 9px;font-size:11px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;cursor:pointer}
      .c.on{background:linear-gradient(135deg,#5b8cff,#8b5cf6);border-color:transparent}
      .lvls{display:flex;flex-wrap:wrap;gap:6px;max-height:96px;overflow:auto;margin-bottom:8px}
      .frow{display:flex;gap:6px;margin-top:10px}
      .frow+.frow{margin-top:6px}
      .srow{display:flex;gap:6px;margin-bottom:8px;align-items:stretch}
      .sbtn{flex:1;padding:7px 0;font-size:12.5px;font-weight:700;text-align:center;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#fff;cursor:pointer}
      .sbtn:hover{background:rgba(255,255,255,.14)}
      .sval{flex:1.4;padding:7px 0;font-size:12.5px;font-weight:700;text-align:center;border-radius:10px;background:linear-gradient(135deg,#5b8cff,#8b5cf6);border:1px solid transparent;color:#fff;cursor:pointer}
      .fbtn{flex:1;padding:7px 0;font-size:11px;text-align:center;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#fff;cursor:pointer}
      .fbtn:hover{background:rgba(255,255,255,.14)}
      .hide{opacity:0;pointer-events:none}
    `;
    sh.appendChild(css);
    const b = document.createElement('div');
    b.className = 'b';
    b.innerHTML = '<span class="dot"></span><span class="t">Поиск…</span>';
    const panel = document.createElement('div');
    panel.className = 'panel';
    sh.appendChild(b);
    sh.appendChild(panel);
    const rec = { host, sh, b, panel, video, open: false };
    badges.set(video, rec);

    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (rec.justDragged) { rec.justDragged = false; return; }
      rec.open = !rec.open;
      panel.classList.toggle('open', rec.open);
      if (rec.open) renderPanel(rec);
    });
    // drag: тянем за бейдж, клик после перетаскивания панель не открывает
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button > 0) return;
      const startX = e.clientX, startY = e.clientY;
      const origLeft = host.offsetLeft, origTop = host.offsetTop;
      let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        moved = true;
        host.style.left = (origLeft + dx) + 'px';
        host.style.top = (origTop + dy) + 'px';
        host.style.transform = 'none';
        host.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        if (moved) {
          rec.justDragged = true;
          setTimeout(() => { rec.justDragged = false; }, 80);
          saveBadgePos(host);
        }
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
    placeBadge(video, host);
    updateBadge(rec);
    return rec;
  }

  function placeBadge(video, host) {
    try {
      let wrap = null;
      try { wrap = video.closest('[class*="player" i],[id*="player" i]') || video.parentElement; } catch (e) {}
      if (!wrap || wrap === document.body || wrap === document.documentElement) {
        // fallback: фиксированное позиционирование
        host.style.position = 'fixed';
        document.documentElement.appendChild(host);
      } else {
        const pos = getComputedStyle(wrap).position;
        if (pos === 'static') wrap.style.position = 'relative';
        wrap.appendChild(host);
        host.style.position = 'absolute';
      }
      if (!applySavedPos(host)) setDefaultPos(host);
    } catch (e) {
      try { document.documentElement.appendChild(host); } catch (x) {}
    }
  }

  // ---------- перетаскивание бейджа + запоминание позиции на домен
  let badgePosCache = null;
  async function getBadgePos() {
    if (badgePosCache) return badgePosCache;
    try {
      const o = await chrome.storage.local.get('badgePos');
      badgePosCache = (o && o.badgePos) || {};
    } catch (e) { badgePosCache = {}; }
    return badgePosCache;
  }
  function setDefaultPos(host) {
    host.style.left = '50%';
    host.style.top = '14px';
    host.style.transform = 'translateX(-50%)';
    host.style.right = 'auto';
  }
  function applySavedPos(host) {
    try {
      const p = badgePosCache && badgePosCache[location.host];
      if (p && typeof p.left === 'string' && typeof p.top === 'string') {
        host.style.left = p.left;
        host.style.top = p.top;
        host.style.transform = 'none';
        host.style.right = 'auto';
        return true;
      }
    } catch (e) {}
    return false;
  }
  async function saveBadgePos(host) {
    try {
      const pos = await getBadgePos();
      pos[location.host] = { left: host.style.left, top: host.style.top };
      badgePosCache = pos;
      await chrome.storage.local.set({ badgePos: pos });
    } catch (e) {}
  }
  async function resetBadgePos(host) {
    try {
      const pos = await getBadgePos();
      delete pos[location.host];
      badgePosCache = pos;
      await chrome.storage.local.set({ badgePos: pos });
    } catch (e) {}
    setDefaultPos(host);
  }

  // ---------- Инфо-панель прямо на видео (полупрозрачный фон, левый верхний угол)
  // Включается кнопкой «Инфо на видео» в мини-панели, закрывается крестиком
  // или повторным нажатием. Всё — прямыми свойствами элемента, простым языком.
  const infoOverlays = new Map(); // video -> host div (Shadow DOM)
  function fmtClock(s) {
    if (s === null || s === undefined || !isFinite(s)) return '—';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  function fmtRate(n) {
    n = Math.round(Number(n) * 100) / 100;
    if (!isFinite(n)) return '?';
    return String(n) + '×';
  }
  // R — переключатель «1.0 ↔ скорость до сброса»: первое нажатие запоминает текущую
  // и сбрасывает в 1.0, повторное — возвращает запомненную, третье — снова сброс. И так по кругу.
  function toggleResetSpeed() {
    const cur = desiredSpeed();
    if (Math.abs(cur - 1) < 1e-9) {
      const last = Number(S.lastSpeedBeforeReset) || 0;
      if (Math.abs(last - 1) > 1e-9) setSpeed(last);
    } else {
      S.lastSpeedBeforeReset = cur;
      try { chrome.storage.local.set({ lastSpeedBeforeReset: cur }); } catch (e) {}
      setSpeed(1);
    }
  }
  function shortSrc(s) {
    s = String(s || '');
    if (!s) return '';
    try {
      const u = new URL(s);
      if (u.protocol === 'blob:') return 'поток в памяти (blob)';
      return u.hostname + (u.pathname || '').slice(0, 30);
    } catch (e) { return s.slice(0, 60); }
  }
  // Строки простым языком: каждая мелочь — с новой строки и с большой буквы,
  // без точек-разделителей и скобок. Всё, что элемент вообще отдаёт.
  function trSum(r) {
    let n = 0, total = 0;
    try {
      if (r && r.length) {
        n = r.length;
        for (let i = 0; i < r.length; i++) { try { total += r.end(i) - r.start(i); } catch (e) {} }
      }
    } catch (e) {}
    return { n, total: Math.round(total * 10) / 10 };
  }
  function fmtBytes(n) {
    try {
      n = Number(n);
      if (!isFinite(n) || n <= 0) return '';
      if (n >= 1073741824) return (Math.round(n / 1073741824 * 10) / 10) + ' ГБ';
      if (n >= 1048576) return (Math.round(n / 1048576 * 10) / 10) + ' МБ';
      if (n >= 1024) return Math.round(n / 1024) + ' КБ';
      return Math.round(n) + ' Б';
    } catch (e) { return ''; }
  }
  // ---------- Вес потока и проверка «по факту идёт»: один лёгкий опрос на адрес.
  // Прямой файл (.mp4) — HEAD, читаем Content-Length (размер CDN отдаёт всегда).
  // HLS — качаем текстовый плейлист (килобайты), считаем куски и длительность;
  // объём подгрузки считаем по performance-ресурсам (уже скачанные .ts).
  const streamMetaCache = new Map(); // url -> {len}|{segs,dur}|null
  const videoStreamMeta = new WeakMap(); // video -> meta|null
  function streamUrlFor(video) {
    try {
      const rs = performance.getEntriesByType('resource') || [];
      for (const r of rs) {
        const n = (r && r.name) || '';
        if (!n || n.startsWith('blob:')) continue;
        if (/\.m3u8(\?|$)/i.test(n)) return n;
      }
      for (const r of rs) {
        const n = (r && r.name) || '';
        if (!n || n.startsWith('blob:')) continue;
        if (/\.ts(\?|$)/i.test(n)) return n;
      }
    } catch (e) {}
    try {
      const cs = video.currentSrc || video.src || '';
      if (cs && /^https?:/i.test(cs)) return cs;
    } catch (e) {}
    return '';
  }
  function probeStreamMeta(video) {
    try {
      if (videoStreamMeta.has(video)) return; // уже знаем (включая «пусто»)
      const u = streamUrlFor(video);
      if (!u) return;
      if (streamMetaCache.has(u)) { videoStreamMeta.set(video, streamMetaCache.get(u)); return; }
      streamMetaCache.set(u, null); // застолбили: повторных опросов не будет
      videoStreamMeta.set(video, null);
      if (/\.m3u8(\?|$)/i.test(u)) {
        fetch(u, { credentials: 'omit' }).then((r) => r.text()).then((txt) => {
          let pl = txt || '';
          try {
            const lines = pl.split('\n').map((s) => s.trim()).filter(Boolean);
            const vi = lines.findIndex((s) => s.indexOf('#EXT-X-STREAM-INF') === 0);
            if (vi >= 0) {
              const next = lines.slice(vi + 1).find((s) => s && s[0] !== '#');
              if (next) return fetch(new URL(next, u).href, { credentials: 'omit' }).then((r2) => r2.text());
            }
          } catch (e) {}
          return pl;
        }).then((pl) => {
          let n = 0, dur = 0;
          try {
            const lines = String(pl || '').split('\n');
            for (const s of lines) {
              const m = s.match(/#EXTINF:([\d.]+)/);
              if (m) { n++; dur += parseFloat(m[1]) || 0; }
            }
          } catch (e) {}
          const meta = n > 0 ? { segs: n, dur: Math.round(dur) } : null;
          streamMetaCache.set(u, meta);
          try { videoStreamMeta.delete(video); } catch (e) {}
          try { refreshVideoInfos(); } catch (e) {}
        }).catch(() => {});
      } else {
        fetch(u, { method: 'HEAD', credentials: 'omit' }).then((r) => {
          let len = 0;
          try { len = parseInt(r.headers.get('content-length') || '0', 10) || 0; } catch (e) {}
          const meta = len > 0 ? { len } : null;
          streamMetaCache.set(u, meta);
          try { videoStreamMeta.delete(video); } catch (e) {}
          try { refreshVideoInfos(); } catch (e) {}
        }).catch(() => {});
      }
    } catch (e) {}
  }
  function loadedTsBytes() {
    let n = 0, total = 0;
    try {
      const rs = performance.getEntriesByType('resource') || [];
      for (const r of rs) {
        const nm = (r && r.name) || '';
        if (!nm || nm.startsWith('blob:') || !/\.ts(\?|$)/i.test(nm)) continue;
        n++;
        try { total += r.encodedBodySize || 0; } catch (e) {}
      }
    } catch (e) {}
    return { n, total };
  }
  // ---------- Вес по качествам: повторяем запрос плеера за потоком (только rezka-подобные
  // страницы с get_cdn_series), расшифровываем ссылки (clearTrash) и опрашиваем размер
  // каждого .mp4. Один набор опросов на серию+озвучку за сессию.
  // Как у HDrezka-Helper (src/background.js, clearTrash): мусор — все комбинации
  // '@ # ! ^ $' длиной 2 и 3, их base64 вычищается из строки без '//_//'.
  function clearTrash(data) {
    try {
      const trashList = ['@', '#', '!', '^', '$'];
      const codes = [];
      const gen = (prefix, len) => {
        if (len === 0) { try { codes.push(btoa(prefix)); } catch (e) {} return; }
        for (const c of trashList) gen(prefix + c, len - 1);
      };
      gen('', 2); gen('', 3);
      let s = String(data || '').split('//_//').join('');
      // Helper убирает только первое '#h'; убираем все — '#' не входит
      // в base64-алфавит, живых данных там быть не может.
      s = s.split('#h').join('');
      for (const c of codes) { if (c) s = s.split(c).join(''); }
      s = s.replace(/\s+/g, '');
      // Чистый base64 кратен 4 — допаддим (Helper этого не делает и падает).
      const pad = s.length % 4;
      if (pad) s += '===='.slice(pad);
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) { return ''; }
  }
  function parseQStreams(decoded) {
    // Как у Helper'а: кусок '...[720p]ссылка1 or ссылка2,...', дедуп ссылок.
    // Отличие: принимаем .mp4 с query-хвостом (?md5=...) и .m3u8 (поле kind) —
    // голый endsWith('.mp4') такие ссылки роняет.
    const out = [];
    const seen = new Set();
    try {
      for (const part of String(decoded || '').split(',')) {
        const a = part.indexOf('['), b = part.indexOf(']');
        if (a < 0 || b < 0 || b <= a) continue;
        const label = part.slice(a + 1, b).replace(/<[^>]*>/g, '').trim();
        if (!label) continue;
        const rest = part.slice(b + 1);
        for (const cand of rest.split(' or ')) {
          const chunk = (cand || '').trim();
          if (!chunk || seen.has(chunk)) continue;
          let url = chunk;
          try {
            const m = chunk.match(/https?:\/\/[^\s"'<>]+/);
            if (m && m[0]) url = m[0];
          } catch (e) {}
          if (!/^https?:\/\//i.test(url)) continue;
          let kind = '';
          if (/\.mp4(\?|#|$)/i.test(url)) kind = 'mp4';
          else if (/\.m3u8(\?|#|$)/i.test(url)) kind = 'm3u8';
          else continue;
          seen.add(chunk);
          out.push({ label, url, kind });
        }
      }
    } catch (e) {}
    return out;
  }
  // Вес HLS-вариантов: мастер-плейлист -> BANDWIDTH × длительность.
  // Ответ сервера всё чаще — m3u8-ссылки, а не mp4; парсер выше их уже
  // отличает (kind), здесь считаем вес каждого качества без скачивания видео.
  function hlsDurAndSegs(txt) {
    let dur = 0, n = 0;
    const segs = [];
    try {
      for (const ln of String(txt || '').split('\n')) {
        const s = (ln || '').trim();
        const m = s.match(/#EXTINF:([\d.]+)/);
        if (m) { n++; dur += parseFloat(m[1]) || 0; continue; }
        if (s && s[0] !== '#' && /\.(ts|m4s|mp4)(\?|#|$)/i.test(s)) segs.push(s);
      }
    } catch (e) {}
    return { dur, n, segs };
  }
  function probeHlsSizes(entries) {
    const fetchTxt = (u) => fetch(u, { credentials: 'omit' }).then((r) => {
      if (!r.ok) throw 0;
      return r.text();
    });
    const headLen = (u) => fetch(u, { method: 'HEAD', credentials: 'omit' }).then((r) => {
      try { return parseInt(r.headers.get('content-length') || '0', 10) || 0; } catch (e) { return 0; }
    }).catch(() => 0);
    return Promise.all((entries || []).map((en) => fetchTxt(en.url).then((txt) => {
      const lines = String(txt || '').split('\n').map((s) => (s || '').trim());
      const hasMaster = lines.some((s) => s.indexOf('#EXT-X-STREAM-INF') === 0);
      if (!hasMaster) return [{ uri: en.url, bw: 0, res: '', baseLabel: en.label, masterUrl: en.url }];
      const vars = [];
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i];
        if (s.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
        let bw = 0, res = '';
        try {
          const mb = s.match(/BANDWIDTH=(\d+)/);
          if (mb) bw = parseInt(mb[1], 10) || 0;
          const mr = s.match(/RESOLUTION=(\d+x\d+)/i);
          if (mr) res = mr[1];
        } catch (e) {}
        let uri = '';
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j];
          if (!t) continue;
          if (t[0] === '#') continue;
          uri = t; break;
        }
        if (!uri) continue;
        try { uri = new URL(uri, en.url).href; } catch (e) {}
        vars.push({ uri, bw, res, baseLabel: en.label, masterUrl: en.url });
      }
      return vars.length ? vars : [{ uri: en.url, bw: 0, res: '', baseLabel: en.label, masterUrl: en.url }];
    }).catch(() => []))).then((groups) => {
      const flat = [];
      for (const g of groups || []) for (const v of g || []) flat.push(v);
      return Promise.all(flat.map((v) => fetchTxt(v.uri).then((txt) => {
        const { dur, n, segs } = hlsDurAndSegs(txt);
        let label = v.baseLabel;
        try {
          const m = String(v.res || '').match(/(\d+)\s*x\s*(\d+)/);
          if (m) label = m[2] + 'p';
        } catch (e) {}
        if (v.bw > 0 && dur > 0) {
          return { label, bytes: Math.round((v.bw / 8) * dur) };
        }
        if (n > 0 && segs.length) {
          // Нет BANDWIDTH — меряем первые 3 сегмента, средний × число кусков.
          const sample = segs.slice(0, 3).map((s) => {
            try { return new URL(s, v.uri).href; } catch (e) { return s; }
          });
          return Promise.all(sample.map(headLen)).then((lens) => {
            const good = (lens || []).filter((x) => x > 0);
            if (!good.length) return null;
            const avg = good.reduce((a, b) => a + b, 0) / good.length;
            return { label, bytes: Math.round(avg * n) };
          });
        }
        return null;
      }).catch(() => null)));
    }).then((arr) => {
      const map = {};
      for (const a of arr || []) {
        if (!a || !a.label || !(a.bytes > 0)) continue;
        if (!map[a.label] || a.bytes > map[a.label]) map[a.label] = a.bytes;
      }
      return map;
    });
  }
  const qsLogged = new Set(); // ключ -> уже писали в события (чтобы не спамить)
  function qsLog(key, msg) {
    try {
      if (qsLogged.has(key)) return;
      qsLogged.add(key);
      logDom(msg);
    } catch (e) {}
  }
  function rezkaStreamParams() {
    try {
      // Видео обычно в iframe плеера, а post_id и список озвучек — в топ-документе.
      // Смотрим оба (топ — только если тот же origin, иначе молча пропускаем).
      // Селекторы и тип — как у HDrezka-Helper (MAIN-мир): #simple-seasons-tabs,
      // #simple-episodes-tabs, #translators-list .active, meta og:type.
      const docs = [];
      try { docs.push({ d: document, href: location.href, base: location.origin, tag: 'кадр' }); } catch (e) {}
      try {
        if (window.top && window.top !== window && window.top.document) {
          docs.push({ d: window.top.document, href: window.top.location.href, base: window.top.location.origin, tag: 'топ' });
        }
      } catch (e) {}
      lastQsMarker = false;
      for (const { d, href, base, tag } of docs) {
        let id = 0;
        try {
          const pid = d.getElementById('post_id');
          if (pid && pid.value) id = parseInt(pid.value, 10) || 0;
          if (!id) {
            try {
              const uf = d.getElementById('user-favorites-holder');
              if (uf && uf.getAttribute('data-post_id')) id = parseInt(uf.getAttribute('data-post_id'), 10) || 0;
            } catch (e) {}
          }
          if (!id) {
            const sid = d.getElementById('send-video-issue');
            if (sid && sid.getAttribute('data-id')) id = parseInt(sid.getAttribute('data-id'), 10) || 0;
          }
        } catch (e) {}
        if (!id) {
          try {
            const m = href.match(/\/(\d+)-[^/]*\.html/);
            if (m) id = parseInt(m[1], 10) || 0;
          } catch (e) {}
        }
        try {
          if (d.querySelector('#translators-list [data-translator_id]')) lastQsMarker = true;
        } catch (e) {}
        if (!id) continue;
        let ftype = '';
        try {
          const mt = d.querySelector('meta[property="og:type"]');
          if (mt) ftype = mt.getAttribute('content') || '';
        } catch (e) {}
        const isSeries = ftype !== 'video.movie';
        let tr = 0;
        try {
          const active = d.querySelector('#translators-list .active');
          if (active && active.getAttribute('data-translator_id')) {
            tr = parseInt(active.getAttribute('data-translator_id'), 10) || 0;
          }
        } catch (e) {}
        if (!tr) {
          try {
            // Запасной путь Helper'а: id из initCDNEvents в коде страницы.
            const initEv = isSeries ? 'initCDNSeriesEvents' : 'initCDNMoviesEvents';
            const parts = d.documentElement.textContent.split('sof.tv.' + initEv);
            if (parts.length > 1) tr = parseInt(parts.pop().split('{')[0].split(',')[1], 10) || 0;
          } catch (e) {}
        }
        if (!tr) { qsLog(id + '/notr', 'QS: есть post_id (' + tag + '), но нет активной озвучки'); continue; }
        let season = 0, episode = 0;
        try {
          const se = d.querySelector('#simple-seasons-tabs .active');
          const ep = d.querySelector('#simple-episodes-tabs .active');
          if (se) season = parseInt(se.getAttribute('data-tab_id'), 10) || 0;
          if (ep) episode = parseInt(ep.getAttribute('data-episode_id'), 10) || 0;
        } catch (e) {}
        if (!season || !episode) {
          try {
            const sm = href.match(/\/(\d+)-season\/(\d+)-episode/);
            if (sm) { season = parseInt(sm[1], 10) || 0; episode = parseInt(sm[2], 10) || 0; }
          } catch (e) {}
        }
        qsLog(id + '/' + tr, 'QS: параметры найдены (' + tag + ', ' + (isSeries ? 'сериал' : 'фильм') + ', сезон ' + (season || '?') + ', серия ' + (episode || '?') + ')');
        return { base, id, tr, season, episode, isSeries };
      }
      // Не rezka-страница — молчим, чтобы не спамить события на YouTube и прочих.
      if (lastQsMarker) qsLog('notrans', 'QS: есть список озвучек, но нет post_id');
      return null;
    } catch (e) { return null; }
  }
  const qsizeCache = new Map(); // "id/tr/s/e" -> {label:bytes}|null
  const videoQSize = new WeakMap(); // video -> {label:bytes}|null
  const qsNote = new Map(); // key -> текст причины обрыва (для строки «Вес»)
  const videoQErr = new WeakMap(); // video -> текст причины обрыва
  let lastQsMarker = false; // в этом кадре есть признаки rezka (список озвучек)
  function setQErr(video, text) {
    try { videoQErr.set(video, text); } catch (e) {}
  }
  function readTopQsizes(cb) {
    // То, что насобирал топ-кадр (у него есть post_id и та же origin, что у AJAX).
    try {
      chrome.storage.local.get(['vmQsizes'], (o) => {
        try { cb(o && o.vmQsizes); } catch (e) { cb(null); }
      });
    } catch (e) { cb(null); }
  }
  function fetchQSizes(p, key, cb) {
    // p: {base,id,tr,season,episode,isSeries}; cb(map|null). Итог и причину пишет в кэши.
    // Размер — как у Helper'а: сначала HEAD, если пусто — GET (CDN бывает молчит на HEAD).
    try {
      const isSeries = !!p.isSeries;
      const body = isSeries
        ? { id: p.id, translator_id: p.tr, season: p.season, episode: p.episode, action: 'get_stream' }
        : { id: p.id, translator_id: p.tr, action: 'get_movie' };
      // Как у Helper'а (makeRequest): пустые поля не шлём — season=0/episode=0
      // сервер понимает как ошибку, а не как «первую серию».
      try {
        for (const k of Object.keys(body)) { if (!body[k]) delete body[k]; }
      } catch (e) {}
      const sizeOf = (url) => {
        const readLen = (rh) => {
          try { return parseInt(rh.headers.get('content-length') || '0', 10) || 0; } catch (e) { return 0; }
        };
        return fetch(url, { method: 'HEAD', credentials: 'omit' }).then((rh) => {
          const n = readLen(rh);
          if (n > 0) return n;
          return fetch(url, { credentials: 'omit' }).then((rg) => {
            try { rg.body.cancel(); } catch (e) {}
            return readLen(rg);
          }).catch(() => 0);
        }).catch(() => 0);
      };
      fetch(p.base + '/ajax/get_cdn_series/', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams(body).toString(),
      }).then((r) => {
        qsLog(key + '/post', 'QS: POST ответил ' + r.status);
        if (!r.ok) { qsNote.set(key, 'сервер ответил ' + r.status); throw 0; }
        return r.json();
      }).then((j) => {
        if (!j || !j.success || !j.url) { qsNote.set(key, 'в ответе нет ссылки на поток'); qsLog(key + '/empty', 'QS: ответ без ссылки на поток'); throw 0; }
        let decoded = clearTrash(j.url);
        if (!decoded) decoded = String(j.url || ''); // мягкий фолбэк как у Helper'а
        const qs = parseQStreams(decoded);
        qsLog(key + '/dec', 'QS: расшифровано ссылок: ' + qs.length + ' (mp4: ' + qs.filter((q) => q.kind === 'mp4').length + ', m3u8: ' + qs.filter((q) => q.kind === 'm3u8').length + ')');
        if (!qs.length) {
          qsNote.set(key, 'ссылки не расшифровались');
          try {
            qsLog(key + '/raw', 'QS: превью ответа: ' + String(decoded || '').slice(0, 80));
          } catch (e) {}
          throw 0;
        }
        const mp4s = qs.filter((q) => q.kind === 'mp4');
        if (!mp4s.length) {
          // Сервер отдал только HLS-варианты — вес считаем по плейлистам.
          qsLog(key + '/hls', 'QS: mp4 нет, считаю вес по HLS-плейлистам (' + qs.length + ')');
          return probeHlsSizes(qs).then((map) => ({ hlsMap: map, qs }));
        }
        return Promise.all(mp4s.map((q) =>
          sizeOf(q.url).then((bytes) => ({ label: q.label, bytes }))
        )).then((arr) => ({ mp4arr: arr }));
      }).then((res) => {
        let map = {};
        if (res && res.hlsMap) {
          map = res.hlsMap;
        } else {
          const arr = (res && res.mp4arr) || [];
          // Как у Helper'а: первое удачное значение на качество.
          for (const a of arr || []) {
            if (a && a.label && a.bytes > 0 && !map[a.label]) map[a.label] = a.bytes;
          }
        }
        const total = (res && res.hlsMap) ? (res.qs || []).length : ((res && res.mp4arr) || []).length;
        qsLog(key + '/head', 'QS: размеров получено: ' + Object.keys(map).length + '/' + total);
        const fin = Object.keys(map).length ? map : null;
        if (!fin) qsNote.set(key, 'CDN не отдал размеры');
        qsizeCache.set(key, fin);
        try { cb(fin); } catch (e) {}
      }).catch(() => {
        if (!qsNote.has(key)) qsNote.set(key, 'ошибка запроса');
        qsizeCache.set(key, null);
        try { cb(null); } catch (e) {}
      });
    } catch (e) { try { cb(null); } catch (e2) {} }
  }
  function topQsTick() {
    // Топ-кадр: свои параметры + свой origin — качаем и кладём в общее хранилище,
    // кадры с видео (даже чужие iframe) заберут оттуда.
    try {
      if (window.top !== window) return;
      const p = rezkaStreamParams();
      if (!p) return;
      const key = p.id + '/' + p.tr + '/' + (p.season > 0 && p.episode > 0 ? p.season + '/' + p.episode : 'm');
      if (qsizeCache.has(key)) return;
      qsizeCache.set(key, null); // застолбили на время запроса
      fetchQSizes(p, key, (map) => {
        try {
          chrome.storage.local.set({ vmQsizes: { tab: (myTabId !== null && myTabId !== undefined) ? myTabId : 0, key, map, at: Date.now() } });
        } catch (e) {}
        try { refreshVideoInfos(); } catch (e) {}
      });
    } catch (e) {}
  }
  function probeStreamSizes(video) {
    try {
      if (videoQSize.has(video)) return; // уже знаем (включая «пусто»)
      const p = rezkaStreamParams();
      if (p) {
        const key = p.id + '/' + p.tr + '/' + (p.season > 0 && p.episode > 0 ? p.season + '/' + p.episode : 'm');
        if (qsizeCache.has(key)) {
          videoQSize.set(video, qsizeCache.get(key));
          const nt0 = qsNote.get(key);
          if (!qsizeCache.get(key) && nt0) setQErr(video, nt0);
          return;
        }
        qsizeCache.set(key, null); // застолбили: повторных цепочек не будет
        videoQSize.set(video, null);
        fetchQSizes(p, key, (map) => {
          try { videoQSize.delete(video); } catch (e) {} // следующий тик заберёт итог
          const nt = qsNote.get(key);
          if (!map && nt) setQErr(video, nt);
          try { refreshVideoInfos(); } catch (e) {}
        });
        return;
      }
      // Параметров нет в этом кадре (видео в чужом iframe) — ждём топ-кадр.
      if (!lastQsMarker) return; // не rezka — молча, без мусора в «Вес»
      readTopQsizes((en) => {
        try {
          if (videoQSize.has(video)) return;
          if (en && en.map && Object.keys(en.map).length && (!en.tab || en.tab === myTabId)) {
            videoQSize.set(video, en.map);
            try { refreshVideoInfos(); } catch (e) {}
          } else {
            setQErr(video, 'топ-кадр пока не отдал размеры');
          }
        } catch (e) {}
      });
    } catch (e) {}
  }
  function mediaRowsPlain(v) {
    const rows = [];
    const L = (label, lines) => {
      const clean = (lines || []).map((s) => String(s === undefined || s === null ? '' : s).trim()).filter(Boolean);
      if (clean.length) rows.push([label, clean.join('\n')]);
    };
    try {
      const st = [];
      try {
        if (v.ended) st.push('Видео закончилось');
        else if (v.paused) st.push('Стоит на паузе');
        else if (v.readyState < 3) st.push('Ждёт данные — крутится загрузка');
        else st.push('Играет');
      } catch (e) {}
      try { st.push(trSum(v.seekable).n > 0 ? 'Перемотка работает' : 'Перемотку сайт не разрешает'); } catch (e) {}
      try { if (v.seeking) st.push('Прямо сейчас перематывает'); } catch (e) {}
      L('Состояние', st);
      const tm = ['Сейчас идёт ' + fmtClock(v.currentTime)];
      try {
        if (isFinite(v.duration) && v.duration > 0) {
          tm.push('Всего длится ' + fmtClock(v.duration));
          tm.push('Просмотрено ' + Math.round((v.currentTime / v.duration) * 100) + '%');
        } else {
          tm.push('Это прямой эфир');
          tm.push('Конца нет — идёт в реальном времени');
        }
      } catch (e) {}
      try {
        const pl = trSum(v.played);
        if (pl.n > 0) {
          tm.push('Смотреных кусков: ' + pl.n);
          tm.push('Суммарно смотрено ' + fmtClock(pl.total));
        }
      } catch (e) {}
      L('Время', tm);
      const ql = [];
      try {
        const info = currentLabel(v);
        ql.push('Сейчас ' + info.text);
        if (info.player && info.player.levels) ql.push('Всего уровней: ' + info.player.levels.length);
        ql.push(info.state === 'smart' ? 'Режим: умный' : info.state === 'max' ? 'Режим: максимум' : info.state === 'manual' ? 'Режим: ручной' : 'Режим: определяется');
      } catch (e) {}
      L('Качество', ql);
      const sp = ['Сейчас ' + fmtRate(v.playbackRate)];
      try {
        const want = desiredSpeed();
        sp.push(Math.abs(want - 1) > 1e-9 ? 'Выбрано ' + fmtRate(want) : 'Обычная скорость без ускорения');
      } catch (e) {}
      try {
        const pp = v.preservesPitch !== undefined ? v.preservesPitch : v.webkitPreservesPitch !== undefined ? v.webkitPreservesPitch : v.mozPreservesPitch;
        if (pp !== undefined) sp.push(pp ? 'Голос не меняется' : 'Голос становится выше и быстрее');
      } catch (e) {}
      L('Скорость', sp);
      const au = [];
      try { au.push(v.muted ? 'Звук выключен' : 'Звук включён'); } catch (e) {}
      try { au.push('Громкость ' + Math.round(v.volume * 100) + '%'); } catch (e) {}
      try { if (v.defaultMuted) au.push('Сайт запускает видео без звука'); } catch (e) {}
      try {
        const at = v.audioTracks;
        if (at && at.length) {
          au.push('Звуковых дорожек: ' + at.length);
          for (let i = 0; i < at.length; i++) {
            const t = at[i];
            au.push('Дорожка ' + (i + 1) + ': ' + (t.label || 'без названия'));
            if (t.language) au.push('Язык: ' + t.language);
            au.push(t.enabled ? 'Статус: играет сейчас' : 'Статус: запасная');
          }
        } else {
          au.push('Дорожка одна — та, что зашита в видео');
        }
      } catch (e) {}
      try {
        if (typeof v.sinkId === 'string' && v.sinkId) au.push('Куда играет: ' + v.sinkId);
      } catch (e) {}
      L('Звук', au);
      const sub = [];
      try {
        const tt = v.textTracks;
        if (tt && tt.length) {
          sub.push('Дорожек субтитров: ' + tt.length);
          for (let i = 0; i < tt.length; i++) {
            const t = tt[i];
            sub.push('Субтитры ' + (i + 1) + ': ' + (t.label || t.language || 'без названия'));
            if (t.language && t.label) sub.push('Язык: ' + t.language);
            let modeStr = t.mode;
            try { modeStr = t.mode === 'showing' ? 'Показаны на экране' : t.mode === 'hidden' ? 'Скрыты' : 'Выключены'; } catch (e) {}
            sub.push('Статус: ' + modeStr);
            try { if (t.cues) sub.push('Фраз всего: ' + t.cues.length); } catch (e) {}
            try { if (t.activeCues && t.activeCues.length) sub.push('Сейчас видно фраз: ' + t.activeCues.length); } catch (e) {}
          }
        } else {
          sub.push('Субтитров нет');
        }
      } catch (e) {}
      L('Субтитры', sub);
      const vd = [];
      try {
        const vt = v.videoTracks;
        if (vt && vt.length) {
          vd.push('Видеодорожек: ' + vt.length);
          for (let i = 0; i < vt.length; i++) {
            const t = vt[i];
            vd.push('Видео ' + (i + 1) + ': ' + (t.label || 'без названия'));
            vd.push(t.selected ? 'Статус: выбрана' : 'Статус: запасная');
          }
        } else {
          vd.push('Дорожка одна — та, что в видео');
        }
      } catch (e) {}
      L('Видеодорожки', vd);
      L('Картинка', [
        'Кадр ' + (v.videoWidth || 0) + ' на ' + (v.videoHeight || 0) + ' точек',
        'Окно плеера ' + (v.clientWidth || 0) + ' на ' + (v.clientHeight || 0),
      ]);
      try {
        const qq = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
        if (qq) {
          L('Кадры', [
            'Показано ' + qq.totalVideoFrames,
            'Пропущено ' + qq.droppedVideoFrames,
            'Битых ' + (qq.corruptedVideoFrames || 0),
            qq.droppedVideoFrames > 0 ? 'Есть пропуски — слабый декодер или сеть' : 'Всё гладко, без пропусков',
          ]);
        }
      } catch (e) {}
      let bufAhead = 0;
      try {
        const b = v.buffered, t = v.currentTime || 0;
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= t && t <= b.end(i)) { bufAhead = Math.round((b.end(i) - t) * 10) / 10; break; }
        }
      } catch (e) {}
      const NS = ['пусто', 'простой', 'грузит', 'нет источника'];
      const RS = ['нет данных', 'метаданные получены', 'текущий кадр есть', 'можно играть', 'запас большой'];
      L('Буфер и сеть', [
        'Впереди подгружено ' + bufAhead + ' с',
        'Всего в кэше ' + trSum(v.buffered).total + ' с',
        'Кусков в кэше: ' + trSum(v.buffered).n,
        'Сеть сейчас: ' + (NS[v.networkState] || v.networkState),
        'Готовность: ' + (RS[v.readyState] || v.readyState),
      ]);
      const so = [];
      try {
        const raw = v.currentSrc || v.src || '';
        if (raw) {
          so.push('Адрес: ' + shortSrc(raw));
          if (raw.startsWith('blob:')) so.push('Тип: поток, который собрал плеер сайта');
          else if (!isFinite(v.duration)) so.push('Тип: прямой эфир');
          else so.push('Тип: обычный видеофайл');
        } else {
          so.push('Адрес пока пуст — поток не подключён');
        }
      } catch (e) {}
      try {
        const co = v.getAttribute ? v.getAttribute('crossorigin') : null;
        so.push(co === null ? 'Чужому сайту не отдаётся' : 'Доступ чужому сайту: ' + (co || 'разрешён'));
      } catch (e) {}
      L('Источник', so);
      // Вес: сначала точная разбивка по качествам (повтор запроса плеера),
      // иначе — прямой файл целиком или куски HLS + что уже подгружено.
      const qs = videoQSize.get(v) || null;
      const qsw = qs ? Object.keys(qs).map((k) => k + ' — ' + fmtBytes(qs[k])).filter(Boolean) : [];
      if (qsw.length) {
        L('Вес', qsw);
      } else {
        const sm = videoStreamMeta.get(v) || null;
        let wShown = false;
        if (sm && sm.len) {
          L('Вес', ['Весит ' + fmtBytes(sm.len)]); wShown = true;
        } else if (sm && sm.segs) {
          const lb = loadedTsBytes();
          const wl = ['Поток идёт кусками (HLS)', 'Кусков в списке: ' + sm.segs];
          if (lb.n > 0) wl.push('Подгружено кусков: ' + lb.n);
          if (lb.total > 0) wl.push('Подгружено объёмом ' + fmtBytes(lb.total));
          try {
            const qe0 = videoQErr.get(v) || '';
            if (qe0) wl.push('Разбивки нет: ' + qe0);
          } catch (e) {}
          L('Вес', wl); wShown = true;
        }
        if (!wShown) {
          const qe = videoQErr.get(v) || '';
          if (qe) L('Вес', ['Не получилось: ' + qe]);
        }
      }
      // По факту — всегда: реальный кадр + сходимость с выбранным качеством.
      const pf = [];
      try {
        const w = v.videoWidth || 0, h = v.videoHeight || 0;
        pf.push(w > 0 && h > 0 ? 'Идёт ' + w + ' на ' + h + ' точек' : 'Кадр пока неизвестен — поток не начался');
      } catch (e) {}
      try {
        const info = currentLabel(v);
        const txt = info.text || '';
        let exp = 0;
        try {
          const m = String(txt).match(/(\d{3,4})/);
          if (m) exp = parseInt(m[1], 10);
        } catch (e) {}
        const vh = v.videoHeight || 0;
        const dur = v.duration || 0;
        if (/ultra/i.test(txt) && dur > 0 && dur < 600) {
          pf.push('Похоже на тизер — вместо фильма заглушка, для Ultra нужен премиум');
        } else if (exp > 0 && vh > 0 && vh < exp * 0.9) {
          pf.push('Ниже выбранного: выбрано ' + txt);
        } else if (exp > 0 && txt) {
          pf.push('Сходится с выбранным (' + txt + ')');
        }
      } catch (e) {}
      L('По факту', pf);
      // Дата заливки: точное совпадение (id+сезон+серия+озвучка), иначе
      // «залито целиком», иначе «неизвестно». Перезаливы — отдельными строками.
      try {
        const al = updatesLinesSync();
        if (al && al.length) L('Добавлено', al);
      } catch (e) {}
      const misc = [];
      try { misc.push(v.autoplay ? 'Автозапуск включён' : 'Само не запускается'); } catch (e) {}
      try { misc.push(v.loop ? 'Повтор по кругу включён' : 'Повтор выключен'); } catch (e) {}
      try { misc.push(v.controls ? 'Кнопки браузера показаны' : 'Кнопок браузера нет'); } catch (e) {}
      try { misc.push(v.disableRemotePlayback ? 'Трансляция на телевизор запрещена' : 'Можно отправить на телевизор'); } catch (e) {}
      try {
        if (v.mediaKeys) misc.push('Стоит защита от копирования');
        else misc.push('Защиты от копирования нет');
      } catch (e) {}
      try {
        if (v.error && v.error.code) misc.push('Ошибка видео! Код ' + v.error.code);
      } catch (e) {}
      L('Прочее', misc);
    } catch (e) {}
    return rows;
  }
  function toggleVideoInfo(video) {
    const old = infoOverlays.get(video);
    if (old) { try { old.remove(); } catch (e) {} infoOverlays.delete(video); return; }
    const host = document.createElement('div');
    host.setAttribute('data-vm-info', '1');
    const sh = host.attachShadow({ mode: 'open' });
    const css = document.createElement('style');
    css.textContent = `
      .box{position:relative;min-width:220px;max-width:280px;padding:10px 12px;border-radius:14px;
        font-family:Inter,-apple-system,'SF Pro Text','Segoe UI',Roboto,sans-serif;font-size:11.5px;line-height:1.5;color:#fff;
        background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.16);
        -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 8px 28px rgba(0,0,0,.45)}
      .box h5{margin:0 24px 6px 0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.7}
      .x{position:absolute;top:4px;right:6px;width:22px;height:22px;border:none;background:none;color:#fff;opacity:.7;font-size:14px;cursor:pointer}
      .x:hover{opacity:1}
      .box table{width:100%;border-collapse:collapse}
      .box td{padding:2px 0;vertical-align:top}
      .box td.k{opacity:.6;width:38%;padding-right:8px}
      .box td.v{word-break:break-word;white-space:pre-line}
      .box::-webkit-scrollbar{width:6px}
      .box::-webkit-scrollbar-thumb{background:rgba(255,255,255,.25);border-radius:3px}`;
    sh.appendChild(css);
    const box = document.createElement('div');
    box.className = 'box';
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.title = 'Закрыть';
    x.addEventListener('click', (ev) => { ev.stopPropagation(); toggleVideoInfo(video); });
    box.appendChild(x);
    const h = document.createElement('h5');
    h.textContent = 'Инфо';
    box.appendChild(h);
    const t = document.createElement('table');
    box.appendChild(t);
    sh.appendChild(box);
    try {
      const rec = badges.get(video);
      const parent = (rec && rec.host && rec.host.parentElement) || video.parentElement || document.documentElement;
      if (parent !== document.documentElement) {
        try { if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'; } catch (e) {}
        host.style.cssText = 'position:absolute;left:10px;top:10px;z-index:2147483647;';
      } else {
        host.style.cssText = 'position:fixed;left:10px;top:10px;z-index:2147483647;';
      }
      parent.appendChild(host);
    } catch (e) {
      try { document.documentElement.appendChild(host); } catch (x2) {}
    }
    infoOverlays.set(video, host);
    renderVideoInfo(video);
  }
  function renderVideoInfo(video) {
    const host = infoOverlays.get(video);
    if (!host || !host.isConnected) return;
    try {
      const t = host.shadowRoot && host.shadowRoot.querySelector('table');
      if (!t) return;
      t.innerHTML = '';
      for (const [k, val] of mediaRowsPlain(video)) {
        const tr = document.createElement('tr');
        const a = document.createElement('td'); a.className = 'k'; a.textContent = k;
        const b = document.createElement('td'); b.className = 'v'; b.textContent = String(val);
        tr.appendChild(a); tr.appendChild(b); t.appendChild(tr);
      }
      // Скролл плашки — только когда видео НЕ во весь экран (в фуллскрине места хватает).
      // Лимит — по высоте родительского блока плеера, а не вьюпорта: иначе в маленьком
      // плеере плашка вылезает за его края и режется (у родителя overflow:hidden).
      try {
        const box = host.shadowRoot && host.shadowRoot.querySelector('.box');
        if (box) {
          if (document.fullscreenElement) { box.style.maxHeight = ''; box.style.overflowY = ''; }
          else {
            let cap = '';
            try {
              const pe = host.parentElement;
              if (pe && pe.clientHeight > 140) cap = Math.max(120, pe.clientHeight - 20) + 'px';
            } catch (e) {}
            if (!cap) cap = '70vh';
            box.style.maxHeight = cap; box.style.overflowY = 'auto';
          }
        }
      } catch (e) {}
    } catch (e) {}
  }
  function refreshVideoInfos() {
    try {
      for (const [v] of infoOverlays) {
        if (!v.isConnected) {
          try { const h = infoOverlays.get(v); if (h) h.remove(); } catch (e) {}
          infoOverlays.delete(v);
          continue;
        }
        renderVideoInfo(v);
      }
    } catch (e) {}
  }

  const MODE_NAMES = { smart: 'Умный режим', max: 'Максимум', manual: 'Ручной потолок', unknown: 'Определение…' };
  function updateBadge(rec) {
    try {
      const info = currentLabel(rec.video);
      const t = rec.sh.querySelector('.t');
      const dot = rec.sh.querySelector('.dot');
      // Скорость и качество — всегда: текущая (живая) скорость видео + уровень.
      let live = 1;
      try { live = rec.video.playbackRate || 1; } catch (e) {}
      const txt = info.text;
      const rate = fmtRate(live);
      const it = (live - 1 > 1e-9) ? ' style="font-style:italic"' : '';
      if (t) t.innerHTML = escapeHtml(txt) + ' · <span' + it + '>' + escapeHtml(rate) + '</span>';
      if (dot) {
        const c = DOT[info.state] || DOT.unknown;
        dot.style.background = c; dot.style.color = c;
      }
      const b = rec.sh.querySelector('.b');
      if (b) b.title = 'Video Manager · ' + (MODE_NAMES[info.state] || info.state) + ' · ' + info.text;
      const show = badgeAllowed() && isActive();
      rec.host.style.display = show ? '' : 'none';
    } catch (e) {}
  }
  function refreshAllBadges() {
    for (const rec of badges.values()) {
      updateBadge(rec);
      if (rec.open) renderPanel(rec);
    }
    refreshVideoInfos();
  }

  function renderPanel(rec) {
    const p = rec.panel;
    const info = currentLabel(rec.video);
    const spd = desiredSpeed();
    const step = speedStep();
    const spdTxt = (Math.round(spd * 100) / 100) + '×';
    const caps = [[360, '360p'], [480, '480p'], [720, '720p'], [1080, '1080p'], [1081, '1080U'], [1440, '2K'], [2160, '4K']];
    const SPD_PRESETS = [0.5, 1, 1.5, 2, 3];
    let lvls = '';
    if (info.player && info.player.levels) {
      lvls = info.player.levels.map((l, i) =>
        `<button class="c${i === info.player.current ? ' on' : ''}" data-lvl="${i}">${escapeHtml(l.label)}</button>`).join('');
    } else {
      const ctl = domCtl.get(rec.video);
      if (ctl && ctl.items) {
        lvls = ctl.items.map((x) =>
          `<button class="c${Math.abs(x.rank - ctl.curRank) < 1e-9 ? ' on' : ''}" data-rank="${x.rank}">${escapeHtml(x.label)}</button>`).join('');
      }
    }
    p.innerHTML = `
      <div class="pt">Video Manager · ${escapeHtml(info.text)}</div>
      <div class="row">
        <button class="mbtn${S.mode === 'smart' ? ' on' : ''}" data-mode="smart">Умный</button>
        <button class="mbtn${S.mode === 'max' ? ' on' : ''}" data-mode="max">Макс</button>
        <button class="mbtn${S.mode === 'manual' ? ' on' : ''}" data-mode="manual">Ручной</button>
      </div>
      <div class="pt">Потолок</div>
      <div class="caps">${caps.map(([v, l]) => `<button class="c${S.cap === v ? ' on' : ''}" data-cap="${v}">${l}</button>`).join('')}</div>
      <div class="pt">Уровни на сайте</div>
      <div class="lvls">${lvls || '<span style="opacity:.6;font-size:11px">пока не найдены</span>'}</div>
      <div class="pt">Скорость · ${escapeHtml(spdTxt)}</div>
      <div class="srow">
        <button class="sbtn" data-spd="down" title="Медленнее (S)">−${step}</button>
        <button class="sval" data-spd="reset" title="Сброс 1.0 / возврат (R)">${escapeHtml(spdTxt)}</button>
        <button class="sbtn" data-spd="up" title="Быстрее (D)">+${step}</button>
      </div>
      <div class="caps">${SPD_PRESETS.map((v) => `<button class="c${Math.abs(spd - v) < 1e-9 ? ' on' : ''}" data-spd="preset:${v}">${v}×</button>`).join('')}</div>
      <div class="frow">
        <button class="fbtn" data-act="info">Инфо на видео</button>
      </div>
      <div class="frow">
        <button class="fbtn" data-act="settings">Настройки</button>
      </div>
      <div class="frow">
        <button class="fbtn" data-act="pos">Сбросить позицию</button>
      </div>`;
    p.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.storage.local.set({ mode: btn.dataset.mode });
    }));
    p.querySelectorAll('[data-cap]').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.storage.local.set({ cap: parseInt(btn.dataset.cap, 10), mode: S.mode === 'max' ? 'manual' : S.mode });
    }));
    p.querySelectorAll('[data-spd]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = btn.dataset.spd;
      if (a === 'up') setSpeed(desiredSpeed() + speedStep());
      else if (a === 'down') setSpeed(desiredSpeed() - speedStep());
      else if (a === 'reset') toggleResetSpeed();
      else if (a && a.startsWith('preset:')) setSpeed(parseFloat(a.slice(7)));
    }));
    p.querySelectorAll('[data-lvl]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pl = info.player;
      if (pl) {
        try { window.postMessage({ source: 'vm-cmd', type: 'vm-force', playerId: pl.id, index: parseInt(btn.dataset.lvl, 10) }, '*'); } catch (x) {}
      }
    }));
    p.querySelectorAll('[data-rank]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      forceDomRank(rec.video, parseFloat(btn.dataset.rank));
    }));
    const posBtn = p.querySelector('[data-act="pos"]');
    if (posBtn) posBtn.addEventListener('click', (e) => { e.stopPropagation(); resetBadgePos(rec.host); });
    const st = p.querySelector('[data-act="settings"]');
    if (st) st.addEventListener('click', (e) => {
      e.stopPropagation();
      try { chrome.runtime.sendMessage({ type: 'vm-open-options' }); } catch (x) {}
      try { window.open(chrome.runtime.getURL('options.html'), '_blank'); } catch (x) {}
    });
    const infoBtn = p.querySelector('[data-act="info"]');
    if (infoBtn) infoBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleVideoInfo(rec.video); });
  }

  function forceDomRank(video, rank) {
    try {
      const root = containerOf(video);
      const items = findQualityItems(root).concat(root !== document ? findQualityItems(document) : []);
      const cand = items.find((u) => Math.abs(u.q.rank - rank) < 1e-9);
      if (cand) {
        try {
          mouseClick(cand.el);
          const ctl = domCtl.get(video);
          if (ctl) { ctl.lastClick = Date.now(); ctl.curRank = rank; }
          logDom('DOM force click -> ' + describeEl(cand.el));
        } catch (e) {}
      }
    } catch (e) {}
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Клавиша V показывает только значок бейджа: открытая панель при этом закрывается.
  // Отключается чекбоксом «V закрывает открытую панель» в настройках.
  function closeAllPanels() {
    try {
      for (const rec of badges.values()) {
        rec.open = false;
        if (rec.panel) rec.panel.classList.remove('open');
      }
    } catch (e) {}
  }

  async function toggleBadgeHidden(force) {
    const id = await requestTabId();
    if (id === null || id === undefined) return; // без id вкладки точечно не скрыть
    const map = { ...(S.badgeHiddenTabs || {}) };
    const v = typeof force === 'boolean' ? force : !map[id];
    if (v) map[id] = true; else delete map[id];
    S.badgeHiddenTabs = map;
    if (S.closePanelOnShow !== false) closeAllPanels();
    try { await chrome.storage.local.set({ badgeHiddenTabs: map }); } catch (e) {}
    refreshAllBadges();
  }

  // ---------- фуллскрин: переносим бейдж внутрь fullscreen-элемента
  document.addEventListener('fullscreenchange', () => {
    try {
      const fs = document.fullscreenElement;
      for (const [video, rec] of badges) {
        if (fs && fs.contains(video)) {
          if (rec.host.parentElement !== fs && !fs.contains(rec.host)) {
            fs.appendChild(rec.host);
            rec.host.style.position = 'fixed';
            rec.host.style.left = '50%';
            rec.host.style.top = '14px';
            rec.host.style.transform = 'translateX(-50%)';
          }
        } else {
          if (!video.isConnected) { rec.host.remove(); badges.delete(video); continue; }
          placeBadge(video, rec.host);
        }
      }
    } catch (e) {}
  });

  // ---------- хоткей: срабатывает по физическому коду клавиши, поэтому работает
  // и в русской раскладке; слушаем в каждом фрейме, скрытие общее для фреймов вкладки через storage)
  document.addEventListener('keydown', (e) => {
    try {
      if (!e || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // IME-композиция (CJK-ввод) и dead keys — не наше нажатие
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const hk = (S.hotkey || 'v').toLowerCase();
      const code = e.code || '';
      const expectedCode = hk.length === 1 && /[a-z]/.test(hk) ? 'Key' + hk.toUpperCase() : '';
      const byCode = expectedCode && code === expectedCode;
      const byKey = (e.key || '').toLowerCase() === hk;
      const byKeyCode = hk === 'v' && (e.keyCode === 86 || e.which === 86);
      if (byCode || byKey || byKeyCode) {
        e.stopPropagation();
        toggleBadgeHidden();
        return;
      }
      // Скорость — по физическому коду клавиши, работает и в русской раскладке:
      // S — медленнее, D — быстрее, R — сброс к 1.0 / возврат к скорости до сброса, G — переключение с избранной.
      // V занята показом/скрытием бейджа и здесь не используется.
      if (S.speedHotkeys !== false && isActive()) {
        const spdMap = { KeyS: 's', KeyD: 'd', KeyR: 'r', KeyG: 'g' };
        const bySpdCode = spdMap[e.code || ''] || null;
        const k = (e.key || '').toLowerCase();
        const bySpdKey = (k === 's' || k === 'd' || k === 'r' || k === 'g') ? k : null;
        const sk = bySpdCode || bySpdKey;
        if (sk) {
          let hasMedia = false;
          try { hasMedia = !!document.querySelector('video,audio'); } catch (x) {}
          if (!hasMedia) return;
          e.stopPropagation();
          try { e.preventDefault(); } catch (x) {}
          if (sk === 's') setSpeed(desiredSpeed() - speedStep());
          else if (sk === 'd') setSpeed(desiredSpeed() + speedStep());
          else if (sk === 'r') toggleResetSpeed();
          else if (sk === 'g') {
            const pref = clampSpeed(S.preferredSpeed || 1.8);
            setSpeed(Math.abs(desiredSpeed() - 1) < 1e-9 ? pref : 1);
          }
        }
      }
    } catch (err) {}
  }, true);

  // ---------- главный цикл
  function onMainState() {
    if (!isActive()) { refreshAllBadges(); return; }
    for (const v of document.querySelectorAll('video')) {
      try {
        if (v.__vm_skip) continue;
        watchStall(v);
        watchSpeed(v);
        applySpeed(v);
        ensureBadge(v);
        domTick(v);
      } catch (e) {}
    }
    // аудио без картинки: бейдж не нужен, а скорость — да
    try {
      for (const a of document.querySelectorAll('audio')) {
        try { watchSpeed(a); applySpeed(a); } catch (e) {}
      }
    } catch (e) {}
    refreshAllBadges();
    maybeReport(false);
  }

  const mo = new MutationObserver(() => {
    if (!isActive()) return;
    for (const v of document.querySelectorAll('video')) {
      try {
        if (v.__vm_skip) continue;
        watchStall(v);
        watchSpeed(v);
        applySpeed(v);
        ensureBadge(v);
      } catch (e) {}
    }
    maybeReport(false);
  });

  // ---------- диагностика
  function buildDiagnostics() {
    const vids = Array.from(document.querySelectorAll('video')).slice(0, 6).map((v) => {
      const ctl = domCtl.get(v);
      return {
        size: (v.clientWidth || 0) + 'x' + (v.clientHeight || 0),
        vmVid: (v.dataset && v.dataset.vmVid) || null,
        sizeCapRank: sizeCapRankFor(v),
        rate: (() => { try { return v.playbackRate; } catch (e) { return '?'; } })(),
        // Прямые свойства медиаэлемента (читаются без плеера — для таблицы техинфо в попапе)
        media: (() => {
          try {
            let bufAhead = 0;
            try {
              const b = v.buffered, t = v.currentTime || 0;
              for (let i = 0; i < b.length; i++) {
                if (b.start(i) <= t && t <= b.end(i)) { bufAhead = Math.round((b.end(i) - t) * 10) / 10; break; }
              }
            } catch (e) {}
            return {
              paused: !!v.paused, muted: !!v.muted,
              volume: (() => { try { return Math.round(v.volume * 100) / 100; } catch (e) { return '?'; } })(),
              time: (() => { try { return Math.round((v.currentTime || 0) * 10) / 10; } catch (e) { return '?'; } })(),
              dur: (() => { try { return isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null; } catch (e) { return null; } })(),
              buf: bufAhead, rs: v.readyState, ns: v.networkState,
              frame: (v.videoWidth || 0) + 'x' + (v.videoHeight || 0),
              loop: !!v.loop,
              drop: (() => { try { const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; return q ? { d: q.droppedVideoFrames || 0, t: q.totalVideoFrames || 0, c: q.corruptedVideoFrames || 0 } : null; } catch (e) { return null; } })(),
              played: trSum(v.played),
              bufAll: trSum(v.buffered),
              seekN: (() => { try { return (v.seekable && v.seekable.length) || 0; } catch (e) { return 0; } })(),
              ended: !!v.ended, seeking: !!v.seeking,
              autoplay: !!v.autoplay, controls: !!v.controls, defaultMuted: !!v.defaultMuted,
              cors: (() => { try { return v.getAttribute ? (v.getAttribute('crossorigin') || '') : ''; } catch (e) { return ''; } })(),
              pitch: (() => { try { const p = v.preservesPitch !== undefined ? v.preservesPitch : v.webkitPreservesPitch !== undefined ? v.webkitPreservesPitch : v.mozPreservesPitch; return p === undefined ? null : !!p; } catch (e) { return null; } })(),
              sink: (() => { try { return (typeof v.sinkId === 'string' && v.sinkId) ? v.sinkId : ''; } catch (e) { return ''; } })(),
              drm: (() => { try { return !!v.mediaKeys; } catch (e) { return false; } })(),
              err: (() => { try { return (v.error && v.error.code) || 0; } catch (e) { return 0; } })(),
              slen: (() => { try { const m = videoStreamMeta.get(v); return (m && m.len) || 0; } catch (e) { return 0; } })(),
              segs: (() => { try { const m = videoStreamMeta.get(v); return (m && m.segs) || 0; } catch (e) { return 0; } })(),
              loaded: loadedTsBytes().total || 0,
              qerr: videoQErr.get(v) || '',
              qsizes: videoQSize.get(v) || null, // вес по качествам {label:bytes} (повтор запроса плеера)
              tracksA: (() => { try { const o = []; const at = v.audioTracks; if (at) for (let i = 0; i < at.length; i++) o.push({ label: at[i].label || '', lang: at[i].language || '', on: !!at[i].enabled }); return o; } catch (e) { return []; } })(),
              tracksV: (() => { try { const o = []; const vt = v.videoTracks; if (vt) for (let i = 0; i < vt.length; i++) o.push({ label: vt[i].label || '', on: !!vt[i].selected }); return o; } catch (e) { return []; } })(),
              tracksT: (() => { try { const o = []; const tt = v.textTracks; if (tt) for (let i = 0; i < tt.length; i++) { let cues = null; try { cues = tt[i].cues ? tt[i].cues.length : 0; } catch (e) {} o.push({ label: tt[i].label || '', lang: tt[i].language || '', mode: tt[i].mode || '', cues }); } return o; } catch (e) { return []; } })(),
            };
          } catch (e) { return {}; }
        })(),
        src: (v.currentSrc || v.src || '').slice(0, 200),
        domLevels: ctl && ctl.items ? ctl.items : [],
        domCurRank: ctl ? ctl.curRank : -1,
        domClicks: ctl ? ctl.clicks : 0,
        domOpenerAgoSec: ctl && ctl.lastOpener ? Math.round((Date.now() - ctl.lastOpener) / 1000) : -1,
      };
    });
    return {
      version: VM_VERSION,
      frameUrl: location.href,
      isTop: window.top === window,
      active: isActive(),
      // разведка: где вообще лежат пункты меню в этом документе
      recon: (() => {
        try {
          let shadowHosts = 0;
          let shadowF2id = 0;
          try {
            for (const r of scanRoots()) {
              if (r !== document) {
                shadowHosts++;
                try { shadowF2id += r.querySelectorAll('[f2id]').length; } catch (e) {}
              }
            }
          } catch (e) {}
          let fidQVis = false;
          try {
            for (const f of deepQueryAll('[fid]')) {
              const cs = getComputedStyle(f);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              if (/качеств/i.test((f.innerText || f.textContent || ''))) { fidQVis = true; break; }
            }
          } catch (e) {}
          return {
            videos: document.querySelectorAll('video').length,
            iframes: document.querySelectorAll('iframe').length,
            f2id: deepQueryAll('[f2id]').length,
            fid: deepQueryAll('[fid]').length,
            cdnsettings: deepQueryAll('#cdnplayer_settings').length > 0,
            pjsdiv: deepQueryAll('pjsdiv').length,
            gearBtns: (() => { try { return gearCandidates(document).length; } catch (e) { return -1; } })(),
            settingsOpen: (() => { try { return settingsVisible(); } catch (e) { return false; } })(),
            fidQualityVisible: fidQVis,
            shadowHosts,
            shadowF2id,
          };
        } catch (e) { return { error: String(e) }; }
      })(),
      settings: { enabled: S.enabled, mode: S.mode, cap: S.cap, considerSize: S.considerSize, siteMode: S.siteMode },
      speed: { want: desiredSpeed(), step: speedStep(), preferred: clampSpeed(S.preferredSpeed || 1.8), hotkeys: S.speedHotkeys !== false },
      mainAlive,
      players: mainState.players || [],
      videos: vids,
      added: (() => { try { return updatesLinesSync(); } catch (e) { return []; } })(),
      updates: (() => { try { return { loaded: updatesCache.loaded, error: updatesCache.error || '', at: updatesCache.at || 0 }; } catch (e) { return {}; } })(),
      events: (mainState.events || []).concat(domLog),
    };
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'vm-collect-diagnostics') return;
    try {
      // свежий скан перед ответом — прямой запрос всегда показывает актуальное
      const vids = Array.from(document.querySelectorAll('video'));
      const respond = () => {
        try { sendResponse(buildDiagnostics()); }
        catch (e) { sendResponse({ error: String(e), version: VM_VERSION }); }
      };
      for (const v of vids) {
        try { watchStall(v); watchSpeed(v); applySpeed(v); ensureBadge(v); domTick(v, true); } catch (e) {}
      }
      if (!vids.length && !(mainState.players || []).length) {
        // пустой фрейм отвечает с задержкой — первым отвечает фрейм с видео
        setTimeout(respond, 500);
      } else {
        respond();
      }
    }
    catch (e) { sendResponse({ error: String(e), version: VM_VERSION }); }
    // и сразу шлём репорт — каждое нажатие «Обновить» гарантированно
    // наполняет кэш и список вкладок, даже если интервал ещё не сработал
    try { setTimeout(() => maybeReport(true), 300); } catch (e) {}
    return true; // асинхронный ответ (случай с setTimeout)
  });
  // периодический репорт в background (для попапа/настроек: все фреймы вкладки)
  let lastReport = 0;
  function maybeReport(force) {
    try {
      const now = Date.now();
      if (!force && now - lastReport < 5000) return;
      if (!document.querySelector('video') && !(mainState.players || []).length) return;
      lastReport = now;
      chrome.runtime.sendMessage({ type: 'vm-diag-report', payload: buildDiagnostics() }, () => {
        if (chrome.runtime.lastError) { /* background спит — проснётся от следующего */ }
      });
    } catch (e) {}
  }
  setInterval(() => maybeReport(true), 5000);

  // ---------- init
  (async () => {
    await requestTabId(); // id вкладки нужен badgeAllowed и сбросу скрытия при загрузке
    await loadSettings();
    // новая загрузка страницы = «старт»: скрытие этой вкладки сбрасывается, бейдж снова показывается.
    // Только топ-фрейм (перезагрузка рекламного iframe не должна возвращать бейдж).
    try {
      if (window.top === window && S.badgeDefaultVisible !== false &&
          myTabId !== null && myTabId !== undefined && S.badgeHiddenTabs && S.badgeHiddenTabs[myTabId]) {
        const m = { ...S.badgeHiddenTabs };
        delete m[myTabId];
        S.badgeHiddenTabs = m;
        await chrome.storage.local.set({ badgeHiddenTabs: m });
      }
    } catch (e) {}
    getBadgePos();
    pushSettingsToMain();
    try { updatesEnsure(); } catch (e) {} // «Добавлено»: тянем updates.json в фоне
    try {
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) {}
    try { window.postMessage({ source: 'vm-cmd', type: 'vm-ping' }, '*'); } catch (e) {}
    setInterval(() => {
      if (!isActive()) return;
      for (const v of document.querySelectorAll('video')) {
        try { applySpeed(v); domTick(v); probeStreamMeta(v); probeStreamSizes(v); } catch (e) {}
      }
      try { topQsTick(); } catch (e) {} // топ-кадр собирает размеры для всех (видео обычно в iframe)
      try {
        for (const a of document.querySelectorAll('audio')) {
          try { applySpeed(a); } catch (e) {}
        }
      } catch (e) {}
      refreshAllBadges();
    }, 5000);
  })();
})();
