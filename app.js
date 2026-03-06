const queryInput = document.getElementById("query");
const searchBtn = document.getElementById("searchBtn");
const geoBtn = document.getElementById("geoBtn");
const statusEl = document.getElementById("status");
const cardsEl = document.getElementById("cards");
const titleEl = document.getElementById("locationTitle");
const tpl = document.getElementById("cardTpl");

const RISK = {
  GOOD: { label: "散布向き", className: "risk-good" },
  OK: { label: "軽作業向き", className: "risk-ok" },
  BAD: { label: "注意", className: "risk-bad" },
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

function setStatus(text) {
  statusEl.textContent = text;
}

function render(data) {
  cardsEl.innerHTML = "";
  const now = Date.now();
  const maxMs = now + 48 * 60 * 60 * 1000;

  const rows = data.hourly.time
    .map((time, i) => ({ time, wind: data.hourly.wind_speed_10m[i] }))
    .filter((row) => {
      const t = new Date(row.time).getTime();
      return t >= now && t <= maxMs;
    });

  if (rows.length === 0) {
    setStatus("表示できる予報がありませんでした。");
    return;
  }

  const best = rows.filter((r) => judgeRisk(r.wind) === RISK.GOOD);
  setStatus(`48時間で「散布向き」は ${best.length} 時間あります。`);

  rows.forEach((row) => {
    const node = tpl.content.cloneNode(true);
    const risk = judgeRisk(row.wind);

    node.querySelector(".time").textContent = hourText(row.time);
    node.querySelector(".wind").textContent = `風速 ${row.wind.toFixed(1)} m/s`;
    const riskEl = node.querySelector(".risk");
    riskEl.textContent = risk.label;
    riskEl.classList.add(risk.className);

    cardsEl.appendChild(node);
  });
}

async function fetchForecast(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("hourly", "wind_speed_10m");
  url.searchParams.set("forecast_days", "3");
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
