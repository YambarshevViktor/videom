#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборщик истории обновлений rezka для будущей строки «Добавлено» в Инфо.

Что делает:
  - качает главную (live) или снапшоты главной из веб-архива (backfill);
  - ищет блоки «Горячие обновления сериалов и фильмов»: дата + тайтл +
    сезон/серия + озвучка (как есть);
  - дописывает новые записи в data/updates.json с дедупом по (key + date).

Ключ записи (как договорились):
  - сериалы/мульт/аниме/шоу:  "<id>:s<season>e<episode>:<voice_norm>"
  - фильмы (без сезона/серии): "<id>:m:<voice_norm>"
  - «Завершён» — строкой уровня тайтла: "<id>:done:<voice_norm>"
  - перезаливы — отдельными записями (тот же key, но другая date + reupload=true;
    дедуп по key+date их не склеивает).

Только стандартная библиотека (urllib + html + regex) — на раннере ничего
ставить не надо.

Примеры:
  # ежедневный прогон (для cron):
  python scripts/collect_updates.py --mode live --out data/updates.json

  # проверить один день (напр. 15 июня 2010) — бэкфилл за этот день:
  python scripts/collect_updates.py --mode day --date 2010-06-15 --out data/updates.json --dry-run
  python scripts/collect_updates.py --mode day --date 2010-06-15 --out data/updates.json

  # диапазон (напр. с 1 янв 2010 по 1 янв 2011):
  python scripts/collect_updates.py --mode range --from 2010-01-01 --to 2011-01-01 --out data/updates.json --dry-run

  # разобрать сохранённый html без сети:
  python scripts/collect_updates.py --mode parse-file --input /tmp/rezka.html --seen-at 2024-11-01 --out data/updates.json --dry-run

  # разовый live-парсинг в stdout (посмотреть что нашлось, ничего не пишет):
  python scripts/collect_updates.py --mode live --dry-run --dump 20
