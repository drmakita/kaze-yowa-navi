const queryInput = document.getElementById("query");
const searchBtn = document.getElementById("searchBtn");
const geoBtn = document.getElementById("geoBtn");
const statusEl = document.getElementById("status");
const accuracyEl = document.getElementById("accuracy");
const cardsEl = document.getElementById("cards");
const titleEl = document.getElementById("locationTitle");
const tpl = document.getElementById("cardTpl");
const periodButtons = document.querySelectorAll(".period-btn");

const RISK = {
  GOOD: { label: "散布向き", className: "risk-good" },
  OK: { label: "軽作業向き", className: "risk-ok" },
  BAD: { label: "注意", className: "risk-bad" },
};

const PERIOD = {
  "48h": { label: "48時間", hours: 48 },
  "7d": { label: "1週間", hours: 24 * 7 },
  "30d": { label: "1ヶ月", days: 30 },
  past48h: { label: "過去48時間" },
};

const state = {
  period: "48h",
  lastLocation: null,
  pastComparisonRows: [],
  pastComparisonStation: null,
};

const cache = {
  amedasTable: null,
  amedasMapByKey: new Map(),
};

function judgeRisk(windMs) {
  if (windMs <= 2.5) return RISK.GOOD;
  if (windMs <= 4.0) return RISK.OK;
  return RISK.BAD;
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

function renderCard({ timeLabel, windLabel, risk }) {
  const node = tpl.content.cloneNode(true);
  node.querySelector(".time").textContent = timeLabel;
  node.querySelector(".wind").textContent = windLabel;
  const riskEl = node.querySelector(".risk");
  riskEl.textContent = risk.label;
  riskEl.classList.add(risk.className);
  cardsEl.appendChild(node);
}

function renderPastComparisonCards(rows) {
  cardsEl.innerHTML = "";
  rows.forEach((row) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <p class="time">${hourText(row.time)}</p>
      <p class="comparison-line">予測: ${row.forecast.toFixed(1)} m/s</p>
      <p class="comparison-line">実績: ${row.observed.toFixed(1)} m/s</p>
      <p class="comparison-diff">差分: ${row.diff.toFixed(1)} m/s</p>
    `;
    cardsEl.appendChild(card);
  });
}

function pickHourlyRows(data, hours) {
  const now = Date.now();
  const maxMs = now + hours * 60 * 60 * 1000;
  return data.hourly.time
    .map((time, i) => ({ time, wind: data.hourly.wind_speed_10m[i] }))
    .filter((row) => {
      const t = new Date(row.time).getTime();
      return t >= now && t <= maxMs;
    });
}

function pickDailyRows(data, days) {
  if (!data.daily || !data.daily.time || !data.daily.wind_speed_10m_max) return [];
  const now = Date.now();
  return data.daily.time
    .map((time, i) => ({ time, wind: data.daily.wind_speed_10m_max[i] }))
    .filter((row) => new Date(row.time).getTime() >= now - 24 * 60 * 60 * 1000)
    .slice(0, days);
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

function toDecimalDegree([deg, min]) {
  return deg + min / 60;
}

async function fetchAmedasTable() {
  if (cache.amedasTable) return cache.amedasTable;
  const res = await fetch("https://www.jma.go.jp/bosai/amedas/const/amedastable.json");
  if (!res.ok) throw new Error("アメダス地点情報の取得に失敗しました");
  cache.amedasTable = await res.json();
  return cache.amedasTable;
}

function findNearestAmedasStation(table, lat, lon) {
  let best = null;
  Object.entries(table).forEach(([id, row]) => {
    if (!row.lat || !row.lon) return;
    const stLat = toDecimalDegree(row.lat);
    const stLon = toDecimalDegree(row.lon);
    const distanceKm = haversineKm(lat, lon, stLat, stLon);
    if (!best || distanceKm < best.distanceKm) {
      best = {
        id,
        lat: stLat,
        lon: stLon,
        name: row.kjName || row.enName || id,
        distanceKm,
      };
    }
  });
  return best;
}

function toAmedasHourKey(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  return `${y}${m}${d}${h}00`;
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

async function renderObservedVsForecast(forecastData, lat, lon) {
  try {
    setAccuracy("実測比較（アメダス）を計算中...");
    const table = await fetchAmedasTable();
    const station = findNearestAmedasStation(table, lat, lon);
    if (!station || station.distanceKm > 200) {
      setAccuracy("実測比較: 近傍のアメダス観測所が見つかりませんでした。");
      state.pastComparisonRows = [];
      state.pastComparisonStation = null;
      if (state.period === "past48h") {
        setStatus("過去48時間比較: 近傍のアメダス観測所が見つかりませんでした。");
        cardsEl.innerHTML = "";
      }
      return;
    }

    const now = Date.now();
    const from = now - 48 * 60 * 60 * 1000;
    const points = forecastData.hourly.time
      .map((time, i) => ({ time, wind: forecastData.hourly.wind_speed_10m[i] }))
      .filter((row) => {
        const t = new Date(row.time).getTime();
        return t >= from && t <= now;
      });

    const keys = [...new Set(points.map((p) => toAmedasHourKey(new Date(p.time))))];
    await Promise.all(keys.map((key) => fetchAmedasMapByHourKey(key)));

    const diffs = [];
    const historyRows = [];
    points.forEach((p) => {
      const key = toAmedasHourKey(new Date(p.time));
      const mapData = cache.amedasMapByKey.get(key);
      const obsWind = mapData && mapData[station.id] && mapData[station.id].wind ? mapData[station.id].wind[0] : null;
      if (typeof obsWind === "number" && Number.isFinite(obsWind)) {
        const diff = Math.abs(p.wind - obsWind);
        diffs.push(diff);
        historyRows.push({
          time: p.time,
          forecast: p.wind,
          observed: obsWind,
          diff,
        });
      }
    });

    if (diffs.length === 0) {
      setAccuracy(`実測比較: ${station.name}（約${station.distanceKm.toFixed(1)}km）で一致時刻データを取得できませんでした。`);
      state.pastComparisonRows = [];
      state.pastComparisonStation = station;
      if (state.period === "past48h") {
        setStatus("過去48時間比較: 一致時刻の実測データを取得できませんでした。");
        cardsEl.innerHTML = "";
      }
      return;
    }

    const mae = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;
    setAccuracy(
      `実測比較（アメダス: ${station.name} 約${station.distanceKm.toFixed(1)}km）: 過去2日間 ${diffs.length}点の平均絶対誤差 ${mae.toFixed(2)} m/s`,
    );

    historyRows.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    state.pastComparisonRows = historyRows;
    state.pastComparisonStation = station;
    if (state.period === "past48h") {
      setStatus(`過去48時間比較（${station.name}）: ${historyRows.length}件`);
      renderPastComparisonCards(historyRows);
    }
  } catch (err) {
    setAccuracy("実測比較: 取得に失敗しました。");
    state.pastComparisonRows = [];
    state.pastComparisonStation = null;
    if (state.period === "past48h") {
      setStatus("過去48時間比較: 取得に失敗しました。");
      cardsEl.innerHTML = "";
    }
  }
}

function render(data) {
  cardsEl.innerHTML = "";

  if (state.period === "past48h") {
    if (state.pastComparisonRows.length > 0) {
      const name = state.pastComparisonStation ? state.pastComparisonStation.name : "最寄り観測所";
      setStatus(`過去48時間比較（${name}）: ${state.pastComparisonRows.length}件`);
      renderPastComparisonCards(state.pastComparisonRows);
    } else {
      setStatus("過去48時間の予測と実績を取得中...");
    }
    return;
  }

  if (state.period === "30d") {
    const rows = pickDailyRows(data, PERIOD["30d"].days);
    if (rows.length === 0) {
      setStatus("表示できる予報がありませんでした。");
      return;
    }

    const goodCount = rows.filter((r) => judgeRisk(r.wind) === RISK.GOOD).length;
    const note =
      rows.length < PERIOD["30d"].days
        ? `（API仕様により最大${rows.length}日分を表示）`
        : "";
    setStatus(`1ヶ月表示: 「散布向き」の日は ${goodCount} 日です。${note}`);

    rows.forEach((row) => {
      const risk = judgeRisk(row.wind);
      renderCard({
        timeLabel: dayText(row.time),
        windLabel: `日最大風速 ${row.wind.toFixed(1)} m/s`,
        risk,
      });
    });
    return;
  }

  const rows = pickHourlyRows(data, PERIOD[state.period].hours);

  if (rows.length === 0) {
    setStatus("表示できる予報がありませんでした。");
    return;
  }

  const goodCount = rows.filter((r) => judgeRisk(r.wind) === RISK.GOOD).length;
  setStatus(`${PERIOD[state.period].label}で「散布向き」は ${goodCount} 時間あります。`);

  rows.forEach((row) => {
    const risk = judgeRisk(row.wind);
    renderCard({
      timeLabel: hourText(row.time),
      windLabel: `風速 ${row.wind.toFixed(1)} m/s`,
      risk,
    });
  });
}

async function fetchForecast(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("hourly", "wind_speed_10m");
  url.searchParams.set("daily", "wind_speed_10m_max");
  url.searchParams.set("past_days", "2");
  url.searchParams.set("forecast_days", "16");
  url.searchParams.set("timezone", "auto");

  const res = await fetch(url);
  if (!res.ok) throw new Error("予報データの取得に失敗しました");
  return res.json();
}

async function geocode(name) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", name);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "ja");

  const res = await fetch(url);
  if (!res.ok) throw new Error("地点検索に失敗しました");
  const data = await res.json();
  if (!data.results || data.results.length === 0) {
    throw new Error("地点が見つかりませんでした");
  }
  return data.results[0];
}

async function run(lat, lon, title) {
  try {
    setStatus("予報データを取得中...");
    cardsEl.innerHTML = "";
    titleEl.textContent = title;
    state.lastLocation = { lat, lon, title };
    const forecast = await fetchForecast(lat, lon);
    render(forecast);
    renderObservedVsForecast(forecast, lat, lon);
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
    const hit = await geocode(q);
    run(hit.latitude, hit.longitude, `${hit.name} (${hit.country || ""})`);
  } catch (err) {
    setStatus(err.message || "検索に失敗しました");
  }
});

geoBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("このブラウザは位置情報に対応していません");
    return;
  }
  setStatus("現在地を取得中...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      run(pos.coords.latitude, pos.coords.longitude, "現在地");
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
    run(state.lastLocation.lat, state.lastLocation.lon, state.lastLocation.title);
  });
});
