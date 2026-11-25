/*
 * LrcRed Lyrics 0.2.5 — dual-engine getLyrics-only plugin for Lyrico API 5.
 *
 * Engine A: Apple Music TTML
 *   Apple Music ID discovery via iTunes Search (storefront order by language),
 *   then TTML fetched from AMLL TTML DB mirrors.
 * Engine B: lrc.red (ISRC -> /match.json -> /search.json), carried over from 0.1.1.
 *
 * Matching / gating behaviour adapted from music-tag-lyrics v1.8.5
 * (core/fetchers/apple_ttml.py, core/fetchers/lrc_red.py).
 *
 * Data providers: https://lrc.red and the AMLL TTML DB community mirrors.
 * Apple Music is a trademark of Apple Inc. This plugin is unofficial.
 *
 * QuickJS: no require(), fetch(), timers, filesystem, or Node APIs.
 */
var LR_PLUGIN_TAG = "LrcRedLyrics";
var LR_VERSION = "0.2.5";
var LR_BASE = "https://lrc.red";
var LR_IT_BASE = "https://itunes.apple.com";
var LR_APP_URL = "https://github.com/sxsxhhi/music-tag-lyrics";

/* ---- budgets ---------------------------------------------------------- */
var LR_TOTAL_BUDGET_MS = 18000;
var LR_APPLE_MAX_MS = 11000;
var LR_LRC_RESERVE_MS = 5000;
var LR_LRC_SECOND_MS = 5000;
var LR_MAX_REQUESTS = 14;
var LR_REGION_GAP_MS = 1800;
var LR_MIRROR_GAP_MS = 1500;

/* ---- size / cache ----------------------------------------------------- */
var LR_JSON_LIMIT = 1048576;
var LR_TTML_LIMIT = 2097152;
var LR_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/* Cooldown policy. Only the iTunes tier escalates: a single 429 there means the
 * whole Apple path is blocked, so recover fast at first and back off hard if it
 * keeps happening. lrc.red and the mirrors keep the flat 90s. */
var LR_CD_IT_TIERS = [30000, 60000, 120000, 300000];
var LR_CD_IT_DECAY_MS = 600000;
var LR_CD_FLAT_MS = 90000;
var LR_CD_503_MS = 30000;
var LR_CD_CAP_MS = 300000;
var LR_CACHE_NS = "lrcred.v02.";

/* ---- Apple / preview gates -------------------------------------------- */
var LR_PREVIEW_MIN_TRACK_MS = 90000;
var LR_PREVIEW_MAX_LAST_END_MS = 45000;
var LR_OVERRUN_TOLERANCE_MS = 8000;
var LR_AXIS_FLOOR = 0.5;

var LR_ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
var LR_CONTACT_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
var LR_APPLE_ID_RE = /^\d{1,16}$/;

/* Storefront order: first region that yields a qualified hit wins. */
var LR_REGIONS_ZH = ["hk", "tw", "us", "jp"];
var LR_REGIONS_FOREIGN = ["us", "jp", "hk", "tw"];

/* Distinct origins on purpose: two mirrors behind the same CDN fail together. */
var LR_MIRRORS = [
  { name: "gbclstudio", base: "https://amll-ttml-db.gbclstudio.cn", origin: "gbcl" },
  { name: "testingcf", base: "https://testingcf.jsdelivr.net/gh/amll-dev/amll-ttml-db@main", origin: "jsdelivr" },
  { name: "bikonoo", base: "https://amlldb.bikonoo.com", origin: "bikonoo" }
];
var LR_MAX_MIRRORS = 3;

/* ---- version vocabulary ----------------------------------------------- */
/* Tag vocabulary. Hard tokens reject the candidate; soft tokens are recorded
 * but never reject (a remaster keeps the same words, so lyrics still fit). */
var LR_VER_DEFS = [
  ["live", /\blive\b|\u73b0\u573a\u7248|\u6f14\u5531\u4f1a|\u73b0\u573a\u5f55\u97f3/],
  ["remix", /\bremix\b|\u6df7\u97f3\u7248|\u91cd\u6df7/],
  ["acoustic", /\bacoustic\b|\u4e0d\u63d2\u7535/],
  ["instrumental", /\binstrumental\b|\u4f34\u594f\u7248|\u7eaf\u97f3\u4e50/],
  ["karaoke", /\bkaraoke\b|\u5361\u62c9ok/],
  ["cover", /\bcover\b|\u7ffb\u5531\u7248/],
  ["demo", /\bdemo\b|\u5c0f\u6837\u7248/],
  ["remaster", /\bremaster(?:ed)?\b|\u91cd\u5236\u7248/],
  ["radio_edit", /\bradio\s+edit\b/],
  ["extended", /\bextended\b|\u52a0\u957f\u7248/],
  ["sped_up", /\bsped[ -]?up\b|\u52a0\u901f\u7248/],
  ["slowed", /\bslowed\b|\u6162\u901f\u7248/],
  ["taylor_version", /taylor.?s\s+version/],
  ["nightcore", /\bnightcore\b/],
  ["deluxe", /\bdeluxe\b|\u8c6a\u534e\u7248/],
  ["mono", /\bmono\b/]
];

var LR_VER_HARD = [
  "live", "remix", "acoustic", "instrumental", "karaoke",
  "cover", "demo", "nightcore", "sped_up", "slowed"
];

/* ---- small helpers ---------------------------------------------------- */
function lrString(value) {
  return value === undefined || value === null ? "" : String(value);
}
function lrLog(level, text) {
  try {
    if (typeof Platform !== "undefined" && Platform.log && typeof Platform.log[level] === "function") {
      Platform.log[level](LR_PLUGIN_TAG, lrString(text));
    }
  } catch (_) { /* diagnostics are optional */ }
}
function lrConfig(req, key, fallback) {
  var o = req && req.config;
  return o && Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined && o[key] !== null
    ? o[key] : fallback;
}
function lrContact(req) {
  var mail = lrString(lrConfig(req, "contact_email", "")).trim();
  return mail.length > 0 && mail.length <= 254 && LR_CONTACT_RE.test(mail) ? mail : "";
}
function lrCacheGet(key) {
  try { return Platform.cache && Platform.cache.get ? lrString(Platform.cache.get(LR_CACHE_NS + key)) : ""; }
  catch (_) { return ""; }
}
function lrCacheSet(key, value, ttlMs) {
  try { if (Platform.cache && Platform.cache.set) Platform.cache.set(LR_CACHE_NS + key, lrString(value), ttlMs); }
  catch (_) { /* cache must never interrupt lyrics lookup */ }
}
function lrNow() { return Date.now(); }
/* Host cache TTL units are undocumented. Cooldowns therefore carry an absolute
 * expiry inside the value: even if the host treats the ttl argument as seconds,
 * the entry still expires when we say it does. */
