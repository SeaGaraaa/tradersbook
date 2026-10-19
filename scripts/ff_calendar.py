"""Календарь Forex Factory -> calendar.json для вкладки «Новости».

Запускается GitHub Actions раз в час (Forex Factory обновляет выгрузку раз в час и блокирует частые запросы).
Прошлые недели берутся из уже опубликованного calendar.json и хранятся 8 недель.
Если Forex Factory не ответил или прошло меньше 50 минут с прошлой загрузки — публикуется прежний файл.
Аргумент: путь к выходному файлу.
"""
import hashlib
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

FEED = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml"
PUBLISHED = "https://seagaraaa.github.io/tradersbook/calendar.json"
UA = {"User-Agent": "TradersBook calendar (hourly; github.com/SeaGaraaa/tradersbook)"}
KEEP_DAYS = 56


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read()


def parse(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = []
    for e in root.iter("event"):
        f = {k: (e.findtext(k) or "").strip() for k in ("title", "country", "date", "time", "impact", "forecast", "previous", "url")}
        if not f["date"]:
            continue
        day = datetime.strptime(f["date"], "%m-%d-%Y").replace(tzinfo=timezone.utc)
        tm, exact = f["time"], True
        try:
            t = datetime.strptime(tm.lower(), "%I:%M%p")
            when = day.replace(hour=t.hour, minute=t.minute)
        except ValueError:  # All Day, Tentative, Day 1 и т. п.
            when, exact = day, False
        key = f"{f['country']}|{f['title']}|{when.isoformat()}"
        out.append({
            "id": hashlib.sha1(key.encode()).hexdigest()[:12],
            "t": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "exact": exact,
            "label": "" if exact else tm,
            "cur": f["country"],
            "title": f["title"],
            "impact": f["impact"] or "Low",
            "forecast": f["forecast"],
            "previous": f["previous"],
            "url": f["url"],
        })
    if not out and b"Rate Limited" in xml_bytes:
        raise RuntimeError("rate limited")
    return out


def main(path):
    now = datetime.now(timezone.utc)
    old = {"events": [], "fetched": ""}
    try:
        old = json.loads(get(PUBLISHED))
    except Exception as e:  # первый запуск или сайт недоступен
        print("prev:", e)
    fresh, ok = [], False
    last = old.get("fetched")
    if last and now - datetime.fromisoformat(last.replace("Z", "+00:00")) < timedelta(minutes=50):
        print("skip: fetched", last)
    else:
        try:
            fresh = parse(get(FEED))
            ok = bool(fresh)
            print("fetched", len(fresh))
        except Exception as e:
            print("feed:", e)
    events = old.get("events", [])
    if ok:
        week = {e["t"][:10] for e in fresh}
        lo, hi = min(week), max(week)
        # события текущей недели заменяются свежими, прошлые недели остаются
        events = [e for e in events if not (lo <= e["t"][:10] <= hi)] + fresh
    cutoff = (now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    events = sorted((e for e in events if e["t"][:10] >= cutoff), key=lambda e: (e["t"], e["cur"], e["title"]))
    data = {
        "source": "Forex Factory (forexfactory.com)",
        "fetched": now.strftime("%Y-%m-%dT%H:%M:%SZ") if ok else old.get("fetched", ""),
        "events": events,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("events:", len(events), "fetched:", data["fetched"])


if __name__ == "__main__":
    main(sys.argv[1])
