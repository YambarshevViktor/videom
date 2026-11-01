// Video Manager — options page.
const CAPS = [[360, '360p'], [480, '480p'], [720, '720p'], [1080, '1080p'], [1081, '1080p Ultra'], [1440, '2K · 1440p'], [2160, '4K · 2160p']];
const $ = (id) => document.getElementById(id);
let lastDiag = null;

async function load() {
  return chrome.storage.local.get(['enabled', 'mode', 'cap', 'considerSize', 'badgeDefaultVisible',
    'closePanelOnShow', 'badgeHiddenTabs', 'hotkey', 'siteMode', 'sites', 'perSite',
    'speed', 'speedStep', 'preferredSpeed', 'speedHotkeys']);
}

// Вкладка, выбранная в «Диагностике вкладки», — кнопка «Скрыть сейчас» действует на неё
function diagSelTab() {
  try {
    const v = $('diagTab') && $('diagTab').value;
    return v ? Number(v) : null;
  } catch (e) { return null; }
}

function render(s) {
  $('enabled').checked = !!s.enabled;
  document.querySelectorAll('#modeSeg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === s.mode));
  $('capRow').innerHTML = '';
  for (const [v, l] of CAPS) {
    const b = document.createElement('button');
    b.textContent = l;
    if (s.cap === v) b.classList.add('on');
    b.addEventListener('click', () => chrome.storage.local.set({ cap: v }));
    $('capRow').appendChild(b);
  }
  $('considerSize').checked = s.considerSize !== false;
  $('badgeDefaultVisible').checked = s.badgeDefaultVisible !== false;
  $('closePanelOnShow').checked = s.closePanelOnShow !== false;
  $('hotkey').value = s.hotkey || 'v';
  const selTab = diagSelTab();
  $('toggleHidden').textContent = (selTab !== null && s.badgeHiddenTabs && s.badgeHiddenTabs[selTab]) ? 'Показать сейчас' : 'Скрыть сейчас';
  $('speedStep').value = (s.speedStep !== undefined ? s.speedStep : 0.25);
  $('preferredSpeed').value = (s.preferredSpeed !== undefined ? s.preferredSpeed : 1.8);
  $('speedHotkeys').checked = s.speedHotkeys !== false;
  $('speedReset').textContent = 'Сбросить к 1.0' + ((Number(s.speed) || 1) !== 1 ? ' (сейчас ' + s.speed + 'x)' : '');
  document.querySelectorAll('#siteModeSeg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.sm === s.siteMode));
  renderSites(s);
}

function renderSites(s) {
  const box = $('siteList');
  box.innerHTML = '';
  const sites = s.sites || [];
  const per = s.perSite || {};
  const perKeys = Object.keys(per);
  if (!sites.length && !perKeys.length) {
    box.innerHTML = '<div class="empty">Список пуст. Добавьте домен выше.</div>';
    return;
  }
  for (const p of sites) {
    const row = document.createElement('div');
    row.className = 's';
    const code = document.createElement('code');
    code.textContent = p;
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.title = 'Удалить';
    x.addEventListener('click', async () => {
      const cur = (await load()).sites || [];
      await chrome.storage.local.set({ sites: cur.filter((z) => z !== p) });
      renderSites(await load());
    });
    row.appendChild(code); row.appendChild(x); box.appendChild(row);
  }
  for (const h of perKeys) {
    const row = document.createElement('div');
    row.className = 's';
    const code = document.createElement('code');
    code.textContent = `${h} → ${per[h] ? 'вкл (исключение)' : 'выкл (исключение)'}`;
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.title = 'Сбросить правило';
    x.addEventListener('click', async () => {
      const cur = { ...((await load()).perSite || {}) };
      delete cur[h];
      await chrome.storage.local.set({ perSite: cur });
      renderSites(await load());
    });
    row.appendChild(code); row.appendChild(x); box.appendChild(row);
  }
}

async function loadRecentTabs() {
  const sel = $('diagTab');
  sel.innerHTML = '';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'vm-recent-tabs' });
    const tabs = (r && r.tabs) || [];
    if (!tabs.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'Нет вкладок с видео (откройте видео и подождите 5 с)';
      sel.appendChild(o);
      return null;
    }
    for (const t of tabs) {
      const o = document.createElement('option');
      o.value = String(t.tabId);
      let label = '';
      try {
        const u = new URL(t.url);
        label = u.hostname + u.pathname.slice(0, 40);
      } catch (e) { label = String(t.url || ('вкладка ' + t.tabId)).slice(0, 60); }
      o.textContent = label;
      sel.appendChild(o);
    }
    return Number(tabs[0].tabId);
  } catch (e) {
    return null;
  }
}