/* Cooldown entries store "<step>:<untilTs>:<lastTs>". A bare number is still
 * accepted so an older cached value keeps working. */
function lrCooldownState(key) {
  var raw = lrCacheGet(key);
  if (!raw) return { n: 0, until: 0, last: 0 };
  var parts = raw.split(":");
  if (parts.length >= 3) {
    return { n: Number(parts[0]) || 0, until: Number(parts[1]) || 0, last: Number(parts[2]) || 0 };
  }
  return { n: 0, until: Number(parts[0]) || 0, last: 0 };
}
function lrCooldownActive(key) {
  return lrCooldownState(key).until > lrNow();
}
function lrValidProbe(p) {
  return !!p && p.ok === true &&
    typeof p.origLines === "number" && p.origLines >= 1 &&
    typeof p.timedLines === "number" && p.timedLines >= 1 &&
    typeof p.lastEnd === "number";
}
/* Lyrico stores switches as "true"/"false" strings, but a boolean must not turn
 * a disabled feature back on. */
function lrBool(value, fallback) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

/* Unicode property escapes are not guaranteed on every QuickJS build.
 * Degrade to an explicit range that still covers CJK, kana and hangul. */
function lrRe(pattern, flags) {
  try { return new RegExp(pattern, flags); } catch (_) { /* retry below */ }
  try {
    return new RegExp(
      pattern.replace(/\\p\{L\}/g, "A-Za-z\\u00C0-\\uFFFF").replace(/\\p\{N\}/g, "0-9"),
      flags.replace(/u/g, "")
    );
  } catch (_) { return null; }
}
var LR_RE_ALNUM = lrRe("[^\\p{L}\\p{N}]+", "gu");
var LR_RE_FALLBACK = /[^0-9A-Za-z\u00C0-\uFFFF]+/g;
function lrStripAlnum(text) {
  var s = lrString(text);
  return s.replace(LR_RE_ALNUM || LR_RE_FALLBACK, "");
}

/* ---- normalisation / matching ----------------------------------------- */
function lrIsrc(raw) {
  var s = lrString(raw).replace(/[\s\-]/g, "").toUpperCase();
  return LR_ISRC_RE.test(s) ? s : "";
}
function lrNorm(text) {
  var s = lrString(text);
  try { s = s.normalize("NFKC"); } catch (_) {}
  s = s.toLowerCase().replace(/[\u200b-\u200f\ufeff]/g, "");
  try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (_) {}
  return s;
}
function lrVersionTags(text) {
  var s = lrNorm(text);
  var out = [];
  for (var i = 0; i < LR_VER_DEFS.length; i++) {
    if (LR_VER_DEFS[i][1].test(s) && out.indexOf(LR_VER_DEFS[i][0]) < 0) out.push(LR_VER_DEFS[i][0]);
  }
  return out;
}
function lrVerDiff(a, b) {
  var out = [];
  var i;
  for (i = 0; i < a.length; i++) if (b.indexOf(a[i]) < 0 && out.indexOf(a[i]) < 0) out.push(a[i]);
  for (i = 0; i < b.length; i++) if (a.indexOf(b[i]) < 0 && out.indexOf(b[i]) < 0) out.push(b[i]);
  return out;
}
/* Three-state version arbitration, mirroring music-tag-lyrics
 * _assess_version_evidence(): conflict rejects, unknown keeps the candidate
 * (album-side evidence is unavailable), consistent is a clean match. */
function lrAssessVersion(localTitle, localAlbum, candTitle, candAlbum) {
  var l = lrVersionTags(localTitle).concat(lrVersionTags(localAlbum));
  var c = lrVersionTags(candTitle).concat(lrVersionTags(candAlbum));
  var diff = lrVerDiff(l, c);
  for (var i = 0; i < diff.length; i++) {
    if (LR_VER_HARD.indexOf(diff[i]) >= 0) return "conflict";
  }
  if (lrString(localAlbum).trim() && !lrString(candAlbum).trim()) return "unknown";
  return "consistent";
}
var LR_RE_FEAT = /\b(?:feat(?:uring)?|ft)\.?\s+[^()\[\]\uff0c,]+/g;
var LR_RE_VER_BRACKET = /[（(\[【][^）)\]】]*(?:live|remix|acoustic|instrumental|karaoke|cover|demo|remaster|radio\s+edit|extended|sped.up|slowed|taylor|nightcore|deluxe|mono|explicit|clean|\bver\b|\u73b0\u573a\u7248|\u6df7\u97f3\u7248|\u91cd\u5236\u7248|\u8c6a\u534e\u7248)[^）)\]】]*[）)\]】]/g;
var LR_RE_ANY_BRACKET = /[（(\[【][^）)\]】]*[）)\]】]/g;
var LR_RE_SUFFIX = /\s*[-\u2013\u2014]\s*(?:single|ep|album|digital single|bonus track)\b.*$/i;

function lrTitleCore(text) {
  var s = lrNorm(text);
  s = s.replace(LR_RE_FEAT, "");
  s = s.replace(LR_RE_VER_BRACKET, "");
  return lrStripAlnum(s);
}
/* Phones tag "Title(中文名)" or "Title - Single" all the time. Compare every
 * plausible reading of the title instead of one, so an annotation on either
 * side cannot hide an otherwise identical track. */
