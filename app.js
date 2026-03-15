const queryInput = document.getElementById("query");
const suggestionsEl = document.getElementById("suggestions");
const searchBtn = document.getElementById("searchBtn");
const geoBtn = document.getElementById("geoBtn");
const statusEl = document.getElementById("status");
const accuracyEl = document.getElementById("accuracy");
const cardsEl = document.getElementById("cards");
const titleEl = document.getElementById("locationTitle");
const tpl = document.getElementById("cardTpl");
const periodButtons = document.querySelectorAll(".period-btn");

const MODELS = ["best_match", "gfs_seamless", "jma_msm"];
const PERIOD = {
  "48h": { label: "48時間", hours: 48 },
  "7d": { label: "1週間", hours: 24 * 7 },
  "30d": { label: "1ヶ月", days: 30 },
  past48h: { label: "過去48時間" },
};

const RISK = {
  GOOD: { label: "散布向き", className: "risk-good" },
  OK: { label: "軽作業向き", className: "risk-ok" },
  BAD: { label: "注意", className: "risk-bad" },
};

const state = {
  period: "48h",
  lastLocation: null,
  forecastRows: [],
  comparisonRows: [],
  stationSummary: "",
  biasByModel: {},
  maeByModel: {},
  weightsByModel: {},
  terrainAdjustment: 0,
  selectedPlace: null,
};

const cache = {
  amedasTable: null,
  amedasMapByKey: new Map(),
};

let suggestTimer = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setAccuracy(text) {
  accuracyEl.textContent = text;
}

function setActivePeriodButton(period) {
  periodButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.period === period);
  });
}

function hourText(isoTime) {
  const d = new Date(isoTime);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours(),
  ).padStart(2, "0")}:00`;
}

function dayText(isoTime) {
  const d = new Date(isoTime);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function toDecimalDegree([deg, min]) {
  return deg + min / 60;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function toAmedasHourKey(date) {
  const rounded = new Date(date);
  rounded.setMinutes(0, 0, 0);
  const jst = new Date(rounded.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  return `${y}${m}${d}${h}00`;
}

function judgeRisk(speed, gust) {
  if (speed <= 2.5 && gust <= 5.0) return RISK.GOOD;
  if (speed <= 4.0 && gust <= 8.0) return RISK.OK;
  return RISK.BAD;
}

function riskBySpeed(speed) {
  if (speed <= 2.5) return RISK.GOOD;
  if (speed <= 4.0) return RISK.OK;
  return RISK.BAD;
}

function renderCard({ timeLabel, windLabel, risk }) {
  const node = tpl.content.cloneNode(true);
  node.querySelector(".time").textContent = timeLabel;
  node.querySelector(".wind").textContent = windLabel;
  const riskEl = node.querySelector(".risk");
  riskEl.textContent = risk.label;
  riskEl.classList.add(risk.className);
  cardsEl.appendChild(node);
}

async function fetchAmedasTable() {
  if (cache.amedasTable) return cache.amedasTable;
  const res = await fetch("https://www.jma.go.jp/bosai/amedas/const/amedastable.json");
  if (!res.ok) throw new Error("アメダス地点情報の取得に失敗しました");
  cache.amedasTable = await res.json();
  return cache.amedasTable;
}

async function fetchAmedasMapByHourKey(hourKey) {
  if (cache.amedasMapByKey.has(hourKey)) return cache.amedasMapByKey.get(hourKey);
  const res = await fetch(`https://www.jma.go.jp/bosai/amedas/data/map/${hourKey}00.json`);
  if (!res.ok) {
    cache.amedasMapByKey.set(hourKey, null);
    return null;
  }
  const data = await res.json();
  cache.amedasMapByKey.set(hourKey, data);
  return data;
}