"""
import argparse
import datetime as dt
import html as ihtml
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

BASE_URL = "https://rezka.ag/"
MIRRORS = ["https://rezka.ag/", "https://hdrezka.ag/", "https://rezka-ua.tv/"]
WAYBACK_CDX = "http://web.archive.org/cdx/search/cdx"
UA = {"User-Agent": "Mozilla/5.0 (VideoManager-updates-collector; +https://github.com/)"}

MONTHS = {
    "января": 1, "январь": 1, "янв": 1,
    "февраля": 2, "февраль": 2, "фев": 2,
    "марта": 3, "март": 3, "мар": 3,
    "апреля": 4, "апрель": 4, "апр": 4,
    "мая": 5, "май": 5,
    "июня": 6, "июнь": 6, "июн": 6,
    "июля": 7, "июль": 7, "июл": 7,
    "августа": 8, "август": 8, "авг": 8,
    "сентября": 9, "сентябрь": 9, "сен": 9, "сент": 9,
    "октября": 10, "октябрь": 10, "окт": 10,
    "ноября": 11, "ноябрь": 11, "ноя": 11, "нояб": 11,
    "декабря": 12, "декабрь": 12, "дек": 12,
}

# ---------- сеть ----------

def fetch_text(url, timeout=40, post_data=None):
    req = urllib.request.Request(url, data=post_data, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    # charset из meta или utf-8
    enc = "utf-8"
    try:
        head = raw[:4000].decode("latin-1", "ignore")
        m = re.search(r'charset=["\']?([\w-]+)', head, re.I)
        if m:
            enc = m.group(1)
    except Exception:
        pass
    try:
        return raw.decode(enc, "replace")
    except Exception:
        return raw.decode("utf-8", "replace")


def fetch_home_live():
    last_err = None
    for u in MIRRORS:
        try:
            return fetch_text(u), u
        except Exception as e:
            last_err = e
    raise RuntimeError("не скачалась главная ни с одного зеркала: %s" % last_err)


def wayback_snapshots(day_from, day_to, limit=400):
    """Список снапшотов главной за период. ~1 в неделю, окно каждого ~3 дня."""
    q = {
        "url": "rezka.ag/",
        "from": day_from.strftime("%Y%m%d"),
        "to": day_to.strftime("%Y%m%d"),
        "output": "json",
        "filter": "statuscode:200",
        "filter2": "mimetype:text/html",
        "collapse": "timestamp:8",  # один в день максимум, дальше проредим до ~1/нед
        "limit": str(limit),
    }
    url = WAYBACK_CDX + "?" + urllib.parse.urlencode(q)
    try:
        txt = fetch_text(url, timeout=60)
        rows = json.loads(txt)
    except Exception as e:
        print("CDX недоступен: %s" % e, file=sys.stderr)
        return []
    out = []
    for r in rows[1:]:
        try:
            ts = r[1]
            snap = dt.datetime.strptime(ts, "%Y%m%d%H%M%S")
            out.append(snap)
        except Exception:
            continue
    # прореживаем до ~1 в неделю (окно снапшота ~3 дня — чаще бессмысленно)
    out.sort()
    thinned = []
    last = None
    for s in out:
        if last is None or (s - last).days >= 6:
            thinned.append(s)
            last = s
    return thinned


def fetch_snapshot(snap):
    ts = snap.strftime("%Y%m%d%H%M%S")
    url = "https://web.archive.org/web/%sid_/https://rezka.ag/" % ts
    return fetch_text(url), url

# ---------- парсинг ----------

ANCHOR_RE = re.compile(
    r'<a\b[^>]*href=["\']([^"\']*/(\d+)-[^"\']*\.html)["\'][^>]*>(.*?)</a>',
    re.I | re.S,
)
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")

# заголовки дат на главной: «Сегодня, 1 ноября», «Вчера, 31 октября», «12 октября 2024», «01.11.2024»
DATE_HDR_RE = re.compile(
    r"(сегодня|вчера)\s*,?\s*(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?|"
    r"(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?|"
    r"(\d{1,2})[./](\d{1,2})[./](\d{2,4})",
    re.I,
)
HOT_RE = re.compile(r"горяч\w*\s+обновлен", re.I)

SEASON_EP_RE = re.compile(r"(\d{1,3})\s*сезон[а-я]*\s*,?\s*(\d{1,4})\s*сери[яию]", re.I)
SEASON_ONLY_RE = re.compile(r"(\d{1,3})\s*сезон", re.I)
EP_ONLY_RE = re.compile(r"(\d{1,4})\s*сери[яию]", re.I)
SXXEXX_RE = re.compile(r"[Ss](\d{1,3})\s*[EЕe](\d{1,4})")
VOICE_GROUPS_RE = re.compile(r"\(([^()]{2,80})\)")  # кандидаты на озвучку; год/качество отсекаем ниже
YEAR_PAREN_RE = re.compile(r"^(19|20)\d{2}$")
QUALITY_PAREN_RE = re.compile(r"^\d{3,4}\s*[pр]$|^(hd|full\s*hd|4k|ultra)$", re.I)
REUPLOAD_RE = re.compile(r"перезалив|перезалит|переозвуч|обновлён|обновлен|замен[а-я]*\s+верси|новой\s+озвуч", re.I)
DONE_RE = re.compile(r"заверш[ёе]н|финал|последн\w*\s+сери|все\s+серии|целиком", re.I)
# голые «Сегодня»/«Вчера» без даты (тогда дата = seen_at / seen_at-1)
BARE_TODAY_RE = re.compile(r"^\W*(сегодня)\W*$", re.I)
BARE_YESTERDAY_RE = re.compile(r"^\W*(вчера)\W*$", re.I)


def clean_text(s):
    s = TAG_RE.sub(" ", s or "")
    s = ihtml.unescape(s)
    return WS_RE.sub(" ", s).strip(" \t\n\r-|–—•")


def norm_voice(v):
    v = (v or "").strip().lower()
    v = v.replace("ё", "е")
    v = WS_RE.sub(" ", v)
    return v


def parse_ru_date(text, seen_at):
    """Текстовую дату -> date. Без года — год от seen_at (с поправкой на декабрь/январь).

    Важно: «Вчера, 31 октября» — это уже готовая дата (31 октября), вычитать
    ещё день НЕ надо. «Вчера» без даты = seen_at - 1, «Сегодня» без даты = seen_at.
    """
    text = text or ""
    if BARE_YESTERDAY_RE.search(text):
        return seen_at - dt.timedelta(days=1)
    if BARE_TODAY_RE.search(text):
        return seen_at
    m = DATE_HDR_RE.search(text)
    if not m:
        return None
    try:
        if m.group(9):  # 01.11.2024
            d, mo, y = int(m.group(9)), int(m.group(10)), int(m.group(11))
            if y < 100:
                y += 2000
            return dt.date(y, mo, d)
        if m.group(1):  # «Сегодня/Вчера, 1 ноября» — дата уже явная, как есть
            d = int(m.group(2))
            mo = MONTHS.get(m.group(3).lower(), 0)
            if not mo:
                return None
            y = int(m.group(4)) if m.group(4) else seen_at.year
            return dt.date(y, mo, d)
        if m.group(5):
            d = int(m.group(5))
            mo = MONTHS.get(m.group(6).lower(), 0)
            if not mo:
                return None
            y = int(m.group(7)) if m.group(7) else seen_at.year
            # «31 декабря» на снапшоте 2 января — это прошлый год
            if not m.group(7) and mo == 12 and seen_at.month == 1:
                y -= 1
            if not m.group(7) and mo == 1 and seen_at.month == 12:
                y += 1
            return dt.date(y, mo, d)
    except ValueError:
        return None
    return None


def pick_voice(title, tail):
    """Озвучка как есть: последний блок в скобках, год (2024) и качество (1080p) — не озвучка."""
    cands = []
    for src in (title, tail):
        for g in VOICE_GROUPS_RE.finditer(src or ""):
            v = g.group(1).strip()
            if YEAR_PAREN_RE.match(v):
                continue
            if QUALITY_PAREN_RE.match(v):
                continue
            if len(v) < 2:
                continue
            cands.append(v)
    if not cands:
        return ""
    # берём последний не-годовой (в хвосте после серии обычно и сидит озвучка)
    return cands[-1][:80]


def parse_updates(html_text, seen_at, source_url=""):
    """Возвращает список записей. seen_at — дата снапшота/скачивания (окно ~3 дня)."""
    if isinstance(seen_at, dt.datetime):
        seen_at = seen_at.date()
    # позиции всех заголовков дат
    date_marks = []  # (pos, date)
    for m in DATE_HDR_RE.finditer(html_text):
        # берём контекст вокруг: заголовок обычно «Сегодня, 1 ноября» целиком
        ctx = html_text[max(0, m.start() - 40):m.end() + 10]
        d = parse_ru_date(ctx, seen_at)
        if d:
            date_marks.append((m.start(), d))
    date_marks.sort()

    # есть ли вообще блок «горячих» — если нет, парсим всю страницу, но помечаем
    has_hot = bool(HOT_RE.search(html_text or ""))

    records = []
    for m in ANCHOR_RE.finditer(html_text or ""):
        href, post_id, inner = m.group(1), m.group(2), m.group(3)
        title = clean_text(inner)
        if not title or len(title) < 2:
            continue
        # мусорные ссылки (пагинация, «все сериалы») отсекаем по URL-типу
        path = urllib.parse.urlparse(href).path.lower()
        if not any(k in path for k in ("/series", "/films", "/film", "/cartoon", "/anime", "/show", "/doc")):
            # на главной обновления — это почти всегда /series/... или /films/...
            # остальное пропускаем, чтобы не тащить меню
            continue
        try:
            pid = int(post_id)
        except ValueError:
            continue
        # дата = ближайший заголовок выше ссылки, иначе seen_at
        date = seen_at
        for pos, d in date_marks:
            if pos <= m.start():
                date = d
            else:
                break
        # Узкий хвост: серия/озвучка/флаги живут в той же строке, что и ссылка.
        # Режем хвост по следующей ссылке/блочной границе — иначе в окно
        # добивают серия и озвучка СОСЕДНЕЙ записи (поймано тестом на фикстуре).
        raw_tail = html_text[m.end():m.end() + 500]
        cut = len(raw_tail)
        low_tail = raw_tail.lower()
        for pat in ("<a", "</div", "<div", "</li", "<li", "</tr", "<tr", "<h2", "<h3"):
            i = low_tail.find(pat)
            if i != -1:
                cut = min(cut, i)
        tail = clean_text(raw_tail[:cut])
        probe = title + " | " + tail

        season, episode = 0, 0
        ms = SEASON_EP_RE.search(probe)
        if ms:
            season, episode = int(ms.group(1)), int(ms.group(2))
        else:
            mx = SXXEXX_RE.search(probe)
            if mx:
                season, episode = int(mx.group(1)), int(mx.group(2))
            else:
                me = EP_ONLY_RE.search(probe)
                if me:
                    episode = int(me.group(1))
                    mso = SEASON_ONLY_RE.search(probe)
                    if mso:
                        season = int(mso.group(1))
        voice = pick_voice(title, tail)
        # тип по URL
        if "/series" in path or "/show" in path or "/anime" in path or "/cartoon" in path:
            typ = "series"
        elif "/film" in path:
            typ = "film"
        else:
            typ = "series" if (season or episode) else "film"
        reupload = bool(REUPLOAD_RE.search(probe))
        done = bool(DONE_RE.search(probe)) and typ == "series" and not episode
        vnorm = norm_voice(voice.split(",")[0] if voice else "")
        if typ == "film":
            season, episode = 0, 0  # у фильмов сезона/серии нет — чистим хвосты
            key = "%d:m:%s" % (pid, vnorm or "-")
        elif not season and not episode and not done:
            key = "%d:m:%s" % (pid, vnorm or "-")
        elif done:
            key = "%d:done:%s" % (pid, vnorm or "-")
        else:
            key = "%d:s%de%d:%s" % (pid, season, episode, vnorm or "-")

        # что ещё вытащили (предложение по «если что-то важно»):
        # title/url/type/year как есть + flags; quality intentional НЕ тащим (скачет),
        # рейтинг НЕ тащим (меняется и врёт в истории).
        year = 0
        my = re.search(r"\((19|20)\d{2}\)", probe)
        if my:
            try:
                year = int(my.group(0).strip("()"))
            except ValueError:
                year = 0
        records.append({
            "key": key,
            "id": pid,
            "type": typ,
            "title": title[:160],
            "url": href if href.startswith("http") else urllib.parse.urljoin(BASE_URL, href),
            "season": season,
            "episode": episode,
            "voice": voice[:80],
            "voice_norm": vnorm[:80],
            "date": date.isoformat(),
            "seen_at": seen_at.isoformat(),
            "source": source_url[:160],
            "reupload": reupload,
            "completed": done,
            "has_hot_block": has_hot,
            "year": year,
        })
    # дедуп внутри одного прогона
    uniq = {}
    for r in records:
        # перезалив в тот же день — отдельная строка, а не дубль
        uniq[(r["key"], r["date"], r["reupload"])] = r
    return sorted(uniq.values(), key=lambda r: (r["date"], r["key"]))


# ---------- json-хранилище ----------

def load_db(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            db = json.load(f)
        db.setdefault("meta", {})
        db.setdefault("records", [])
        return db
    return {"meta": {"version": 1}, "records": []}


def merge_db(db, new_records):
    have = {(r.get("key"), r.get("date"), r.get("reupload", False)) for r in db.get("records", [])}
    added = 0
    for r in new_records:
        if (r["key"], r["date"], r.get("reupload", False)) not in have:
            db["records"].append(r)
            have.add((r["key"], r["date"], r.get("reupload", False)))
            added += 1
    db["records"].sort(key=lambda r: (r.get("date", ""), r.get("key", "")))
    db["meta"] = dict(db.get("meta", {}), **{
        "version": 1,
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "count": len(db["records"]),
    })
    return added


# ---------- режимы ----------

def run_live(out, dry_run, dump):
    html_text, url = fetch_home_live()
    seen = dt.datetime.now().date()
    recs = parse_updates(html_text, seen, url)
    return [("live:%s" % url, html_text, recs)]


def run_day(day, out, dry_run):
    snaps = wayback_snapshots(day, day)
    if not snaps:
        # запасной вариант: окно ±3 дня (снапшота ровно в этот день может не быть)
        snaps = wayback_snapshots(day - dt.timedelta(days=3), day + dt.timedelta(days=3))
        snaps = [s for s in snaps if abs((s.date() - day).days) <= 3][:1]
    bundles = []
    for s in snaps:
        try:
            html_text, url = fetch_snapshot(s)
            recs = parse_updates(html_text, s.date(), url)
            bundles.append((url, html_text, recs))
        except Exception as e:
            print("снапшот %s не скачался: %s" % (s, e), file=sys.stderr)
    return bundles


def run_range(day_from, day_to, out, dry_run):
    snaps = wayback_snapshots(day_from, day_to)
    print("снапшотов в диапазоне: %d" % len(snaps))
    bundles = []
    for s in snaps:
        try:
            html_text, url = fetch_snapshot(s)
            recs = parse_updates(html_text, s.date(), url)
            bundles.append((url, html_text, recs))
            time.sleep(1)
        except Exception as e:
            print("снапшот %s не скачался: %s" % (s, e), file=sys.stderr)
    return bundles


def main():
    ap = argparse.ArgumentParser(description="Сборщик updates.json")
    ap.add_argument("--mode", default="live",
                    choices=["live", "day", "range", "backfill", "parse-file"],
                    help="live — скачать главную сейчас; day — один день из архива; "
                         "range/backfill — диапазон дат из архива; parse-file — локальный html")
    ap.add_argument("--date", default="", help="день для --mode day (YYYY-MM-DD)")
    ap.add_argument("--from", dest="date_from", default="", help="начало диапазона (YYYY-MM-DD)")
    ap.add_argument("--to", dest="date_to", default="", help="конец диапазона (YYYY-MM-DD)")
    ap.add_argument("--input", default="", help="html-файл для --mode parse-file")
    ap.add_argument("--seen-at", default="", help="дата снапшота для parse-file (YYYY-MM-DD)")
    ap.add_argument("--out", default="data/updates.json")
    ap.add_argument("--dry-run", action="store_true", help="ничего не писать, только показать")
    ap.add_argument("--dump", type=int, default=0, help="показать первые N записей в stdout")
    args = ap.parse_args()

    today = dt.datetime.now().date()
    bundles = []
    if args.mode == "live":
        bundles = run_live(args.out, args.dry_run, args.dump)
    elif args.mode == "day":
        if not args.date:
            print("--date обязателен для mode=day", file=sys.stderr)
            return 2
        day = dt.datetime.strptime(args.date, "%Y-%m-%d").date()
        bundles = run_day(day, args.out, args.dry_run)
    elif args.mode in ("range", "backfill"):
        if not args.date_from or not args.date_to:
            print("--from и --to обязательны для range", file=sys.stderr)
            return 2
        df = dt.datetime.strptime(args.date_from, "%Y-%m-%d").date()
        dto = dt.datetime.strptime(args.date_to, "%Y-%m-%d").date()
        if dto < df:
            print("--to раньше --from", file=sys.stderr)
            return 2
        if (dto - df).days > 370 and not os.environ.get("ALLOW_BIG_RANGE"):
            print("диапазон больше года: разбейте на части или задайте ALLOW_BIG_RANGE=1", file=sys.stderr)
            return 2
        bundles = run_range(df, dto, args.out, args.dry_run)
    elif args.mode == "parse-file":
        with open(args.input, "r", encoding="utf-8") as f:
            html_text = f.read()
        seen = dt.datetime.strptime(args.seen_at or today.isoformat(), "%Y-%m-%d").date()
        bundles = [("file:%s" % args.input, html_text, parse_updates(html_text, seen, args.input))]

    total = sum(len(b[2]) for b in bundles)
    print("источников: %d, записей спарсено: %d" % (len(bundles), total))
    if args.dump:
        n = 0
        for url, _, recs in bundles:
            for r in recs:
                print(json.dumps(r, ensure_ascii=False))
                n += 1
                if n >= args.dump:
                    break
            if n >= args.dump:
                break
    if args.dry_run:
        print("dry-run: файл не меняем")
        return 0
    db = load_db(args.out)
    added = 0
    for _, _, recs in bundles:
        added += merge_db(db, recs)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    print("новых записей дописано: %d, всего: %d -> %s" % (added, len(db["records"]), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