function lrTitleVariants(text) {
  var s = lrNorm(text).replace(LR_RE_FEAT, "").replace(LR_RE_SUFFIX, "");
  var out = [];
  function add(v) { var c = lrStripAlnum(v); if (c && out.indexOf(c) < 0) out.push(c); }
  add(s.replace(LR_RE_VER_BRACKET, ""));
  add(s.replace(LR_RE_ANY_BRACKET, " "));
  return out;
}
function lrTitleMatch(a, b) {
  var va = lrTitleVariants(a), vb = lrTitleVariants(b);
  if (!va.length || !vb.length) return false;
  for (var i = 0; i < va.length; i++) {
    if (vb.indexOf(va[i]) >= 0) return true;
  }
  return false;
}
function lrArtistSet(value) {
  var s = lrNorm(value).replace(/\b(?:feat(?:uring)?|ft|with|vs)\.?\s+/g, "/");
  s = s.replace(/\s+[x\u00d7]\s+/g, "/");
  var parts = s.split(/\s+&\s+|\s+and\s+|\s*[,\uff0c\u3001;\uff1b\/|+]\s*/);
  var result = [];
  for (var i = 0; i < parts.length; i++) {
    var p = lrStripAlnum(parts[i]);
    if (p && result.indexOf(p) < 0) result.push(p);
  }
  return result;
}
function lrArtistCompatible(local, remote) {
  var a = lrArtistSet(local), b = lrArtistSet(remote);
  if (!a.length || !b.length) return false;
  for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) return true;
  return false;
}
function lrAlbumCore(text) {
  return lrStripAlnum(text);
}
function lrIsForeign(text) {
  var s = lrString(text);
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(s)) return true;
  return !/[\u4e00-\u9fff]/.test(s);
}

function lrSongContext(request) {
  var song = (request && request.song) || {};
  var f = song.fields || {};
  var title = lrString(song.title || f.title).trim();
  var artist = lrString(song.artist || f.artist).trim();
  /* Tags that only carry "Title - Artist" in one field are common on phones.
   * Split it so the artist gate has something to compare against. */
  if (!artist && title) {
    var parts = title.split(/\s+[-\u2013\u2014\uff0d]\s+/);
    if (parts.length >= 2) {
      var head = parts[0].trim();
      var tail = parts.slice(1).join(" - ").trim();
      if (head && tail && tail.length <= 60) { title = head; artist = tail; }
    }
  }
  var album = lrString(song.album || f.album).trim();
  var date = lrString(song.date || f.date).trim();
  var duration = Number(song.duration || song.durationMs || f.duration || 0);
  /* Host builds were never confirmed on this field's unit. A real track is
   * always longer than 3.6s, so anything below 3600 must be seconds. */
  if (isFinite(duration) && duration > 0 && duration < 3600) duration = duration * 1000;
  if (!isFinite(duration) || duration < 0 || duration > 86400000) duration = 0;
  var isrc = lrIsrc(song.isrc || f.isrc || "");
  return { title: title, artist: artist, album: album, date: date, duration: duration, isrc: isrc };
}

/* ---- HTTP ------------------------------------------------------------- */
function lrGet(state, url, maxChars, cfg) {
  cfg = cfg || {};
  var now = lrNow();
  var limit = cfg.deadline ? Math.min(state.deadline, cfg.deadline) : state.deadline;
  var budget = limit - now;
  /* Never start a request that cannot fit: the timeout floor would otherwise
   * push us past the deadline we promised the caller. */
  if (budget < 150) return null;
  if (state.requests >= LR_MAX_REQUESTS) return null;
  if (cfg.cooldownKey && lrCooldownActive(cfg.cooldownKey)) return null;

  state.requests += 1;
  var remaining = budget;
  var headers = { "Accept": cfg.accept || "application/json" };
  if (cfg.provider === "lrc.red") {
    var ua = "LrcRedLyrics/" + LR_VERSION + " (+" + LR_APP_URL + "; contact: " + state.email + ")";
    headers["User-Agent"] = ua;
    headers["X-Client-ID"] = ua;
  }
  var opts = {
    headers: headers,
    connectTimeoutMs: Math.min(cfg.connectMs || 2500, remaining),
    readTimeoutMs: Math.min(cfg.readMs || 4000, remaining),
    followRedirects: true
  };
  try {
    var res = Platform.http.get(url, opts);
    var code = Number((res && res.code) || 0);
    if (code === 429 || code === 503) {
      var cdNow = lrNow();
      var cooldown = code === 429 ? LR_CD_FLAT_MS : LR_CD_503_MS;
      var step = 0;
      if (code === 429 && cfg.cdTier) {
        var prev = cfg.cooldownKey ? lrCooldownState(cfg.cooldownKey) : { n: 0, until: 0, last: 0 };
        /* Escalate only while the previous hit is still "recent"; a quiet
         * window means the limit has lifted, so start over at 30s. */
        step = (prev.n > 0 && cdNow - prev.last < LR_CD_IT_DECAY_MS) ? prev.n + 1 : 1;
        cooldown = LR_CD_IT_TIERS[Math.min(step, LR_CD_IT_TIERS.length) - 1];
      }
      var hdrs = (res && res.headers) || {};
      var retryRaw = hdrs["Retry-After"] || hdrs["retry-after"] || "";
      if (Array.isArray(retryRaw)) retryRaw = retryRaw[0] || "";
      var retrySeconds = Number(retryRaw);
      if (lrString(retryRaw).trim() && isFinite(retrySeconds) && retrySeconds > 0) {
        cooldown = Math.min(LR_CD_CAP_MS, Math.max(cooldown, Math.floor(retrySeconds * 1000)));
      }
      if (cfg.cooldownKey) {
        /* Keep the record well past the cooldown itself: `until` decides when
         * requests resume, while the record must survive long enough for the
         * next failure to see the previous step and escalate. */
        lrCacheSet(cfg.cooldownKey, step + ":" + (cdNow + cooldown) + ":" + cdNow,
          LR_CD_IT_DECAY_MS + cooldown);
      }
      lrLog("warn", "upstream " + code + " from " + (cfg.tag || "source") +
        "; cooldown " + cooldown + "ms" + (step ? " (step " + step + ")" : ""));
      return { code: code, body: "" };
    }
    var body = lrString(res && res.body);
    if (body.length > maxChars) {
      lrLog("warn", (cfg.tag || "payload") + " rejected: too large");
      return { code: 0, body: "" };
    }
    return { code: code, body: body };
  } catch (err) {
    lrLog("warn", (cfg.tag || "source") + " network error: " +
      lrString(err && err.message ? err.message : err).slice(0, 120));
    return { code: 0, body: "" };
  }
}
function lrGetJson(state, url, cfg) {
  var r = lrGet(state, url, LR_JSON_LIMIT, cfg);
  if (!r || r.code !== 200 || !r.body) return null;
  try {
    var text = r.body.replace(/^\ufeff/, "");
    var obj = JSON.parse(text);
    return obj && typeof obj === "object" ? obj : null;
  }
  catch (_) { return null; }
}