function selectNearbyStations(table, lat, lon, maxCount = 4, maxDistKm = 120) {
  const all = Object.entries(table)
    .map(([id, row]) => {
      if (!row.lat || !row.lon) return null;
      const stLat = toDecimalDegree(row.lat);
      const stLon = toDecimalDegree(row.lon);
      return {
        id,
        name: row.kjName || row.enName || id,
        lat: stLat,
        lon: stLon,
        alt: typeof row.alt === "number" ? row.alt : 0,
        distanceKm: haversineKm(lat, lon, stLat, stLon),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  return all.filter((s) => s.distanceKm <= maxDistKm).slice(0, maxCount);
}

function buildForecastRows(raw) {
  const times = raw.hourly.time || [];
  return times.map((time, i) => {
    const byModel = {};
    MODELS.forEach((model) => {
      const speedArr = raw.hourly[`wind_speed_10m_${model}`];
      const gustArr = raw.hourly[`wind_gusts_10m_${model}`];
      byModel[model] = {
        speed: Array.isArray(speedArr) ? speedArr[i] : null,
        gust: Array.isArray(gustArr) ? gustArr[i] : null,
      };
    });
    return { time, byModel };
  });
}

function weightedMean(pairs) {
  if (pairs.length === 0) return null;
  const sumW = pairs.reduce((s, p) => s + p.w, 0);
  if (sumW <= 0) return null;
  const sumV = pairs.reduce((s, p) => s + p.v * p.w, 0);
  return sumV / sumW;
}

function buildComparisonRows(forecastRows, observedByKey) {
  const now = Date.now();
  const from = now - 48 * 60 * 60 * 1000;
  return forecastRows
    .filter((r) => {
      const t = new Date(r.time).getTime();
      return t >= from && t <= now;
    })
    .map((r) => {
      const key = toAmedasHourKey(new Date(r.time));
      const observed = observedByKey[key];
      if (typeof observed !== "number") return null;
      return { ...r, observed };
    })
    .filter(Boolean);
}

function computeBiasAndWeights(comparisonRows) {
  const biasByModel = {};
  const maeByModel = {};
  const weightsByModel = {};

  MODELS.forEach((model) => {
    const errors = comparisonRows
      .map((r) => {
        const v = r.byModel[model].speed;
        return typeof v === "number" ? v - r.observed : null;
      })
      .filter((v) => typeof v === "number");
    if (errors.length === 0) {
      biasByModel[model] = 0;
      maeByModel[model] = 2.0;
      weightsByModel[model] = 0.0001;
      return;
    }
    const bias = errors.reduce((s, e) => s + e, 0) / errors.length;
    const mae = errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length;
    biasByModel[model] = bias;
    maeByModel[model] = mae;
    weightsByModel[model] = 1 / (mae + 0.3);
  });

  const sw = Object.values(weightsByModel).reduce((s, v) => s + v, 0);
  MODELS.forEach((model) => {
    weightsByModel[model] = sw > 0 ? weightsByModel[model] / sw : 1 / MODELS.length;
  });

  return { biasByModel, maeByModel, weightsByModel };
}

function applyTerrainAdjustment(locationElevation, stationElevation) {
  const altDiff = locationElevation - stationElevation;
  return clamp(altDiff * 0.0015, -1.2, 1.2);
}

function ensembleRow(row, biasByModel, weightsByModel, terrainAdjustment) {
  const speedPairs = [];
  const gustPairs = [];

  MODELS.forEach((model) => {
    const w = weightsByModel[model] || 0;
    if (w <= 0) return;
    const speedRaw = row.byModel[model].speed;
    const gustRaw = row.byModel[model].gust;
    if (typeof speedRaw === "number") {
      speedPairs.push({ v: speedRaw - (biasByModel[model] || 0) + terrainAdjustment, w });
    }
    if (typeof gustRaw === "number") {
      gustPairs.push({ v: gustRaw - (biasByModel[model] || 0) + terrainAdjustment, w });
    }
  });

  const speed = weightedMean(speedPairs);
  const gust = gustPairs.length > 0 ? weightedMean(gustPairs) : speed;
  const speedMin = speedPairs.length > 0 ? Math.min(...speedPairs.map((p) => p.v)) : speed;
  const speedMax = speedPairs.length > 0 ? Math.max(...speedPairs.map((p) => p.v)) : speed;
  return { time: row.time, speed, gust, speedMin, speedMax };
}

async function fetchForecast(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("hourly", "wind_speed_10m,wind_gusts_10m");
  url.searchParams.set("models", MODELS.join(","));
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("past_days", "2");
  url.searchParams.set("forecast_days", "16");
  url.searchParams.set("timezone", "auto");
  const res = await fetch(url);
  if (!res.ok) throw new Error("予報データの取得に失敗しました");
  return res.json();
}

async function fetchGeocodeResults(name, count) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", name);
  url.searchParams.set("count", String(count));
  url.searchParams.set("language", "ja");
  const res = await fetch(url);
  if (!res.ok) throw new Error("地点検索に失敗しました");
  const data = await res.json();
  if (data.results && data.results.length > 0) return data.results;

  const fallbackUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  fallbackUrl.searchParams.set("name", name);
  fallbackUrl.searchParams.set("count", String(count));
  const fallbackRes = await fetch(fallbackUrl);
  if (!fallbackRes.ok) throw new Error("地点検索に失敗しました");
  const fallbackData = await fallbackRes.json();
  if (fallbackData.results && fallbackData.results.length > 0) return fallbackData.results;
  return fetchNominatimResults(name, count);
}

function scoreNominatimCandidate(item) {
  const t = item.addresstype || item.type || "";
  const c = item.category || "";
  let score = Number(item.importance || 0) * 10;
  if (["city", "town", "village", "municipality", "administrative"].includes(t)) score += 100;
  if (c === "boundary") score += 60;
  if (c === "railway") score += 20;
  if (c === "highway") score -= 20;
  return score;
}

function mapNominatim(item) {
  const addr = item.address || {};
  const admin1 = addr.province || addr.state || "";
  const name =
    addr.city ||
    addr.town ||
    addr.village ||
    addr.municipality ||
    item.name ||
    (item.display_name ? item.display_name.split(",")[0] : "地点");
  return {
    name,
    admin1,
    admin2: "",
    country: addr.country || "日本",
    latitude: Number(item.lat),
    longitude: Number(item.lon),
    elevation: null,
  };
}

async function fetchNominatimResults(name, count) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "jp");
  url.searchParams.set("accept-language", "ja");
  url.searchParams.set("q", name);
  url.searchParams.set("limit", String(Math.max(6, count)));
  const res = await fetch(url);
  if (!res.ok) return [];
  const raw = await res.json();
  const items = Array.isArray(raw) ? raw : [];
  return items
    .sort((a, b) => scoreNominatimCandidate(b) - scoreNominatimCandidate(a))
    .map(mapNominatim)
    .filter((x) => Number.isFinite(x.latitude) && Number.isFinite(x.longitude))
    .slice(0, count);
}