async function refreshDiag() {
  $('diagBox').textContent = 'Опрашиваю вкладку…';
  try {
    await loadRecentTabs();
    const selTabId = $('diagTab').value ? Number($('diagTab').value) : undefined;
    // Самопочинка внедрения + строка статуса в начало отчёта
    try {
      const ar = await chrome.runtime.sendMessage({ type: 'vm-apply-scripts' });
      const reg = ar && ar.reg;
      if (reg) {
        out.push('ВНЕДРЕНИЕ: ' + (reg.ok
          ? 'OK (' + (reg.note || '') + ', целей: ' + ((reg.matches || []).length) + ')'
          : 'ОШИБКА: ' + (reg.error || 'неизвестно')));
        out.push('Цели: ' + (((reg.matches || []).join(', ')) || '— (никуда не внедряемся!)'));
      }
    } catch (e) {
      out.push('ВНЕДРЕНИЕ: не удалось опросить background (' + e + ')');
    }
    // 1) прямая проверка: жив ли вообще контент-скрипт на выбранной вкладке
    let direct = null;
    try {
      direct = await chrome.runtime.sendMessage({ type: 'vm-tab-diagnostics', tabId: selTabId });
    } catch (e) {
      direct = { error: String((e && e.message) || e) };
    }
    // кэш смотрим по той вкладке, которую реально опросили напрямую
    const useTabId = (direct && direct.tab && direct.tab.id !== undefined) ? direct.tab.id : selTabId;
    // 2) кэш по всем фреймам
    const r = await chrome.runtime.sendMessage({ type: 'vm-diag-get', tabId: useTabId });
    lastDiag = r;
    const frames = (r && r.frames) || [];
    const out = [];
    if (direct && direct.error) {
      out.push('ПРЯМАЯ СВЯЗЬ: НЕТ (' + direct.error + ')');
      out.push('Это значит, что контент-скрипт не внедрён в эту вкладку.');
      out.push('Что сделать: 1) перезагрузите вкладку с видео; 2) подождите 5–10 с воспроизведения; 3) нажмите «Обновить» снова.');
    } else if (direct && direct.res) {
      out.push('ПРЯМАЯ СВЯЗЬ: ЕСТЬ (топ-фрейм отвечает).');
      out.push('версия скрипта во вкладке: ' + (direct.res.version || '?') + ' (должна быть 0.1.38 — если меньше, вкладка не перезагружена после обновления)');
      out.push('разведка DOM: ' + JSON.stringify(direct.res.recon || {}));
      for (const v of (direct.res.videos || [])) {
        out.push(`video ${v.size}${v.vmVid ? ' ← ' + v.vmVid : ''} текУровень=${v.domCurRank} кликов=${v.domClicks} открывалка=${v.domOpenerAgoSec >= 0 ? v.domOpenerAgoSec + 'с назад' : '—'}`);
        out.push('  уровни: ' + (((v.domLevels || []).map((x) => x.label).join(', ')) || 'НЕ НАЙДЕНЫ'));
      }
      out.push('players: ' + JSON.stringify((direct.res.players || []).map((p) => p.kind + ':' + (p.levels && p.levels[p.current] ? p.levels[p.current].label : '?'))));
      const evs = (direct.res.events || []).slice(-6).map((e) => (e.t ? e.t.slice(11, 19) + ' ' : '') + (e.text || JSON.stringify(e)));
      if (evs.length) { out.push('события:'); for (const e of evs) out.push('  ' + e); }
    }
    out.push('--- кэш фреймов: ' + frames.length + (useTabId !== undefined ? ' (вкладка ' + useTabId + ')' : ' (активная вкладка)') + ' ---');
    if (!frames.length) {
      out.push('Видео не найдено. Откройте вкладку с видео, подождите ~5 c и нажмите «Обновить».');
    } else {
      out.push(JSON.stringify(r, null, 1).slice(0, 12000));
    }
    $('diagBox').textContent = out.join('\n');
  } catch (e) {
    $('diagBox').textContent = 'Ошибка: ' + e;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  render(await load());
  loadRecentTabs();
  chrome.storage.onChanged.addListener(async (chg, area) => {
    if (area === 'local') render(await load());
  });

  $('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));
  document.querySelectorAll('#modeSeg button').forEach((b) =>
    b.addEventListener('click', () => chrome.storage.local.set({ mode: b.dataset.mode })));
  $('considerSize').addEventListener('change', (e) => chrome.storage.local.set({ considerSize: e.target.checked }));
  $('badgeDefaultVisible').addEventListener('change', (e) => chrome.storage.local.set({ badgeDefaultVisible: e.target.checked }));
  $('closePanelOnShow').addEventListener('change', (e) => chrome.storage.local.set({ closePanelOnShow: e.target.checked }));
  $('hotkey').addEventListener('change', (e) => {
    const v = (e.target.value || 'v').trim().toLowerCase().slice(0, 1) || 'v';
    e.target.value = v;
    chrome.storage.local.set({ hotkey: v });
  });
  $('toggleHidden').addEventListener('click', async () => {
    // действует на вкладку, выбранную в «Диагностике вкладки»
    const t = diagSelTab();
    if (t === null) return;
    const s = await load();
    const m = { ...(s.badgeHiddenTabs || {}) };
    if (m[t]) delete m[t]; else m[t] = true;
    chrome.storage.local.set({ badgeHiddenTabs: m });
  });
  $('speedStep').addEventListener('change', (e) => {
    let v = parseFloat(String(e.target.value).replace(',', '.'));
    if (!isFinite(v) || v <= 0) v = 0.25;
    v = Math.min(4, Math.max(0.05, Math.round(v * 100) / 100));
    e.target.value = v;
    chrome.storage.local.set({ speedStep: v });
  });
  $('preferredSpeed').addEventListener('change', (e) => {
    let v = parseFloat(String(e.target.value).replace(',', '.'));
    if (!isFinite(v)) v = 1.8;
    v = Math.min(16, Math.max(0.07, Math.round(v * 100) / 100));
    e.target.value = v;
    chrome.storage.local.set({ preferredSpeed: v });
  });
  $('speedHotkeys').addEventListener('change', (e) => chrome.storage.local.set({ speedHotkeys: e.target.checked }));
  $('speedReset').addEventListener('click', () => chrome.storage.local.set({ speed: 1 }));
  document.querySelectorAll('#siteModeSeg button').forEach((b) =>
    b.addEventListener('click', () => chrome.storage.local.set({ siteMode: b.dataset.sm })));
  $('addSite').addEventListener('click', async () => {
    const v = $('siteInput').value.trim().toLowerCase();
    if (!v) return;
    const s = await load();
    const sites = s.sites || [];
    if (!sites.includes(v)) {
      sites.push(v);
      await chrome.storage.local.set({ sites });
    }
    $('siteInput').value = '';
    renderSites(await load());
  });
  $('siteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addSite').click(); });

  $('diagBtn').addEventListener('click', refreshDiag);
  $('diagTab').addEventListener('change', async () => render(await load())); // подпись кнопки зависит от выбранной вкладки
  $('copyDiag').addEventListener('click', async () => {
    if (!lastDiag) return;
    try { await navigator.clipboard.writeText(JSON.stringify(lastDiag, null, 1)); $('copyDiag').textContent = 'Скопировано ✓'; }
    catch (e) { $('copyDiag').textContent = 'Не вышло'; }
    setTimeout(() => { $('copyDiag').textContent = 'Скопировать JSON'; }, 1500);
  });

  $('exportBtn').addEventListener('click', async () => {
    const s = await load();
    delete s.badgeHiddenTabs; // повкладочное скрытие не экспортируем (id вкладок одноразовые)
    const blob = new Blob([JSON.stringify(s, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'video-manager-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const keys = ['enabled', 'mode', 'cap', 'considerSize', 'badgeDefaultVisible', 'closePanelOnShow', 'hotkey', 'siteMode', 'sites', 'perSite',
        'speed', 'speedStep', 'preferredSpeed', 'speedHotkeys'];
      const patch = {};
      for (const k of keys) if (data[k] !== undefined) patch[k] = data[k];
      await chrome.storage.local.set(patch);
    } catch (err) { alert('Не получилось импортировать: ' + err); }
    e.target.value = '';
  });
});