/* ---- TTML probe ------------------------------------------------------- */
function lrParseTtmlTime(value) {
  var s = lrString(value).trim();
  if (!s) return 0;
  var m = s.match(/^(\d+):(\d\d):(\d\d)(?:\.(\d+))?$/);
  if (m) return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Math.round(Number("0." + (m[4] || "0")) * 1000);
  m = s.match(/^(\d+):(\d\d)(?:\.(\d+))?$/);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000 + Math.round(Number("0." + (m[3] || "0")) * 1000);
  m = s.match(/^(\d+(?:\.\d+)?)s$/);
  if (m) return Math.round(Number(m[1]) * 1000);
  m = s.match(/^(\d+(?:\.\d+)?)ms$/);
  if (m) return Math.round(Number(m[1]));
  /* lrc.red serialises clock values as bare fractional seconds, e.g. 16.906. */
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return Math.round(Number(m[1]) * 1000);
  return 0;
}
/* One XML walk produces every metric both engines need. */
function lrProbeTtml(ttml) {
  var out = { ok: false, reason: "", origLines: 0, timedLines: 0, lastEnd: 0, bodyDur: 0 };
  if (typeof ttml !== "string" || ttml.length < 70 || ttml.length > LR_TTML_LIMIT) {
    out.reason = "size";
    return out;
  }
  if (!/<(?:[A-Za-z0-9_\-]+:)?tt(?:\s|>)/.test(ttml) || !/<\/(?:[A-Za-z0-9_\-]+:)?tt\s*>/.test(ttml)) {
    out.reason = "not_ttml";
    return out;
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(ttml)) {
    out.reason = "doctype";
    return out;
  }
  if (!Platform.xml || typeof Platform.xml.findElements !== "function") {
    out.reason = "no_xml_api";
    return out;
  }
  try {
    /* The body lookup is optional: a host that cannot resolve `body` must not
     * take the whole probe down with it. */
    try {
      var bodies = Platform.xml.findElements(ttml, { tag: "body" });
      if (Array.isArray(bodies) && bodies.length) {
        var ba = bodies[0].attrs || {};
        out.bodyDur = lrParseTtmlTime(ba.dur || ba["tts:dur"] || "");
      }
    } catch (_body) { out.bodyDur = 0; }
    var paragraphs = Platform.xml.findElements(ttml, { tag: "p" });
    if (!Array.isArray(paragraphs) || !paragraphs.length) {
      out.reason = "no_paragraphs";
      return out;
    }
    var original = 0, timed = 0, lastEnd = 0;
    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i] || {}, pa = p.attrs || {};
      var role = lrString(pa["ttm:role"] || pa.role);
      if (role === "x-bg" || role === "x-translation" || role === "x-roman" || role === "x-romanization") continue;
      var spans = p.children || [];
      /* Host builds differ on whether node.text is the textContent or only the
       * node's own text. Accept either, otherwise span-only TTML looks empty. */
      var lineText = lrString(p.text);
      if (!lineText.replace(/\s+/g, "")) {
        for (var t = 0; t < spans.length; t++) lineText += lrString((spans[t] || {}).text);
      }
      if (!lineText.replace(/\s+/g, "")) continue;
      original++;
      var found = false, wordEndMax = 0;
      for (var j = 0; j < spans.length; j++) {
        var node = spans[j] || {}, tag = lrString(node.tag).split(":").pop();
        if (tag !== "span") continue;
        var attrs = node.attrs || {};
        var spanRole = lrString(attrs["ttm:role"] || attrs.role);
        var a = lrParseTtmlTime(attrs.begin || ""), b = lrParseTtmlTime(attrs.end || "");
        if (attrs.begin && attrs.end && b > 0 && b < a) return { ok: false, reason: "inverted_word", origLines: original, timedLines: timed, lastEnd: lastEnd, bodyDur: out.bodyDur };
        if (b > wordEndMax) wordEndMax = b;
        if (spanRole !== "x-bg" && spanRole !== "x-translation" &&
            spanRole !== "x-roman" && (attrs.begin || attrs.end) && lrString(node.text).trim()) {
          found = true;
        }
      }
      if (found) timed++;
      var lineStart = lrParseTtmlTime(pa.begin || "");
      var e = lrParseTtmlTime(pa.end || "");
      if (e > 0 && e < lineStart) return { ok: false, reason: "inverted_line", origLines: original, timedLines: timed, lastEnd: lastEnd, bodyDur: out.bodyDur };
      if (e === 0) e = wordEndMax;
      if (e > lastEnd) lastEnd = e;
    }
    out.origLines = original;
    out.timedLines = timed;
    out.lastEnd = lastEnd;
    out.ok = true;
    return out;
  } catch (_) {
    out.reason = "parse_error";
    return out;
  }
}
function lrTtmlCheck(ttml, song, mode, probe) {
  var p = probe || lrProbeTtml(ttml);
  if (!p.ok) return false;
  if (p.origLines < 1 || p.timedLines < 1) return false;
  if (p.timedLines / p.origLines < (mode === "strict" ? 0.95 : 0.8)) return false;
  var dur = Number((song && song.duration) || 0);
  if (dur > 0 && p.lastEnd > 0) {
    var axis = p.bodyDur > 0 ? Math.min(p.bodyDur, p.lastEnd) : p.lastEnd;
    if (axis > dur + LR_OVERRUN_TOLERANCE_MS) return false;
    if (dur > LR_PREVIEW_MIN_TRACK_MS && axis < LR_PREVIEW_MAX_LAST_END_MS) return false;
    if (axis / dur < LR_AXIS_FLOOR) return false;
  }
  return true;
}
function lrNormalizeTtml(input) {
  var s = lrString(input);
  var legacy = /xmlns:lrc\s*=\s*(["'])http:\/\/lrc\.red\/lyric-ttml-internal\1/i;
  if (!legacy.test(s)) return s;
  var itunesDeclared = /xmlns:itunes\s*=/.test(s);
  s = s.replace(legacy, itunesDeclared ? "" : 'xmlns:itunes="http://music.apple.com/lyric-ttml-internal"');
  s = s.replace(/\blrc:/g, "itunes:");
  return s;
}

/* ---- engine A: Apple Music TTML --------------------------------------- */
function lrRegions(song) {
  return lrIsForeign(song.title + " " + song.artist) ? LR_REGIONS_FOREIGN : LR_REGIONS_ZH;
}
function lrItunesMatch(items, song, relaxed) {
  if (!Array.isArray(items)) return null;
  var titleCore = lrTitleCore(song.title);
  var i;
  for (i = 0; i < items.length && i < 10; i++) {
    var it = items[i] || {};
    var appleId = lrString(it.trackId).trim();
    if (!LR_APPLE_ID_RE.test(appleId)) continue;
    var t = lrString(it.trackName).trim();
    var a = lrString(it.artistName).trim();
    if (!t || !a || !titleCore) continue;
    if (!lrTitleMatch(song.title, t)) continue;
    /* Same three-state rule as lrc.red: soft tokens (remaster, extended,
     * taylor version) must not reject an otherwise identical track. */
    if (lrAssessVersion(song.title, song.album, t, lrString(it.collectionName)) === "conflict") continue;
    var dur = Number(it.trackTimeMillis || 0);
    if (!isFinite(dur) || dur < 0) dur = 0;
    if (relaxed) {
      /* Simplified/traditional names, romanised names and aliases all break a
       * literal artist comparison. Fall back to title + a tight duration match,
       * but never without a duration on both sides. */
      if (!(song.duration > 0 && dur > 0)) continue;
      if (Math.abs(dur - song.duration) > 2000) continue;
    } else {
      if (!lrArtistCompatible(song.artist, a)) continue;
      if (song.duration > 0 && dur > 0 && Math.abs(dur - song.duration) > 5000) continue;
    }
    return {
      appleId: appleId,
      title: t,
      artist: a,
      album: lrString(it.collectionName).trim(),
      date: lrString(it.releaseDate).trim(),
      duration: dur,
      region: "",
      relaxed: !!relaxed,
      exact: lrNorm(t).replace(/\s+/g, "") === lrNorm(song.title).replace(/\s+/g, "")
    };
  }
  return null;
}
function lrItunesSearch(state, song, region, dl) {
  var term = (song.title + " " + song.artist).trim();
  var url = LR_IT_BASE + "/search?term=" + encodeURIComponent(term) +
    "&country=" + region + "&media=music&entity=song&limit=10";
  var data = lrGetJson(state, url, {
    deadline: dl, connectMs: 1500, readMs: 2500,
    accept: "application/json", cooldownKey: "cd.it", cdTier: true, tag: "itunes"
  });
  if (!data) return null;
  /* One payload, two passes: strict first, relaxed as a fallback that costs
   * no extra request. */
  var strict = lrItunesMatch(data.results, song, false);
  if (strict) { strict.region = region; return { strict: strict, relaxed: null }; }
  var loose = lrItunesMatch(data.results, song, true);
  if (loose) loose.region = region;
  return { strict: null, relaxed: loose };
}
function lrFetchAppleTtml(state, appleId, dl) {
  if (!LR_APPLE_ID_RE.test(lrString(appleId))) return null;
  for (var i = 0; i < LR_MIRRORS.length && i < LR_MAX_MIRRORS; i++) {
    if (dl - lrNow() < LR_MIRROR_GAP_MS) break;
    var m = LR_MIRRORS[i];
    var url = m.base + "/am-lyrics/" + appleId + ".ttml";
    var r = lrGet(state, url, LR_TTML_LIMIT, {
      deadline: dl, connectMs: 1500, readMs: 2500,
      accept: "application/xml,text/xml,*/*",
      cooldownKey: "cd.mirror." + m.name, tag: "mirror:" + m.name
    });
    if (!r || r.code !== 200 || !r.body) continue;
    if (r.body.slice(0, 2048).toLowerCase().indexOf("<tt") < 0) {
      lrLog("debug", "mirror " + m.name + " returned a non-TTML body; trying next");
      continue;
    }
    return { ttml: r.body, mirror: m.name };
  }
  return null;
}
function lrAppleIdentityOk(song, meta, mode, relaxed) {
  if (!meta || !meta.title || !meta.artist) return false;
  if (!song.title) return false;
  if (!lrTitleMatch(song.title, meta.title)) return false;
  if (!lrArtistCompatible(song.artist, meta.artist) && !relaxed) return false;
  if (lrAssessVersion(song.title, song.album, meta.title, meta.album) === "conflict") return false;
  var dur = Number(meta.duration || 0);
  if (!isFinite(dur) || dur < 0) dur = 0;
  if (relaxed) {
    if (!(song.duration > 0 && dur > 0)) return false;
    return Math.abs(song.duration - dur) <= 2000;
  }
  if (song.duration > 0 && dur > 0 && Math.abs(song.duration - dur) > (mode === "strict" ? 3000 : 5000)) return false;
  return true;
}
function lrAppleCandidate(meta, ttml, song) {
  var s = song || {};
  var tags = {
    ti: lrString(meta.title),
    ar: lrString(meta.artist),
    al: lrString(meta.album || s.album).trim(),
    source: "Apple Music",
    url: "https://music.apple.com/us/song/" + lrString(meta.appleId)
  };
  tags.date = lrString(meta.date || s.date).slice(0, 10).trim();
  return { type: "rawTtml", tags: tags, rawTtml: ttml };
}
function lrItunesCacheKey(song) {
  var tc = lrTitleCore(song && song.title);
  if (!tc) tc = lrStripAlnum(lrNorm(song && song.title));
  if (!tc) return "";
  var arts = lrArtistSet(song && song.artist);
  arts.sort();
  return "itunes.q." + tc + "." + arts.join("_");
}
function lrItunesCacheGet(song) {
  if (!song || !song.title || !song.artist) return null;
  var key = lrItunesCacheKey(song);
  if (!key) return null;
  var raw = lrCacheGet(key);
  if (!raw) return null;
  try {
    var obj = JSON.parse(raw);
    var age = lrNow() - Number(obj.cachedAt || 0);
    if (obj && obj.appleId && isFinite(age) && age >= 0 && age < LR_CACHE_TTL_MS) return obj;
  } catch (_) {}
  return null;
}
function lrItunesCacheSet(song, hit) {
  if (!song || !hit || !hit.appleId) return;
  var key = lrItunesCacheKey(song);
  if (!key) return;
  var record = {
    appleId: lrString(hit.appleId),
    title: lrString(hit.title),
    artist: lrString(hit.artist),
    album: lrString(hit.album),
    date: lrString(hit.date),
    duration: Number(hit.duration || 0),
    region: lrString(hit.region),
    relaxed: !!hit.relaxed,
    cachedAt: lrNow()
  };
  var payload = JSON.stringify(record);
  if (payload.length <= 4096) lrCacheSet(key, payload, LR_CACHE_TTL_MS);
}
function lrAppleCacheGet(appleId) {
  var cached = lrCacheGet("apple." + appleId);
  if (!cached) return null;
  try {
    var obj = JSON.parse(cached);
    var age = lrNow() - Number(obj.cachedAt || 0);
    if (obj && obj.appleId === appleId && typeof obj.rawTtml === "string" &&
        isFinite(age) && age >= 0 && age < LR_CACHE_TTL_MS) return obj;
  } catch (_) {}
  return null;
}
function lrAppleCacheSet(record) {
  record.cachedAt = lrNow();
  var payload = JSON.stringify(record);
  if (payload.length <= 262144) lrCacheSet("apple." + record.appleId, payload, LR_CACHE_TTL_MS);
}
function lrEngineApple(state, song, mode, dl) {
  var tStart = lrNow();
  var hit = lrItunesCacheGet(song);
  if (hit && !lrAppleIdentityOk(song, hit, mode, hit.relaxed)) {
    hit = null;
  }
  var i, relaxedHit = null;

  if (!hit) {
    var regions = lrRegions(song);
    for (i = 0; i < regions.length; i++) {
      if (dl - lrNow() < LR_REGION_GAP_MS) {
        lrLog("debug", "[apple] budget stop before region " + regions[i]);
        break;
      }
      var res = lrItunesSearch(state, song, regions[i], dl);
      if (!res) continue;
      /* A strict hit anywhere beats a relaxed hit found earlier. */
      if (res.strict) { hit = res.strict; break; }
      if (res.relaxed) {
        if (!relaxedHit) relaxedHit = res.relaxed;
        /* Exact title plus a sub-second duration match is strong enough to stop
         * early; scanning the remaining storefronts would only cost requests. */
        if (relaxedHit.exact && song.duration > 0 &&
            Math.abs(relaxedHit.duration - song.duration) <= 500) {
          hit = relaxedHit;
          break;
        }
      }
    }
    if (!hit && relaxedHit) {
      hit = relaxedHit;
      lrLog("debug", "[apple] relaxed match accepted (title+duration, artist not required)");
    }
    if (hit) lrItunesCacheSet(song, hit);
  }
  if (!hit) {
    lrLog("debug", "[apple] no iTunes match; elapsed=" + (lrNow() - tStart) + "ms");
    return [];
  }

  var cached = lrAppleCacheGet(hit.appleId);
  var ttml = "", mirror = "cache";
  if (cached) {
    ttml = cached.rawTtml;
    hit.title = cached.title || hit.title;
    hit.artist = cached.artist || hit.artist;
    hit.album = cached.album || hit.album;
    hit.date = cached.date || hit.date;
  } else {
    if (dl - lrNow() < LR_MIRROR_GAP_MS) {
      lrLog("debug", "[apple] budget exhausted before TTML fetch");
      return [];
    }
    var fetched = lrFetchAppleTtml(state, hit.appleId, dl);
    if (!fetched) {
      lrLog("debug", "[apple] TTML unavailable on all mirrors; elapsed=" + (lrNow() - tStart) + "ms");
      return [];
    }
    ttml = fetched.ttml;
    mirror = fetched.mirror;
  }

  var normalized = lrNormalizeTtml(ttml);
  var probe = (cached && lrValidProbe(cached.probe)) ? cached.probe : lrProbeTtml(normalized);
  if (!probe.ok) {
    lrLog("debug", "[apple] TTML rejected (" + probe.reason + ")");
    return [];
  }
  if (!lrAppleIdentityOk(song, hit, mode, hit.relaxed)) {
    lrLog("debug", "[apple] identity/version gate rejected id=" + hit.appleId);
    return [];
  }
  /* A local file may carry no duration tag. The iTunes result does, so use it
   * as the axis reference instead of skipping the preview/overrun gates. */
  var axisSong = { duration: song.duration > 0 ? song.duration : Number(hit.duration || 0) };
  if (!lrTtmlCheck(normalized, axisSong, mode, probe)) {
    lrLog("debug", "[apple] timing gate rejected id=" + hit.appleId +
      " (lines " + probe.timedLines + "/" + probe.origLines + ", lastEnd " + probe.lastEnd + ")");
    return [];
  }
  if (!cached) {
    lrAppleCacheSet({
      appleId: hit.appleId, title: hit.title, artist: hit.artist,
      album: hit.album, date: hit.date, duration: hit.duration,
      rawTtml: normalized, probe: probe
    });
  }
  lrLog("info", "[apple] hit id=" + hit.appleId + " region=" + hit.region +
    " mirror=" + mirror + " elapsed=" + (lrNow() - tStart) + "ms");
  return [lrAppleCandidate(hit, normalized, song)];
}

/* ---- engine B: lrc.red ------------------------------------------------ */
function lrRankHits(hits, song, mode) {
  if (!Array.isArray(hits)) return [];
  var ranked = [], visited = {};
  var n = Math.min(hits.length, 45);
  var titleCore = lrTitleCore(song.title);
  for (var i = 0; i < n; i++) {
    var h = hits[i];
    if (!h || typeof h !== "object") continue;
    var isrc = lrIsrc(h.isrc);
    if (!isrc || visited[isrc]) continue;
    var ht = lrString(h.title || ""), ha = lrString(h.artist || "");
    if (!ht || !ha || !titleCore || !lrTitleMatch(song.title, ht)) continue;
    if (lrAssessVersion(song.title, song.album, ht, lrString(h.album)) === "conflict") continue;
    if (song.artist && !lrArtistCompatible(song.artist, ha)) continue;
    var dur = Number(h.duration || 0) * 1000;
    if (!isFinite(dur) || dur < 0 || dur > 86400000) dur = 0;
    var hasDuration = song.duration > 0 && dur > 0;
    var diff = hasDuration ? Math.abs(song.duration - dur) : 0;
    if (hasDuration && diff > 5000) continue;
    if (mode === "strict" && (!hasDuration || diff > 3000)) continue;
    visited[isrc] = true;
    var score = 100;
    if (lrNorm(ht).replace(/\s+/g, "") === lrNorm(song.title).replace(/\s+/g, "")) score += 15;
    if (song.album && h.album && lrAlbumCore(song.album) === lrAlbumCore(h.album)) score += 20;
    if (hasDuration) score += 18 - Math.floor(diff / 300);
    else score -= 12;
    ranked.push({ hit: h, isrc: isrc, score: score });
  }
  ranked.sort(function (a, b) { return b.score - a.score || (a.isrc < b.isrc ? -1 : 1); });
  return ranked;
}
function lrValidateIdentity(song, meta, mode) {
  if (!meta || !meta.title || !meta.artist) return false;
  if (!song.title) return false;
  if (!lrTitleMatch(song.title, meta.title)) return false;
  if (lrAssessVersion(song.title, song.album, meta.title, lrString(meta.album)) === "conflict") return false;
  /* An empty local artist (untagged file) must not veto the candidate; the
   * duration gate still has to hold. */
  if (song.artist && !lrArtistCompatible(song.artist, meta.artist)) return false;
  var dur = Number(meta.duration || 0) * 1000;
  if (!isFinite(dur) || dur < 0) dur = 0;
  if (song.duration && dur && Math.abs(song.duration - dur) > (mode === "strict" ? 3000 : 5000)) return false;
  if (mode === "strict" && (!song.duration || !dur)) return false;
  if (meta.byModel === true) return false;
  return true;
}
function lrTrackMeta(details, hit) {
  var d = details || {}, h = hit || {};
  var pick = function () {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null && lrString(arguments[i]).length) return arguments[i];
    }
    return "";
  };
  return {
    isrc: lrIsrc(pick(d.isrc, h.isrc)),
    title: lrString(pick(d.title, h.title)),
    artist: lrString(pick(d.artist, h.artist)),
    album: lrString(pick(d.album, h.album)),
    released: lrString(pick(d.released, d.date, h.released, h.date, h.year, d.year)),
    year: lrString(pick(d.year, h.year)),
    duration: Number(d.duration) || Number(h.duration) || 0,
    byModel: d.byModel,
    source: lrString(pick(d.source, h.source))
  };
}
/* Accept a payload only if it parses *and* clears the structural gate. A plain
 * parse check would let a line-only `source` block the word-timed /s/*.ttml
 * fallback behind it. */