async function geocode(name) {
  const results = await fetchGeocodeResults(name, 1);
  if (!results.length) throw new Error("地点が見つかりませんでした");
  return results[0];
}

async function geocodeCandidates(name) {
  return fetchGeocodeResults(name, 6);
}

function formatPlaceLabel(hit) {
  const parts = [hit.admin1, hit.admin2, hit.name].filter(Boolean);
  const unique = [];
  parts.forEach((p) => {
    if (!unique.includes(p)) unique.push(p);
  });
  return unique.join("");
}

function clearSuggestions() {
  suggestionsEl.innerHTML = "";
  suggestionsEl.hidden = true;
}

function selectPlace(hit) {
  state.selectedPlace = hit;
  queryInput.value = formatPlaceLabel(hit);
  clearSuggestions();
}

function renderSuggestions(hits) {
  if (!hits.length) {
    clearSuggestions();
    return;
  }
  const seen = new Set();
  suggestionsEl.innerHTML = "";
  hits.forEach((hit) => {
    const label = formatPlaceLabel(hit);
    if (seen.has(label)) return;
    seen.add(label);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion-btn";
    btn.textContent = label;
    const pick = (e) => {
      e.preventDefault();
      selectPlace(hit);
    };
    btn.addEventListener("mousedown", pick);
    btn.addEventListener("click", pick);
    li.appendChild(btn);
    suggestionsEl.appendChild(li);
  });
  suggestionsEl.hidden = false;
}

async function buildObservedSeries(stations, hourKeys) {
  const weights = stations.map((s) => ({ id: s.id, w: 1 / (s.distanceKm + 1) }));
  const observedByKey = {};

  await Promise.all(hourKeys.map((k) => fetchAmedasMapByHourKey(k)));
  hourKeys.forEach((key) => {
    const mapData = cache.amedasMapByKey.get(key);
    if (!mapData) return;
    const pairs = weights
      .map((sw) => {
        const node = mapData[sw.id];
        const val = node && node.wind ? node.wind[0] : null;
        return typeof val === "number" ? { v: val, w: sw.w } : null;
      })
      .filter(Boolean);
    const obs = weightedMean(pairs);
    if (typeof obs === "number") observedByKey[key] = obs;
  });
  return observedByKey;
}

