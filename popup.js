// Video Manager — popup.
const CAPS = [[360, '360p'], [480, '480p'], [720, '720p'], [1080, '1080p'], [1081, '1080U'], [1440, '2K'], [2160, '4K']];
const HINTS = {
  smart: 'Старт с уровня под окно и сеть, шаг вниз при буферизации, возврат вверх после стабильности.',
  max: 'Всегда высший доступный уровень. Без автоснижения — может буферить.',
  manual: 'Всегда высший уровень, но не выше потолка. Без адаптации.',
};
const $ = (id) => document.getElementById(id);

async function getSettings() {
  return chrome.storage.local.get(['enabled', 'mode', 'cap', 'considerSize', 'siteMode', 'sites', 'perSite',
    'speed', 'speedStep', 'preferredSpeed']);
}

function fmtSpeed(v) {
  const n = Number(v);
  return ((isFinite(n) ? Math.min(16, Math.max(0.07, Math.round(n * 100) / 100)) : 1)) + '×';
}
function curStep(s) {
  const v = Number(s.speedStep);
  return v > 0 && isFinite(v) ? Math.min(4, v) : 0.25;
}
function renderSpeed(s) {
  const el = $('spdVal');
  if (el) el.textContent = fmtSpeed(s.speed);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}
function matchSite(pattern, host) {
  const p = String(pattern || '').trim().toLowerCase();
  if (!p || !host) return false;
  if (p === host) return true;
  if (p.startsWith('*.')) { const b = p.slice(2); return host === b || host.endsWith('.' + b); }
  return host === p || host.endsWith('.' + p);
}
function allowedOn(host, s) {
  if (s.perSite && s.perSite[host] === true) return true;
  if (s.perSite && s.perSite[host] === false) return false;
  const listed = (s.sites || []).some((p) => matchSite(p, host));
  return s.siteMode === 'allowlist' ? listed : !listed;
}

function render(s) {
  $('enabled').checked = !!s.enabled;
  document.querySelectorAll('#modeSeg button').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === s.mode));
  $('modeHint').textContent = HINTS[s.mode] || '';
  renderSpeed(s);
  $('capRow').innerHTML = '';
  for (const [v, l] of CAPS) {
    const b = document.createElement('button');
    b.textContent = l;
    if (s.cap === v) b.classList.add('on');
    b.addEventListener('click', async () => {
      await chrome.storage.local.set({ cap: v, mode: s.mode === 'max' ? 'manual' : s.mode });
      Object.assign(s, { cap: v }); render(s);
    });
    $('capRow').appendChild(b);
  }
}

