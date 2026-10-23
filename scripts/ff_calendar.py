"""Календарь Forex Factory + факт из TradingView -> calendar.json для вкладки «Новости».

Запускается GitHub Actions каждые 10 минут. Forex Factory загружается не чаще раза в 50 минут
(выгрузка обновляется раз в час, частые запросы блокируются). TradingView — при каждом запуске:
из него берутся фактические значения (actual) и события, которых нет у Forex Factory.
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
TV = "https://economic-calendar.tradingview.com/events"
TV_HEAD = {"Origin": "https://www.tradingview.com", "Referer": "https://www.tradingview.com/",
           "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
TV_COUNTRIES = "US,EU,DE,FR,IT,ES,GB,JP,CA,AU,NZ,CH,CN"
TV_ADJ = {"DE": "German", "FR": "French", "IT": "Italian", "ES": "Spanish"}
TV_IMPACT = {1: "High", 0: "Medium", -1: "Low"}


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


def num(v, unit, scale):
    if v is None:
        return ""
    t = f"{v:.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)
    unit, scale = unit or "", scale or ""
    if unit == "%":
        return t + "%"
    return t + scale  # как у Forex Factory: без знака валюты


MULT = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}


def val(s):
    """'-1349M' -> -1.349e9, '0.4%' -> 0.4; не число -> None."""
    s = (s or "").replace("%", "").replace(",", "").strip()
    m = MULT.get(s[-1:].upper(), 1) if s else 1
    s = s.rstrip("KMBTkmbt")
    s = "".join(ch for ch in s if ch.isdigit() or ch in ".-")
    try:
        return float(s) * m
    except ValueError:
        return None


def close(a, b):
    """Значения из двух источников про одно и то же (допуск на пересмотр)."""
    x, y = val(a), val(b)
    if x is None or y is None:
        return None
    return abs(x - y) <= max(0.15 * max(abs(x), abs(y)), 0.11)


def ts(e):
    return datetime.fromisoformat(e["t"].replace("Z", "+00:00")).timestamp()


def tv_fetch(now):
    a = (now - timedelta(days=8)).strftime("%Y-%m-%dT00:00:00.000Z")
    b = (now + timedelta(days=8)).strftime("%Y-%m-%dT00:00:00.000Z")
    url = f"{TV}?from={a}&to={b}&countries={TV_COUNTRIES}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=TV_HEAD), timeout=30) as r:
        d = json.loads(r.read())
    if d.get("status") != "ok":
        raise RuntimeError("status " + str(d.get("status")))
    out = []
    for e in d.get("result", []):
        if not e.get("date") or not e.get("currency"):
            continue
        adj = TV_ADJ.get(e.get("country"))
        title = e.get("title", "")
        u, s = e.get("unit"), e.get("scale")
        out.append({
            "t": e["date"][:19] + "Z",
            "cur": e["currency"],
            "title": f"{adj} {title}" if adj else title,
            "impact": TV_IMPACT.get(e.get("importance"), "Low"),
            "actual": num(e.get("actual"), u, s),
            "forecast": num(e.get("forecast"), u, s),
            "previous": num(e.get("previous"), u, s),
            "id": "tv" + str(e.get("id")),
            "ticker": e.get("ticker") or "",
        })
        out[-1]["ms"] = ts(out[-1])
    return out


SYN = {"m/m": "mom", "y/y": "yoy", "q/q": "qoq", "w/w": "wow", "q/y": "yoy", "ytd/y": "yoy", "3m/y": "yoy",
       "3mo/yr": "yoy", "ex": "core", "excl": "core", "excl.": "core",
       "flash": "prel", "prelim": "prel", "preliminary": "prel", "non-farm": "nonfarm", "jobless": "claim",
       "cpi": "inflation", "unemployment": "unemp", "rpi": "retail price", "ippi": "ppi", "rmpi": "raw material price",
       "nhpi": "new housing price", "hpi": "house price", "gdt": "dairy", "s.a": "", "sa": "", "nsa": ""}
STOP = {"the", "of", "s", "and", "rate", "index", "change", "&", "-", "final", "growth", "s&p", "global"}
PER = {"mom", "yoy", "qoq"}
XOR = [{"core"}, {"input"}, {"output"}, {"export"}, {"import"}]  # слово есть только в одном названии — разные данные


def toks(title):
    out = set()
    for w in title.lower().replace(",", " ").replace("(", " ").replace(")", " ").split():
        for x in SYN.get(w, w).split():
            if len(x) > 3 and x.endswith("s") and not x.endswith("ss"):
                x = x[:-1]  # prices -> price, sales -> sale
            if x not in STOP:
                out.add(x)
    return out


def eq(a, b):
    x, y = val(a), val(b)
    return x is not None and y is not None and abs(x - y) <= 1e-9 * max(1, abs(x))


def merge_tv(events, tv):
    """Факт TradingView -> события Forex Factory (та же валюта, время ±10 мин, похожее название и цифры).
    События TradingView без пары (у Forex Factory нет события той же валюты в ±10 мин) добавляются как src=tv."""
    lo, hi = min(v["ms"] for v in tv) - 3600, max(v["ms"] for v in tv) + 3600
    events = [e for e in events if not (e.get("src") == "tv" and lo <= ts(e) <= hi)]
    pairs = []
    for i, e in enumerate(events):
        if not e.get("exact"):
            continue
        ms, a = ts(e), toks(e["title"])
        for j, v in enumerate(tv):
            if v["cur"] != e["cur"] or abs(v["ms"] - ms) > 600:
                continue
            b = toks(v["title"])
            score = len(a & b) / max(1, len(a | b))
            if score < 0.15:
                continue
            if (a & PER) and (b & PER) and not (a & b & PER):
                score -= 0.5  # м/м против г/г — разные цифры
            if any(bool(a & x) != bool(b & x) for x in XOR):
                score -= 0.5
            # другой ряд данных (SA/NSA, кв/год): ни прошлое значение, ни прогноз не похожи
            checks = [c for c in (close(e.get("previous"), v["previous"]), close(e.get("forecast"), v["forecast"])) if c is not None]
            if checks and not any(checks):
                continue
            score += 0.15 * eq(e.get("previous"), v["previous"]) + 0.15 * eq(e.get("forecast"), v["forecast"])
            score -= abs(v["ms"] - ms) / 6000  # ближе по времени — лучше
            if score >= 0.25:
                pairs.append((score, i, j))
    used_e, used_v = set(), set()
    for _, i, j in sorted(pairs, reverse=True):
        if i in used_e or j in used_v:
            continue
        used_e.add(i)
        used_v.add(j)
        e, v = events[i], tv[j]
        if v["actual"]:
            e["actual"] = v["actual"]
        for k in ("forecast", "previous"):
            if not e.get(k) and v[k]:
                e[k] = v[k]
    ff = [(e["cur"], ts(e)) for e in events if e.get("src") != "tv"]
    added = 0
    for j, v in enumerate(tv):
        if j in used_v or any(c == v["cur"] and abs(t - v["ms"]) <= 600 for c, t in ff):
            continue
        url = ("https://www.tradingview.com/symbols/" + v["ticker"].replace(":", "-") + "/") if v["ticker"] \
            else "https://www.tradingview.com/economic-calendar/"
        events.append({"id": v["id"], "t": v["t"], "exact": True, "label": "", "cur": v["cur"], "title": v["title"],
                       "impact": v["impact"], "forecast": v["forecast"], "previous": v["previous"],
                       "actual": v["actual"], "url": url, "src": "tv"})
        added += 1
    print("tradingview matched:", len(used_v), "added:", added)
    return events


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
    tv_ok = False
    try:
        tv = tv_fetch(now)
        print("tradingview:", len(tv))
        if tv:
            events = merge_tv(events, tv)
            tv_ok = True
    except Exception as e:  # TradingView недоступен — остаётся прежний факт
        print("tradingview:", e)
    cutoff = (now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    events = sorted((e for e in events if e["t"][:10] >= cutoff), key=lambda e: (e["t"], e["cur"], e["title"]))
    data = {
        "source": "Forex Factory (forexfactory.com) + TradingView",
        "fetched": now.strftime("%Y-%m-%dT%H:%M:%SZ") if ok else old.get("fetched", ""),
        "tvFetched": now.strftime("%Y-%m-%dT%H:%M:%SZ") if tv_ok else old.get("tvFetched", ""),
        "events": events,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("events:", len(events), "fetched:", data["fetched"])


if __name__ == "__main__":
    main(sys.argv[1])