function renderFutureHourly(rows, hours, label) {
  const now = Date.now();
  const maxMs = now + hours * 60 * 60 * 1000;
  const target = rows.filter((r) => {
    const t = new Date(r.time).getTime();
    return t >= now && t <= maxMs;
  });
  cardsEl.innerHTML = "";
  if (target.length === 0) {
    setStatus("表示できる予報がありませんでした。");
    return;
  }

  const goodCount = target.filter((r) => judgeRisk(r.speed, r.gust) === RISK.GOOD).length;
  setStatus(`${label}で「散布向き」は ${goodCount} 時間あります。`);
  target.forEach((r) => {
    const risk = judgeRisk(r.speed, r.gust);
    const windLabel = `平均 ${r.speed.toFixed(1)} / 突風 ${r.gust.toFixed(1)} m/s (幅 ${r.speedMin.toFixed(1)}-${r.speedMax.toFixed(1)})`;
    renderCard({ timeLabel: hourText(r.time), windLabel, risk });
  });
}

function renderFutureDaily(rows) {
  const now = Date.now();
  const dailyMap = new Map();
  rows.forEach((r) => {
    const t = new Date(r.time);
    if (t.getTime() < now) return;
    const key = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
    const cur = dailyMap.get(key);
    if (!cur || r.speed > cur.speed) dailyMap.set(key, { time: r.time, speed: r.speed, gust: r.gust });
  });
  const days = [...dailyMap.values()].slice(0, 30);
  cardsEl.innerHTML = "";
  if (days.length === 0) {
    setStatus("表示できる予報がありませんでした。");
    return;
  }
  const goodCount = days.filter((d) => riskBySpeed(d.speed) === RISK.GOOD).length;
  const note = days.length < 30 ? `（API仕様により最大${days.length}日分を表示）` : "";
  setStatus(`1ヶ月表示: 「散布向き」の日は ${goodCount} 日です。${note}`);
  days.forEach((d) => {
    const risk = riskBySpeed(d.speed);
    const windLabel = `日最大 平均${d.speed.toFixed(1)} / 突風${d.gust.toFixed(1)} m/s`;
    renderCard({ timeLabel: dayText(d.time), windLabel, risk });
  });
}

function renderPastComparison(rows) {
  cardsEl.innerHTML = "";
  if (rows.length === 0) {
    setStatus("過去48時間比較データがありません。");
    return;
  }
  setStatus(`過去48時間比較: ${rows.length}件`);
  rows.forEach((r) => {
    const diff = Math.abs(r.ensembleSpeed - r.observed);
    const risk = riskBySpeed(diff);
    renderCard({
      timeLabel: hourText(r.time),
      windLabel: `予測 ${r.ensembleSpeed.toFixed(1)} / 実績 ${r.observed.toFixed(1)} / 差分 ${diff.toFixed(1)} m/s`,
      risk,
    });
  });
}

function renderByPeriod() {
  if (!state.forecastRows.length) return;
  if (state.period === "past48h") {
    renderPastComparison(state.comparisonRows);
    return;
  }
  if (state.period === "30d") {
    renderFutureDaily(state.forecastRows);
    return;
  }
  renderFutureHourly(state.forecastRows, PERIOD[state.period].hours, PERIOD[state.period].label);
}

function renderMetrics() {
  if (!state.comparisonRows.length) {
    setAccuracy("実測比較: 十分なデータがありません。");
    return;
  }
  const diffs = state.comparisonRows.map((r) => Math.abs(r.ensembleSpeed - r.observed));
  const mae = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const agreement =
    (state.comparisonRows.filter((r) => (r.ensembleSpeed <= 2.5) === (r.observed <= 2.5)).length /
      state.comparisonRows.length) *
    100;
  const modelMae = MODELS.map((m) => `${m}:${(state.maeByModel[m] || 0).toFixed(2)}`).join(" / ");
  const modelW = MODELS.map((m) => `${m}:${((state.weightsByModel[m] || 0) * 100).toFixed(0)}%`).join(" / ");
  const modelBias = MODELS.map((m) => `${m}:${(state.biasByModel[m] || 0).toFixed(2)}`).join(" / ");
  setAccuracy(
    `観測所:${state.stationSummary} | MAE:${mae.toFixed(2)}m/s | 判定一致率:${agreement.toFixed(1)}% | Bias:${modelBias} | Weight:${modelW} | ModelMAE:${modelMae} | 地形補正:${state.terrainAdjustment.toFixed(2)}m/s`,
  );
}