async function init() {
  const s = await getSettings();
  render(s);

  $('enabled').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ enabled: e.target.checked });
  });
  document.querySelectorAll('#modeSeg button').forEach((b) =>
    b.addEventListener('click', async () => {
      await chrome.storage.local.set({ mode: b.dataset.mode });
      s.mode = b.dataset.mode; render(s);
    }));
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Скорость: пишем в storage — контент-скрипты подхватят через onChanged и
  // поставят video.playbackRate напрямую, без меню плеера.
  const clampSpd = (n) => {
    n = Number(n);
    if (!isFinite(n)) return 1;
    return Math.min(16, Math.max(0.07, Math.round(n * 100) / 100));
  };
  $('spdDown').addEventListener('click', async () => {
    s.speed = clampSpd((Number(s.speed) || 1) - curStep(s));
    await chrome.storage.local.set({ speed: s.speed });
    renderSpeed(s);
  });
  $('spdUp').addEventListener('click', async () => {
    s.speed = clampSpd((Number(s.speed) || 1) + curStep(s));
    await chrome.storage.local.set({ speed: s.speed });
    renderSpeed(s);
  });
  $('spdVal').addEventListener('click', async () => {
    s.speed = 1;
    await chrome.storage.local.set({ speed: 1 });
    renderSpeed(s);
  });

  // текущий сайт
  let host = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    host = tab && tab.url ? hostOf(tab.url) : '';
  } catch (e) {}
  $('siteHost').textContent = host || '—';
  const tgl = $('siteToggle');
  const upd = () => {
    const on = allowedOn(host, s);
    tgl.textContent = on ? 'Выкл здесь' : 'Вкл здесь';
    tgl.classList.toggle('off', !on);
  };
  upd();
  tgl.addEventListener('click', async () => {
    const per = { ...(s.perSite || {}) };
    per[host] = !allowedOn(host, s);
    await chrome.storage.local.set({ perSite: per });
    s.perSite = per; upd();
  });

  // статус вкладки
  try {
    // Самопочинка внедрения: если регистрация не выполнилась при ⟳ расширения,
    // она выполнится сейчас. После этого вкладку с видео нужно перезагрузить.
    let reg = null;
    try {
      const ar = await chrome.runtime.sendMessage({ type: 'vm-apply-scripts' });
      reg = ar && ar.reg;
    } catch (e) {}
    if (reg && reg.ok === false) {
      $('statusBox').textContent = 'Не удалось внедрить скрипты: ' + (reg.error || 'ошибка') +
        '\nПроверьте разрешение scripting и перезагрузите браузер.';
      $('techDetails').style.display = 'none';
      return;
    }
    const r = await chrome.runtime.sendMessage({ type: 'vm-diag-get' });
    const frames = (r && r.frames) || [];
    if (!frames.length) {
      $('statusBox').textContent = 'На этой вкладке видео пока не найдено.\nОткройте видео — статус появится здесь.';
      $('techDetails').style.display = 'none';
      return;
    }
    const lines = [];
    for (const f of frames.slice(0, 3)) {
      const pls = (f.players || []).map((p) => {
        const cur = p.levels && p.levels[p.current] ? p.levels[p.current].label : '?';
        return `${p.kind}: ${cur} (${(p.levels || []).length} ур.)`;
      });
      const dom = (f.videos || []).map((v) => `video ${v.size}${v.vmVid ? ' ← ' + v.vmVid : ''}`).join(', ');
      lines.push(`• ${f.isTop ? 'топ' : 'фрейм'} ${shortUrl(f.frameUrl)}\n  ${pls.join(' · ') || 'плеер API не пойман'}${dom ? '\n  ' + dom : ''}`);
    }
    $('statusBox').textContent = lines.join('\n');

    // Техинфо: прямые свойства медиаэлементов таблицей (читаются без плеера).
    // details всегда свёрнут — раскрывается только кликом по заголовку «Инфо».
    const tech = $('techDetails'), body = $('techBody');
    const all = [];
    for (const f of frames) for (const v of (f.videos || [])) if (v.media) all.push({ f, v });
    if (!all.length) {
      tech.style.display = 'none';
    } else {
      tech.style.display = '';
      body.innerHTML = '';
      const RS = ['нет данных', 'метаданные', 'текущий кадр', 'можно играть', 'хватает с запасом'];
      const NS = ['пусто', 'простой', 'грузит', 'нет источника'];
      const fmtT = (s) => {
        if (s === null || s === undefined || !isFinite(s)) return '—';
        s = Math.max(0, Math.floor(s));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
        return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
      };
      all.slice(0, 4).forEach(({ f, v }, i) => {
        const m = v.media || {};
        const h = document.createElement('h4');
        h.textContent = 'Видео' + (all.length > 1 ? ' ' + (i + 1) : '') + ' · ' + (f.isTop ? 'топ-кадр' : 'фрейм');
        body.appendChild(h);
        const t = document.createElement('table');
        const NL = (a) => a.filter(Boolean).join('\n');
        const fmtR = (n) => { n = Math.round(Number(n) * 100) / 100; return isFinite(n) ? String(n) + '×' : '?'; };
        const fmtB = (n) => {
          try {
            n = Number(n);
            if (!isFinite(n) || n <= 0) return '';
            if (n >= 1073741824) return (Math.round(n / 1073741824 * 10) / 10) + ' ГБ';
            if (n >= 1048576) return (Math.round(n / 1048576 * 10) / 10) + ' МБ';
            if (n >= 1024) return Math.round(n / 1024) + ' КБ';
            return Math.round(n) + ' Б';
          } catch (e) { return ''; }
        };
        const stateL = [];
        if (m.ended) stateL.push('Видео закончилось');
        else if (m.paused) stateL.push('Стоит на паузе');
        else if (m.rs < 3) stateL.push('Ждёт данные — крутится загрузка');
        else stateL.push('Играет');
        stateL.push((m.seekN || 0) > 0 ? 'Перемотка работает' : 'Перемотку сайт не разрешает');
        if (m.seeking) stateL.push('Прямо сейчас перематывает');
        const timeL = ['Сейчас идёт ' + fmtT(m.time)];
        if (m.dur) { timeL.push('Всего длится ' + fmtT(m.dur)); timeL.push('Просмотрено ' + Math.round((m.time / m.dur) * 100) + '%'); }
        else { timeL.push('Это прямой эфир'); timeL.push('Конца нет — идёт в реальном времени'); }
        if (m.played && m.played.n > 0) { timeL.push('Смотреных кусков: ' + m.played.n); timeL.push('Суммарно смотрено ' + fmtT(m.played.total)); }
        const spdL = ['Сейчас ' + fmtR(v.rate)];
        spdL.push(Math.abs(Number(v.rate) - 1) > 1e-9 ? 'Ускорено' : 'Обычная скорость без ускорения');
        if (m.pitch !== null && m.pitch !== undefined) spdL.push(m.pitch ? 'Голос не меняется' : 'Голос становится выше и быстрее');
        const sndL = [m.muted ? 'Звук выключен' : 'Звук включён', 'Громкость ' + Math.round((m.volume ?? 1) * 100) + '%'];
        if (m.defaultMuted) sndL.push('Сайт запускает видео без звука');
        (m.tracksA || []).forEach((tr, i) => {
          sndL.push('Дорожка ' + (i + 1) + ': ' + (tr.label || 'без названия'));
          if (tr.lang) sndL.push('Язык: ' + tr.lang);
          sndL.push(tr.on ? 'Статус: играет сейчас' : 'Статус: запасная');
        });
        if (!(m.tracksA || []).length) sndL.push('Дорожка одна — та, что зашита в видео');
        if (m.sink) sndL.push('Куда играет: ' + m.sink);
        const subL = [];
        if ((m.tracksT || []).length) {
          subL.push('Дорожек субтитров: ' + m.tracksT.length);
          m.tracksT.forEach((tr, i) => {
            subL.push('Субтитры ' + (i + 1) + ': ' + (tr.label || tr.lang || 'без названия'));
            if (tr.lang && tr.label) subL.push('Язык: ' + tr.lang);
            subL.push('Статус: ' + (tr.mode === 'showing' ? 'Показаны на экране' : tr.mode === 'hidden' ? 'Скрыты' : 'Выключены'));
            if (tr.cues !== null && tr.cues !== undefined) subL.push('Фраз всего: ' + tr.cues);
          });
        } else subL.push('Субтитров нет');
        const vidL = [];
        if ((m.tracksV || []).length) {
          vidL.push('Видеодорожек: ' + m.tracksV.length);
          m.tracksV.forEach((tr, i) => {
            vidL.push('Видео ' + (i + 1) + ': ' + (tr.label || 'без названия'));
            vidL.push(tr.on ? 'Статус: выбрана' : 'Статус: запасная');
          });
        } else vidL.push('Дорожка одна — та, что в видео');
        const bufL = [
          'Впереди подгружено ' + (m.buf || 0) + ' с',
          'Всего в кэше ' + ((m.bufAll && m.bufAll.total) || 0) + ' с',
          'Кусков в кэше: ' + ((m.bufAll && m.bufAll.n) || 0),
          'Сеть сейчас: ' + (NS[m.ns] || m.ns),
          'Готовность: ' + (RS[m.rs] || m.rs),
        ];
        const srcL = [];
        if (v.src) {
          srcL.push('Адрес: ' + (String(v.src).startsWith('blob:') ? 'поток в памяти' : shortUrl(v.src)));
          if (String(v.src).startsWith('blob:')) srcL.push('Тип: поток, который собрал плеер сайта');
          else if (!m.dur) srcL.push('Тип: прямой эфир');
          else srcL.push('Тип: обычный видеофайл');
        } else srcL.push('Адрес пока пуст — поток не подключён');
        srcL.push(m.cors ? 'Доступ чужому сайту: ' + (m.cors === 'anonymous' ? 'разрешён' : m.cors) : 'Чужому сайту не отдаётся');
        const miscL = [
          m.autoplay ? 'Автозапуск включён' : 'Само не запускается',
          m.loop ? 'Повтор по кругу включён' : 'Повтор выключен',
          m.controls ? 'Кнопки браузера показаны' : 'Кнопок браузера нет',
          m.drm ? 'Стоит защита от копирования' : 'Защиты от копирования нет',
        ];
        if (m.err) miscL.push('Ошибка видео! Код ' + m.err);
        const lvlL = (function () {
          try {
            const it = (v.domLevels || []).find((l) => l.rank === v.domCurRank);
            return (it && it.label) || '';
          } catch (e) { return ''; }
        })();
        const wgtL = [];
        const qk = (m.qsizes && typeof m.qsizes === 'object') ? Object.keys(m.qsizes) : [];
        if (qk.length) {
          for (const k of qk) { const b = fmtB(m.qsizes[k]); if (b) wgtL.push(k + ' — ' + b); }
        }
        if (!wgtL.length && m.slen) wgtL.push('Весит ' + fmtB(m.slen));
        else if (!wgtL.length && m.segs) {
          wgtL.push('Поток идёт кусками (HLS)');
          wgtL.push('Кусков в списке: ' + m.segs);
          if (m.loaded) wgtL.push('Подгружено объёмом ' + fmtB(m.loaded));
          if (m.qerr) wgtL.push('Разбивки нет: ' + m.qerr);
        }
        if (!wgtL.length && m.qerr) wgtL.push('Не получилось: ' + m.qerr);
        if (!wgtL.length) wgtL.push('Пока неизвестно — поток ещё не начался');
        const factL = [];
        (function () {
          try {
            const hm = String(m.frame || '').match(/(\d+)x(\d+)/);
            if (hm) factL.push('Идёт ' + hm[1] + ' на ' + hm[2] + ' точек');
            else factL.push('Кадр пока неизвестен — поток не начался');
          } catch (e) {}
          try {
            let exp = 0;
            const lm = String(lvlL).match(/(\d{3,4})/);
            if (lm) exp = parseInt(lm[1], 10);
            const parts = String(m.frame || '').split('x');
            const vh = parseInt(parts[1] || '0', 10) || 0;
            if (/ultra/i.test(lvlL) && m.dur > 0 && m.dur < 600) {
              factL.push('Похоже на тизер — вместо фильма заглушка, для Ultra нужен премиум');
            } else if (exp > 0 && vh > 0 && vh < exp * 0.9) {
              factL.push('Ниже выбранного: выбрано ' + lvlL);
            } else if (exp > 0 && lvlL) {
              factL.push('Сходится с выбранным (' + lvlL + ')');
            }
          } catch (e) {}
        })();
        const rows = [
          ['Состояние', NL(stateL)],
          ['Время', NL(timeL)],
          ['Скорость', NL(spdL)],
          ['Звук', NL(sndL)],
          ['Субтитры', NL(subL)],
          ['Видеодорожки', NL(vidL)],
          ['Картинка', NL(['Кадр ' + (m.frame && m.frame !== '0x0' ? m.frame.replace('x', ' на ') : '—') + ' точек', 'Окно плеера ' + (v.size || '—')])],
          ['Кадры', m.drop ? NL(['Показано ' + m.drop.t, 'Пропущено ' + m.drop.d, 'Битых ' + (m.drop.c || 0), m.drop.d > 0 ? 'Есть пропуски — слабый декодер или сеть' : 'Всё гладко, без пропусков']) : 'Нет данных'],
          ['Буфер и сеть', NL(bufL)],
          ['Источник', NL(srcL)],
          ['Вес', NL(wgtL)],
          ['По факту', NL(factL)],
          ['Прочее', NL(miscL)],
        ];
        // «Добавлено» — только если контент-скрипт вернул историю (rezka + настроен updatesUrl).
        // Пустой added = не-rezka или URL-заглушка: строку не показываем, а не врём «неизвестно».
        if (f.added && f.added.length) rows.splice(12, 0, ['Добавлено', NL(f.added)]);
        for (const [k, val] of rows) {
          const tr = document.createElement('tr');
          const a = document.createElement('td'); a.className = 'k'; a.textContent = k;
          const b = document.createElement('td'); b.className = 'v mono'; b.textContent = String(val);
          tr.appendChild(a); tr.appendChild(b); t.appendChild(tr);
        }
        body.appendChild(t);
      });
    }
  } catch (e) {
    $('statusBox').textContent = 'Не удалось опросить вкладку.';
  }
}
function shortUrl(u) {
  try { const x = new URL(u); return x.hostname + x.pathname.slice(0, 40); }
  catch (e) { return String(u || '').slice(0, 60); }
}
document.addEventListener('DOMContentLoaded', init);
