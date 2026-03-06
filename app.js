const queryInput = document.getElementById("query");
const searchBtn = document.getElementById("searchBtn");
const geoBtn = document.getElementById("geoBtn");
const statusEl = document.getElementById("status");
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
};

const state = {
  period: "48h",
  lastLocation: null,
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

function render(data) {
  cardsEl.innerHTML = "";

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
  } catch (err) {
    setStatus(err.message || "エラーが発生しました");
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