async function run(lat, lon, title, locationElevation = null) {
  try {
    setStatus("予報データを取得中...");
    cardsEl.innerHTML = "";
    titleEl.textContent = title;

    const [rawForecast, amedasTable] = await Promise.all([fetchForecast(lat, lon), fetchAmedasTable()]);
    const stations = selectNearbyStations(amedasTable, lat, lon, 4, 120);
    if (stations.length === 0) throw new Error("近傍のアメダス観測所が見つかりませんでした");

    const stationElevation =
      stations.reduce((s, st) => s + st.alt / (st.distanceKm + 1), 0) /
      stations.reduce((s, st) => s + 1 / (st.distanceKm + 1), 0);
    const targetElevation = typeof locationElevation === "number" ? locationElevation : rawForecast.elevation || stationElevation;
    const terrainAdjustment = applyTerrainAdjustment(targetElevation, stationElevation);

    const rawRows = buildForecastRows(rawForecast);
    const hourKeys = [...new Set(rawRows.map((r) => toAmedasHourKey(new Date(r.time))))];
    const observedByKey = await buildObservedSeries(stations, hourKeys);
    const comparisonRaw = buildComparisonRows(rawRows, observedByKey);
    const { biasByModel, maeByModel, weightsByModel } = computeBiasAndWeights(comparisonRaw);
    const ensembleRows = rawRows.map((r) => ensembleRow(r, biasByModel, weightsByModel, terrainAdjustment));
    const comparisonRows = comparisonRaw
      .map((r) => {
        const en = ensembleRows.find((x) => x.time === r.time);
        if (!en || typeof en.speed !== "number") return null;
        return { time: r.time, ensembleSpeed: en.speed, observed: r.observed };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

    state.lastLocation = { lat, lon, title, locationElevation };
    state.forecastRows = ensembleRows;
    state.comparisonRows = comparisonRows;
    state.stationSummary = stations.map((s) => `${s.name}(${s.distanceKm.toFixed(1)}km)`).join(", ");
    state.biasByModel = biasByModel;
    state.maeByModel = maeByModel;
    state.weightsByModel = weightsByModel;
    state.terrainAdjustment = terrainAdjustment;

    renderMetrics();
    renderByPeriod();
  } catch (err) {
    setStatus(err.message || "エラーが発生しました");
    setAccuracy("実測比較: エラーが発生しました。");
  }
}

searchBtn.addEventListener("click", async () => {
  const q = queryInput.value.trim();
  if (!q) {
    setStatus("地点名を入力してください");
    return;
  }
  try {
    setStatus("地点を検索中...");
    const hit = state.selectedPlace || (await geocode(q));
    queryInput.value = formatPlaceLabel(hit);
    clearSuggestions();
    run(hit.latitude, hit.longitude, `${formatPlaceLabel(hit)} (${hit.country || ""})`, hit.elevation);
  } catch (err) {
    setStatus(err.message || "検索に失敗しました");
  }
});

queryInput.addEventListener("input", () => {
  state.selectedPlace = null;
  const q = queryInput.value.trim();
  clearTimeout(suggestTimer);
  if (q.length < 2) {
    clearSuggestions();
    return;
  }
  suggestTimer = setTimeout(async () => {
    try {
      const hits = await geocodeCandidates(q);
      renderSuggestions(hits);
    } catch {
      clearSuggestions();
    }
  }, 250);
});

queryInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (!suggestionsEl.hidden && suggestionsEl.firstChild) {
    const firstBtn = suggestionsEl.querySelector(".suggestion-btn");
    if (firstBtn) {
      e.preventDefault();
      firstBtn.click();
      searchBtn.click();
    }
    return;
  }
  e.preventDefault();
  searchBtn.click();
});

queryInput.addEventListener("blur", () => {
  setTimeout(clearSuggestions, 120);
});

geoBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("このブラウザは位置情報に対応していません");
    return;
  }
  setStatus("現在地を取得中...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      run(pos.coords.latitude, pos.coords.longitude, "現在地", pos.coords.altitude);
    },
    () => {
      setStatus("位置情報の取得に失敗しました");
    },
    { timeout: 10000 },
  );
});

periodButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.period = btn.dataset.period;
    setActivePeriodButton(state.period);
    if (!state.lastLocation) {
      setStatus("地点を選択すると期間別の予報を表示できます。");
      return;
    }
    renderByPeriod();
  });
});
