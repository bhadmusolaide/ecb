const $ = (id) => document.getElementById(id);
let state = null;
let scope = "day";
let lastBias = null;
let selectedSymbol = "DXY";
let loading = false;

const fmt = (n, d = 2) =>
  n === null || n === undefined || Number.isNaN(n) ? "–" : Number(n).toFixed(d);
const pct = (n) =>
  n === null || n === undefined || Number.isNaN(n) ? "–" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const arrow = (n) => (n === null || n === undefined || Number.isNaN(n) ? "–" : n >= 0 ? "▲" : "▼");

function etTime(ts) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}
function etDay(ts) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ts));
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function setLoading(v) {
  loading = v;
  const el = $("loadstatus");
  el.textContent = v ? "● refreshing…" : "● live";
  el.className = `status ${v ? "loading" : "live"}`;
  el.title = v ? "Data refresh in progress" : "Data is current";
}

async function load() {
  setLoading(true);
  try {
    const res = await fetch("/api/state");
    state = await res.json();
    render();
  } catch (e) {
    $("clock").textContent = `offline: ${e.message}`;
    setLoading(false);
  } finally {
    setLoading(false);
  }
}

function renderSparkline(s) {
  const canvas = $("sparkline");
  const rangeEl = $("sparkrange");
  if (!canvas || !rangeEl) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--ac").trim();
  const yellow = style.getPropertyValue("--y").trim();
  const dpx = s.prices?.DXY;
  const hist = s.dxyHistory || [];
  if (!dpx || dpx.source === "unavailable" || !hist.length) {
    ctx.clearRect(0, 0, canvas.width || 300, canvas.height || 60);
    rangeEl.textContent = "no DXY data";
    return;
  }
  const w = canvas.clientWidth || 400;
  const h = canvas.clientHeight || 60;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  const pad = 4;
  const pts = hist.map((p) => ({ x: p.ts, y: p.price }));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const range = maxY - minY || 1;
  const t0 = pts[0].x;
  const t1 = pts[pts.length - 1].x;
  const span = t1 - t0 || 1;

  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.strokeStyle = dpx.source.includes("proxy") ? yellow : accent;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  pts.forEach((p, i) => {
    const x = pad + ((p.x - t0) / span) * (w - pad * 2);
    const y = h - pad - ((p.y - minY) / range) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const last = pts[pts.length - 1];
  const lx = pad + ((last.x - t0) / span) * (w - pad * 2);
  const ly = h - pad - ((last.y - minY) / range) * (h - pad * 2);
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fillStyle = dpx.source.includes("proxy") ? yellow : accent;
  ctx.fill();

  rangeEl.textContent = `DXY ${dpx.price.toFixed(3)} · low ${minY.toFixed(2)} · high ${maxY.toFixed(2)} · ${dpx.source.includes("proxy") ? "synthetic" : "live"}`;
}

function renderPrice(s) {
  const v = s.prices?.[selectedSymbol];
  const el = $("px").querySelector(".pxv");
  const elSrc = $("pxsrc");
  if (!v || v.source === "unavailable" || v.price <= 0) {
    el.textContent = `${selectedSymbol} —`;
    elSrc.textContent = `${selectedSymbol}: market closed`;
    return;
  }
  el.textContent = `${selectedSymbol} ${v.price.toFixed(3)} ${arrow(v.price)}`;
}

function render() {
  if (!state) return;
  const s = state;

  $("clock").textContent = `${s.etTime} · ${s.session.label} session (${s.session.start}–${s.session.end} ET) · ${s.session.note}`;
  $("updated").textContent = `updated ${new Date(s.updatedAt).toLocaleTimeString()}`;

  // symbol selector - only available symbols
  const sel = $("symbol");
  const hadListener = sel.dataset.listener === "1";
  sel.innerHTML = "";
  const available = Object.entries(s.prices || {}).filter(
    ([, v]) => v.source !== "unavailable" && v.price > 0,
  );
  for (const [key, v] of available) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = key;
    if (key === selectedSymbol) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!available.some(([k]) => k === selectedSymbol) && available.length > 0) {
    selectedSymbol = available[0][0];
  }
  $("j-inst").value = selectedSymbol;
  if (!hadListener) {
    sel.dataset.listener = "1";
    sel.addEventListener("change", (e) => {
      selectedSymbol = e.target.value;
      renderPrice(state);
      renderSparkline(state);
      $("j-inst").value = selectedSymbol;
    });
  }

  renderPrice(s);
  renderSparkline(s);
  const allPx = available.map(([k, v]) => `${k}: ${v.price.toFixed(3)}`).join("   ");
  const v = s.prices?.[selectedSymbol];
  const elSrc = $("pxsrc");
  elSrc.textContent = v && v.source !== "unavailable" ? `${allPx}  ·  ${selectedSymbol}: ${v.source}` : `${allPx}  ·  ${selectedSymbol}: market closed`;

  // bias (DXY-only engine)
  const biasEl = $("bias");
  biasEl.textContent = `${s.bias} (DXY)`;
  biasEl.className = `big ${s.bias.toLowerCase()} ${s.bias === "Bullish" ? "up" : s.bias === "Bearish" ? "dn" : "ne"}`;
  if (lastBias && lastBias !== s.bias) {
    biasEl.animate(
      [{ transform: "scale(1.05)", opacity: 0.5 }, { transform: "scale(1)", opacity: 1 }],
      { duration: 600 },
    );
  }
  lastBias = s.bias;

  const st = $("stance");
  st.textContent = `${s.stance} (Fed)`;
  st.className = `badge ${s.stance === "Hawkish" ? "hawk" : s.stance === "Dovish" ? "dove" : ""}`;
  st.title = s.stance === "Hawkish" ? "Hawkish policy stance — USD supportive"
    : s.stance === "Dovish" ? "Dovish policy stance — USD negative"
    : "Neutral policy stance";
  const rg = $("regime");
  rg.textContent = `${s.regime === "Choppy" ? "⚡ Choppy" : "📈 Trending"}`;
  rg.className = `badge ${s.regime === "Choppy" ? "chop" : ""}`;
  rg.title = s.regime === "Choppy" ? "Choppy regime — expect two-way risk"
    : "Trending regime — directional follow-through likely";

  $("confv").textContent = `${Math.round(s.confidence * 100)}%`;
  $("confbar").style.width = `${Math.round(s.confidence * 100)}%`;
  $("score").textContent = fmt(s.score);
  $("session").textContent = s.session.label;
  const nt = s.newsTilt ?? 0;
  $("newstilt").textContent =
    Math.abs(nt) < 0.05 ? "neutral" : nt > 0 ? `USD+ ${fmt(nt)}` : `USD- ${fmt(Math.abs(nt))}`;

  $("context").textContent = s.context || "";
  $("drivers").innerHTML = (s.drivers.length ? s.drivers : ["No released event is driving the bias yet."])
    .map((d) => `<div>${escapeHtml(d)}</div>`)
    .join("");
  $("conflicts").innerHTML = (s.conflicts || [])
    .map((c) => `<div>${escapeHtml(c)}</div>`)
    .join("");

  renderNext(s);
  renderCats(s);
  renderRecent(s);
  renderCalendar(s);
  renderNews(s);
  renderStats(s);
  $("sources").textContent = `calendar: ${s.sources.calendar} · price: ${JSON.stringify(s.sources.price)} · llm: ${s.sources.llm} · `;
}

function renderNext(s) {
  const box = $("nextevent");
  const ev = s.nextEvent;
  if (!ev) {
    box.innerHTML = `<div class="muted">No scheduled USD events in the feed.</div>`;
    return;
  }
  const pp = ev.preplan;
  box.innerHTML = `
    <div class="kv"><span class="lbl">${escapeHtml(ev.title)}</span><span class="val">${etDay(ev.ts)} ${etTime(ev.ts)} ET</span></div>
    <div class="kv"><span class="lbl">Countdown</span><span class="val">${s.countdown}</span></div>
    <div class="kv"><span class="lbl">Forecast / Previous</span><span class="val">${escapeHtml(
      ev.forecastRaw || "–",
    )} / ${escapeHtml(ev.previousRaw || "–")}</span></div>
    <div class="kv"><span class="lbl">Impact</span><span class="val">${escapeHtml(ev.impact)}</span></div>
    ${
      pp
        ? `<div class="plan">
             <div class="pt">Decision tree</div>
             <div class="tree">
               <div class="up">▲ Bullish if ${escapeHtml(pp.bullishIf)}</div>
               <div class="dn">▼ Bearish if ${escapeHtml(pp.bearishIf)}</div>
               <div class="mid">– Neutral if ${escapeHtml(pp.neutralIf)}</div>
             </div>
             <ul>${pp.watch.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
             <div class="muted" style="margin-top:6px">${escapeHtml(pp.expectedImpact)}</div>
           </div>`
        : ""
    }`;
}

function renderCats(s) {
  const entries = Object.entries(s.categoryScores || {}).filter(([, v]) => Math.abs(v) > 0.001);
  if (!entries.length) {
    $("cats").innerHTML = `<div class="muted">No category impulse yet.</div>`;
    return;
  }
  $("cats").innerHTML = entries
    .map(
      ([k, v]) =>
        `<div class="kv"><span class="lbl">${k}</span><span class="val ${v > 0 ? "hi" : "lo"} ${v > 0 ? "up" : "dn"}">${v >= 0 ? "+" : ""}${fmt(v)}</span></div>`,
    )
    .join("");
}

function renderRecent(s) {
  const recent = s.events
    .filter((e) => e.released && (e.impactScore ?? e.contribution ?? 0) !== 0)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8);
  if (!recent.length) {
    $("recent").innerHTML = `<div class="muted empty">No released USD events scored yet.</div>`;
    return;
  }
  $("recent").innerHTML = recent
    .map((e) => {
      const imp = e.impactScore ?? e.contribution ?? 0;
      const cls = imp > 0 ? "hi up" : "lo dn";
      return `<div class="kv">
        <span class="lbl">${etDay(e.ts)} ${etTime(e.ts)} · ${escapeHtml(e.title)}</span>
        <span class="val ${cls}">${imp > 0 ? "+" : ""}${fmt(imp)} · ${e.bias} ${arrow(imp)}</span>
      </div>`;
    })
    .join("");
}

function renderCalendar(s) {
  const now = Date.now();
  let evs = s.events;
  if (scope === "day") {
    evs = evs.filter((e) => e.ts > now - 12 * 3600000 && e.ts < now + 36 * 3600000);
  } else if (scope === "week") {
    evs = evs.filter((e) => e.ts > now && e.ts < now + 7 * 86400000);
  }
  const empty = $("calendar-empty");
  const tbl = $("calendar");
  if (!evs.length) {
    tbl.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  const rows = evs
    .sort((a, b) => a.ts - b.ts)
    .map((e) => {
      const imp = e.impactScore ?? e.contribution ?? 0;
      const arrowCls = !e.released
        ? "tag pending"
        : Math.abs(imp) < 0.005
          ? "tag mid"
          : imp > 0
            ? "tag up"
            : "tag dn";
      const arrowTxt = !e.released
        ? "pending"
        : Math.abs(imp) < 0.005
          ? "in line"
          : imp > 0
            ? `▲ ${e.bias} ${fmt(imp)}`
            : `▼ ${e.bias} ${fmt(imp)}`;
      const z = e.z === null || e.z === undefined ? "" : `<span class="tag">z ${fmt(e.z, 2)}</span>`;
      return `<tr class="impact-${escapeHtml(e.impact)}">
        <td><span class="evt">${etTime(e.ts)}</span><div class="muted" style="font-size:11px">${etDay(e.ts)}</div></td>
        <td style="text-align:left">${escapeHtml(e.title)}<span class="${arrowCls}">${arrowTxt}</span>${z}</td>
        <td>${escapeHtml(e.forecastRaw || "–")}</td>
        <td>${escapeHtml(e.previousRaw || "–")}</td>
        <td class="${e.actualRaw ? (e.contribution > 0 ? "hi up" : e.contribution < 0 ? "lo dn" : "") : ""}">${escapeHtml(
          e.actualRaw || "–",
        )}</td>
        <td>${e.surprisePct === null || e.surprisePct === undefined ? "–" : `${e.surprisePct >= 0 ? "+" : ""}${fmt(
          e.surprisePct,
          1,
        )}%`}</td>
      </tr>`;
    })
    .join("");
  tbl.innerHTML = `<div class="tblwrap"><table>
    <thead><tr><th>ET</th><th style="text-align:left">Event</th><th>Fcst</th><th>Prev</th><th>Actual</th><th>Surp</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderNews(s) {
  $("newssub").textContent = `${s.news.length} items · tier 1 = market-moving · tilt shows USD implication`;
  const newsBox = $("news");
  const empty = $("news-empty");
  if (!s.news.length) {
    newsBox.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  newsBox.innerHTML = s.news
    .slice(0, 60)
    .map((n) => {
      const tilt =
        n.tilt > 0
          ? `<span class="tilt1 up">▲ USD+</span>`
          : n.tilt < 0
            ? `<span class="tiltm1 dn">▼ USD-</span>`
            : `<span class="muted ne">– neutral</span>`;
      return `<div class="item tier${n.tier}">
        <div class="tt"><a href="${escapeAttr(n.link)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
          <div class="src">${escapeHtml(n.source)} · ${ago(n.ts)} · tier ${n.tier} · rel ${fmt(n.relevance, 2)}</div>
        </div>
        <div class="src" style="flex:0;text-align:right">${tilt}</div>
      </div>`;
    })
    .join("");
}

function renderStats(s) {
  const st = s.stats;
  if (!st) return;
  const empty = st.scored === 0 && st.calls === 0;
  const statsBox = $("stats");
  if (empty) {
    statsBox.innerHTML = `<div class="muted empty">No track record yet. Outcomes appear after logged calls are scored against DXY moves.</div>`;
    return;
  }
  statsBox.innerHTML = `
    <div class="kv"><span class="lbl">Calls logged</span><span class="val">${st.calls}</span></div>
    <div class="kv"><span class="lbl">Scored outcomes</span><span class="val">${st.scored}</span></div>
    <div class="kv"><span class="lbl">Hit rate</span><span class="val">${
      st.hitRate === null ? "–" : Math.round(st.hitRate * 100) + "%"
    }</span></div>
    ${
      st.byHorizon.length
        ? st.byHorizon
            .map(
              (h) =>
                `<div class="kv"><span class="lbl">${h.horizon}</span><span class="val ${h.rate >= 0.5 ? "hi up" : "lo dn"}">${h.hits}/${h.n} (${
                  h.n ? Math.round(h.rate * 100) : 0
                }%)</span></div>`,
            )
            .join("")
        : `<div class="muted">Outcomes appear once the DXY has moved after a logged call.</div>`
    }
    ${
      (s.calibration || []).length
        ? `<div class="muted" style="margin-top:8px">Learned weight adjustments (from the track record):</div>
           <div class="chips">${s.calibration
             .map(
               (c) =>
                 `<span class="chip ${c.multiplier >= 1 ? "pos up" : "neg dn"}">${c.canon} x${c.multiplier} (${c.hits}/${c.n})</span>`,
             )
             .join("")}</div>`
        : ""
    }
    ${
      st.byEvent.length
        ? `<div class="chips">${st.byEvent
            .map((e) => `<span class="chip ${e.rate >= 0.5 ? "pos up" : "neg dn"}">${e.canon} ${e.hits}/${e.n}</span>`)
            .join("")}</div>`
        : ""
    }`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// ---------- interactions ----------
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    for (const id of ["now", "calendar", "news", "journal"]) {
      $(`tab-${id}`).classList.toggle("hidden", id !== b.dataset.tab);
    }
  }),
);
document.querySelectorAll("[data-scope]").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("[data-scope]").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    scope = b.dataset.scope;
    if (state) renderCalendar(state);
  }),
);
$("refresh").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    await fetch("/api/refresh", { method: "POST" });
    await load();
  } finally {
    e.target.disabled = false;
  }
});
$("theme").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
  localStorage.setItem("ecb-theme", cur === "dark" ? "light" : "dark");
});
const savedTheme = localStorage.getItem("ecb-theme");
if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);

$("j-save").addEventListener("click", async () => {
  const body = {
    instrument: $("j-inst").value,
    bias: $("j-bias").value,
    note: $("j-note").value,
  };
  await fetch("/api/journal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  $("j-note").value = "";
  loadJournal();
});

async function loadJournal() {
  const res = await fetch("/api/journal");
  const j = await res.json();
  $("journal").innerHTML = (j.entries || [])
    .map(
      (e) =>
        `<div class="kv"><span class="lbl">${new Date(e.ts).toLocaleString()} · ${escapeHtml(e.instrument)} · ${escapeHtml(
          e.bias,
        )}</span><span class="val">${escapeHtml(e.note)}</span></div>`,
    )
    .join("");
}

load();
loadJournal();
setInterval(load, 15000);
setInterval(() => {
  if (state) {
    $("clock").textContent = `${state.etTime} · ${state.session.label} session (${state.session.start}–${state.session.end} ET) · ${state.session.note}`;
  }
}, 1000);