function lrAcceptTtml(text) {
  if (!text || typeof text !== "string" || text.length > LR_TTML_LIMIT) return null;
  var norm = lrNormalizeTtml(text);
  var p = lrProbeTtml(norm);
  if (!p.ok) return null;
  if (!lrTtmlCheck(norm, { duration: 0 }, "balanced", p)) return null;
  return { ttml: norm, probe: p };
}
function lrGetTrack(state, isrc, hit, dl) {
  var key = "track." + isrc;
  var cached = lrCacheGet(key);
  if (cached && cached.length <= LR_TTML_LIMIT + LR_JSON_LIMIT) {
    try {
      var obj = JSON.parse(cached);
      var age = lrNow() - Number(obj.cachedAt || 0);
      if (obj && obj.isrc === isrc && typeof obj.rawTtml === "string" &&
          isFinite(age) && age >= 0 && age < LR_CACHE_TTL_MS) return obj;
    } catch (_) { /* stale invalid cache */ }
  }

  var base = LR_BASE + "/s/" + isrc;
  var songDoc = lrGetJson(state, base + ".song.json", {
    deadline: dl, provider: "lrc.red", cooldownKey: "cd.lrc", tag: "lrc.red"
  });
  var meta = lrTrackMeta(songDoc, hit);
  var picked = lrAcceptTtml(meta.source);

  if (!picked) {
    var moreMeta = lrGetJson(state, base + ".json", {
      deadline: dl, provider: "lrc.red", cooldownKey: "cd.lrc", tag: "lrc.red"
    });
    meta = lrTrackMeta(moreMeta, meta);
    picked = lrAcceptTtml(meta.source);
  }

  if (!picked) {
    var tr = lrGet(state, base + ".ttml", LR_TTML_LIMIT, {
      deadline: dl, provider: "lrc.red", accept: "application/xml,text/xml,*/*",
      cooldownKey: "cd.lrc", tag: "lrc.red"
    });
    if (tr && tr.code === 200) picked = lrAcceptTtml(tr.body);
  }

  if (!picked) return null;

  /* meta.source duplicates rawTtml inside the cache entry; drop it. The probe
   * travels with the record so a cache hit does not re-walk the XML. */
  var metaForCache = {
    isrc: meta.isrc, title: meta.title, artist: meta.artist, album: meta.album,
    released: meta.released, year: meta.year, duration: meta.duration, byModel: meta.byModel
  };
  var out = {
    isrc: isrc, meta: metaForCache, rawTtml: picked.ttml,
    probe: picked.probe, cachedAt: lrNow()
  };
  var payload = JSON.stringify(out);
  if (payload.length <= 262144) lrCacheSet(key, payload, LR_CACHE_TTL_MS);
  return out;
}
function lrCandidate(record, song, mode, probe) {
  if (!record) return null;
  var meta = record.meta || {};
  if (!lrValidateIdentity(song, meta, mode)) return null;
  var p = probe || record.probe;
  if (!lrValidProbe(p)) p = null;      /* never trust a malformed cached probe */
  var axisDur = (song && song.duration > 0) ? song.duration : Number(meta.duration || 0) * 1000;
  var axisSong = { duration: (isFinite(axisDur) && axisDur > 0) ? axisDur : 0 };
  if (!lrTtmlCheck(record.rawTtml, axisSong, mode, p)) return null;
  var title = lrString(meta.title), artist = lrString(meta.artist);
  if (!title || !artist) return null;
  /* Album and date are judgement aids, not requirements: fall back to the
   * local tag, then to an empty string. Fabricating values is not allowed. */
  var album = lrString(meta.album || song.album).trim();
  var date = lrString(meta.released || meta.year || song.date).trim();
  return {
    type: "rawTtml",
    tags: {
      ti: title,
      ar: artist,
      al: album,
      date: date,
      source: "lrc.red",
      url: LR_BASE + "/s/" + record.isrc
    },
    rawTtml: record.rawTtml
  };
}
function lrFindCandidates(state, song, mode, url, dl) {
  var obj = lrGetJson(state, url, {
    deadline: dl, provider: "lrc.red", cooldownKey: "cd.lrc", tag: "lrc.red"
  });
  return obj && Array.isArray(obj.hits) ? lrRankHits(obj.hits, song, mode) : [];
}
function lrTryRanks(state, ranks, song, mode, output, seen, maxOut, dl) {
  for (var i = 0; i < ranks.length && output.length < maxOut; i++) {
    if (lrNow() >= dl) break;
    var item = ranks[i];
    if (seen[item.isrc]) continue;
    if (i > 0 && ranks[0] && item.score < ranks[0].score - 25) break;
    seen[item.isrc] = true;
    var track = lrGetTrack(state, item.isrc, item.hit, dl);
    var result = lrCandidate(track, song, mode);
    if (result) output.push(result);
    if (i >= 2) break;
  }
}
function lrEngineLrcRed(state, song, mode, fallback, maxOut, dl) {
  var out = [], seen = {};
  if (!song.title) return out;
  if (dl - lrNow() < 400) return out;

  if (song.isrc) {
    var direct = lrCandidate(lrGetTrack(state, song.isrc, { isrc: song.isrc }, dl), song, mode);
    if (direct) out.push(direct);
    seen[song.isrc] = true;
  }
  if (out.length < maxOut && dl - lrNow() > 400) {
    var params = "track=" + encodeURIComponent(song.title);
    if (song.artist) params += "&artist=" + encodeURIComponent(song.artist);
    if (song.album) params += "&album=" + encodeURIComponent(song.album);
    if (song.duration > 0) params += "&duration=" + Math.round(song.duration / 1000);
    lrTryRanks(state, lrFindCandidates(state, song, mode, LR_BASE + "/match.json?" + params, dl),
      song, mode, out, seen, maxOut, dl);
  }
  if (out.length < maxOut && fallback && dl - lrNow() > 400) {
    var q = encodeURIComponent((song.title + " " + song.artist).trim());
    lrTryRanks(state, lrFindCandidates(state, song, mode, LR_BASE + "/search.json?q=" + q, dl),
      song, mode, out, seen, maxOut, dl);
  }
  return out;
}

/* ---- entry ------------------------------------------------------------ */
function getLyrics(request) {
  var email = lrContact(request);
  var song = lrSongContext(request);
  if (!song.title) {
    lrLog("warn", "Song requires a title");
    return [];
  }
  if (typeof Platform === "undefined" || !Platform.http || typeof Platform.http.get !== "function" ||
      !Platform.xml || typeof Platform.xml.findElements !== "function") {
    lrLog("warn", "Lyrico Host HTTP/XML API is unavailable; upgrade the application");
    return [];
  }

  var mode = lrString(lrConfig(request, "match_mode", "balanced")).toLowerCase() === "strict" ? "strict" : "balanced";
  var fallback = lrBool(lrConfig(request, "search_fallback", "true"), true);
  var appleOn = lrBool(lrConfig(request, "apple_tier", "true"), true);

  var t0 = lrNow();
  var totalDl = t0 + LR_TOTAL_BUDGET_MS;
  var state = { email: email, requests: 0, deadline: totalDl };
  var results = [];

  if (appleOn) {
    try {
      var appleDl = Math.min(t0 + LR_APPLE_MAX_MS, totalDl - LR_LRC_RESERVE_MS);
      results = lrEngineApple(state, song, mode, appleDl);
    } catch (e1) {
      lrLog("warn", "[apple] aborted safely: " + lrString(e1 && e1.message ? e1.message : e1).slice(0, 120));
      results = [];
    }
  }

  var maxOut = results.length ? 1 : 2;
  var lrcDl = totalDl;
  if (results.length) lrcDl = Math.min(totalDl, lrNow() + LR_LRC_SECOND_MS);

  if (lrcDl - lrNow() > 400) {
    if (!email) {
      lrLog("debug", "[lrc.red] skipped: no contact email configured in plugin settings");
    } else {
      try {
        results = results.concat(lrEngineLrcRed(state, song, mode, fallback, maxOut, lrcDl));
      } catch (e2) {
        lrLog("warn", "[lrc.red] aborted safely: " + lrString(e2 && e2.message ? e2.message : e2).slice(0, 120));
      }
    }
  } else {
    lrLog("debug", "[lrc.red] skipped; remaining budget " + Math.max(0, lrcDl - lrNow()) + "ms");
  }

  /* The two engines can carry the same upstream TTML. Returning it twice would
   * just make the user pick between two identical rows. */
  var merged = [];
  for (var k = 0; k < results.length; k++) {
    var dup = false;
    for (var m = 0; m < merged.length; m++) {
      if (merged[m].rawTtml === results[k].rawTtml) { dup = true; break; }
    }
    if (!dup) merged.push(results[k]);
  }

  lrLog("debug", "getLyrics done; results=" + merged.length + ", requests=" + state.requests +
    ", elapsedMs=" + (lrNow() - t0) + ", apple=" + (appleOn ? "on" : "off"));
  return merged.slice(0, 2);
}
