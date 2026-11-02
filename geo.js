/* 필름정리 · 위치 / 컷 기록 / 지도 / 스캔 EXIF
   index.html의 전역(state, LS, $, esc, pad, render, post, applySnap, typeOf, dayLabel 등)을 씁니다. */

/* ---------- 위치 ---------- */
const Geo = {
  fix: null, watch: null, err: "", users: 0, listeners: new Set(),
  start(fn) {
    if (fn) this.listeners.add(fn);
    this.users++;
    if (this.watch !== null || !navigator.geolocation) { if (!navigator.geolocation) this.err = "이 기기에서는 위치를 쓸 수 없어요."; this.emit(); return; }
    this.err = "";
    this.watch = navigator.geolocation.watchPosition(
      p => { this.fix = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: p.coords.accuracy, t: Date.now() }; this.err = ""; this.emit(); },
      e => { this.err = e.code === 1 ? "위치 권한이 꺼져 있어요. 설정 → 사파리(또는 필름정리) → 위치에서 허용해 주세요." : "위치를 아직 못 잡았어요."; this.emit(); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  },
  stop(fn) {
    if (fn) this.listeners.delete(fn);
    this.users = Math.max(0, this.users - 1);
    if (!this.users && this.watch !== null) { navigator.geolocation.clearWatch(this.watch); this.watch = null; }
  },
  emit() { this.listeners.forEach(f => { try { f(this.fix) } catch (e) {} }); },
  fresh() { return this.fix && Date.now() - this.fix.t < 120000 ? this.fix : null; }
};

// 좌표 → 장소 이름 (OpenStreetMap). 같은 곳(약 150m 안)은 다시 묻지 않음
const Place = {
  cache: LS.get("placeCache2", []), last: 0, busy: null,
  dist(a, b) { const R = 6371000, r = x => x * Math.PI / 180; const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); },
  near(p) { const hit = this.cache.find(c => this.dist(c, p) < 150); return hit ? hit.name : ""; },
  async name(p) {
    const n = this.near(p); if (n) return n;
    if (this.busy) await this.busy.catch(() => {});
    const again = this.near(p); if (again) return again;
    const wait = Math.max(0, 1100 - (Date.now() - this.last));
    this.busy = (async () => {
      await new Promise(r => setTimeout(r, wait)); this.last = Date.now();
      const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lng}&zoom=17&addressdetails=1&accept-language=ko`;
      const j = await (await fetch(u)).json();
      const a = j.address || {};
      const area = [a.borough || a.city_district || a.county || a.city || a.town, a.quarter || a.neighbourhood || a.suburb || a.village || a.hamlet].filter(Boolean);
      // 길 이름은 빼고, 역·공원·카페 같은 장소 이름만 앞에 붙임
      const poi = j.name && /^(amenity|tourism|leisure|historic|shop|railway|natural|aeroway|building)$/.test(j.category || "") && !area.includes(j.name) ? j.name : "";
      const name = [...new Set([...(poi ? [poi] : []), ...area])].slice(0, 2).join(" ") || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
      this.cache.unshift({ lat: p.lat, lng: p.lng, name }); this.cache = this.cache.slice(0, 200);
      try { LS.set("placeCache2", this.cache) } catch (e) {}
      return name;
    })();
    return this.busy;
  }
};

/* ---------- 컷 기록: 먼저 폰에 저장하고, 시트로 차례대로 보냄 ---------- */
const Frames = {
  queue: LS.get("fq", []), sending: false,
  save() { try { LS.set("fq", this.queue) } catch (e) {} },
  all(logId) {
    const server = (state.frames || []).filter(f => !logId || f.logId === logId);
    const ids = new Set(this.queue.map(f => f.id));
    return [...server.filter(f => !ids.has(f.id)), ...this.queue.filter(f => !logId || f.logId === logId).map(f => ({ ...f, local: true }))]
      .sort((a, b) => a.n - b.n || (a.at < b.at ? -1 : 1));
  },
  shots(logId) { return this.all(logId).filter(f => (f.kind || "frame") === "frame"); },
  points(logId) { return this.all(logId).filter(f => f.kind && f.kind !== "frame").sort((a, b) => a.at < b.at ? -1 : 1); },
  lastN(logId) { const s = this.shots(logId); return s.length ? Math.max(...s.map(f => f.n)) : 0; },
  // n번 컷의 위치: 찰칵 기록 → 그 컷이 속한 구간(체크인·사진) → 없음
  resolve(logId, n) {
    const shot = this.shots(logId).find(f => f.n === n);
    if (shot && shot.lat) return { ...shot, src: "shot" };
    const seg = this.points(logId).filter(p => p.start != null && p.start !== "" && +p.start <= n)
      .sort((a, b) => +a.start - +b.start || (a.at < b.at ? -1 : 1)).pop();
    if (seg) return { n, at: shot ? shot.at : seg.at, lat: seg.lat, lng: seg.lng, acc: seg.acc, place: seg.place,
      ap: shot ? shot.ap : "", ss: shot ? shot.ss : "", note: shot ? shot.note : "", src: seg.kind };
    return shot ? { ...shot, src: "shot" } : null;
  },
  put(f) { const i = this.queue.findIndex(x => x.id === f.id); if (i >= 0) this.queue[i] = f; else this.queue.push(f); this.save(); this.flush(); },
  async flush() {
    if (this.sending || !this.queue.length || !state.canUse) return;
    this.sending = true; Shoot.paint();
    const batch = this.queue.slice(0, 20);
    try {
      const j = await post({ action: "frames", frames: batch });
      const sent = new Set(batch.map(f => f.id));
      // 보내는 동안 바뀐 컷은 남겨 둠
      this.queue = this.queue.filter(f => !sent.has(f.id) || batch.find(b => b.id === f.id) !== f);
      this.save(); applySnap(j);
    } catch (e) { this.failed = Date.now(); }
    finally { this.sending = false; Shoot.paint(); if (this.queue.length && Date.now() - (this.failed || 0) > 5000) setTimeout(() => this.flush(), 300); }
  }
};
window.addEventListener("online", () => Frames.flush());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") Frames.flush(); });

// 롤의 장소 요약: 컷이 있으면 컷 장소들, 없으면 롤 장소
function placesOf(l) {
  const fr = [...Frames.shots(l.id), ...Frames.points(l.id)].map(f => f.place).filter(Boolean);
  const uniq = [...new Set(fr)];
  if (!uniq.length) return l.place || "";
  return uniq.length === 1 ? uniq[0] : `${uniq[0]} 외 ${uniq.length - 1}곳`;
}

/* ---------- 촬영 화면 ---------- */
const APS_ALL = ["1", "1.2", "1.4", "1.7", "1.8", "2", "2.4", "2.8", "3.5", "4", "4.5", "5.6", "6.3", "8", "9.5", "11", "13", "16", "22", "32", "45", "64"];
const APS_COMMON = ["1.4", "2", "2.8", "4", "5.6", "8", "11", "16"];
const SSS_ALL = ["1/8000", "1/4000", "1/2000", "1/1000", "1/500", "1/250", "1/125", "1/60", "1/30", "1/15", "1/8", "1/4", "1/2", "1s", "2s", "4s", "8s", "15s", "30s", "B"];
const SSS_COMMON = ["1/1000", "1/500", "1/250", "1/125", "1/60", "1/30", "1/15", "1s", "B"];
const ssLabel = v => /^\d+s$/.test(v) ? v.replace("s", "초") : v;
// 여러 롤을 동시에 촬영 중일 수 있음 (카메라 여러 대, 한 롤을 며칠에 나눠 찍기)
const rollLabel = l => `${l.cam ? l.cam + " · " : ""}${l.brand} ${l.name || l.iso}`.trim();
const Active = {
  ids() {
    let a = LS.get("activeRolls", null);
    if (!Array.isArray(a)) { const old = LS.get("activeRoll", null); a = old ? [old] : []; LS.set("activeRolls", a); }
    return a;
  },
  list() { return this.ids().map(id => state.logs.find(l => l.id === id)).filter(l => l && (l.stage || "shot") === "shot"); },
  add(id) { const a = this.ids().filter(x => x !== id); a.push(id); LS.set("activeRolls", a); LS.set("currentRoll", id); },
  remove(id) { LS.set("activeRolls", this.ids().filter(x => x !== id)); }
};
const Shoot = {
  logId: null, sel: LS.get("shootSel", { ap: "", ss: "" }), flash: 0,
  open(logId) {
    logId = logId || LS.get("currentRoll", null) || (Active.list()[0] || {}).id;
    if (!logId) return;
    this.logId = logId; Active.add(logId);
    $("shoot").hidden = false; document.body.classList.add("lock");
    Geo.start(this.onFix); this.paint();
  },
  switchTo(id) { this.logId = id; LS.set("currentRoll", id); this.issued = null; this.paint(); },
  close() { this.issued = null; $("shoot").hidden = true; document.body.classList.remove("lock"); Geo.stop(this.onFix); this.logId = null; render(); },
  end() {
    Active.remove(this.logId); this.issued = null;
    const rest = Active.list();
    if (rest.length) this.switchTo(rest[rest.length - 1].id); else this.close();
  },
  async setCam() {
    const v = ($("sh-cam") && $("sh-cam").value.trim()) || ""; if (!v) return;
    try { applySnap(await post({ action: "update", id: this.logId, fields: { cam: v } })); } catch (e) { setAction(`<span class="msg">카메라를 저장하지 못했어요.</span>`); }
    this.paint();
  },
  skip() {
    const l = this.log(); if (!l) return;
    const n = Frames.lastN(l.id) + 1;
    Frames.put({ kind: "frame", id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), logId: l.id, n, at: new Date().toISOString(),
      lat: null, lng: null, acc: null, place: "", ap: "", ss: "", note: "[건너뜀]" });
    this.paint();
  },
  onFix: () => Shoot.paint(),
  log() { return state.logs.find(l => l.id === this.logId); },
  async snap() {
    const l = this.log(); if (!l) return;
    const n = Frames.lastN(l.id) + 1;
    const fix = Geo.fresh();
    const f = { id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), logId: l.id, n, at: new Date().toISOString(),
      lat: fix ? fix.lat : null, lng: fix ? fix.lng : null, acc: fix ? fix.acc : null, place: fix ? Place.near(fix) : "",
      ap: this.sel.ap, ss: this.sel.ss, note: ($("sh-note") && $("sh-note").value.trim()) || "", kind: "frame" };
    if ($("sh-note")) $("sh-note").value = "";
    this.flash = Date.now(); Frames.put(f); this.paint();
    if (fix && !f.place) {
      try { const name = await Place.name(fix); const cur = Frames.queue.find(x => x.id === f.id) || (state.frames || []).find(x => x.id === f.id);
        if (cur) { Frames.put({ ...cur, local: undefined, place: name }); this.paint(); } } catch (e) {}
    }
  },
  setSel(k, v) {
    this.sel[k] = this.sel[k] === v ? "" : v; LS.set("shootSel", this.sel);
    if (this.sel[k]) { const key = k === "ap" ? "recentAp" : "recentSs"; LS.set(key, [v, ...LS.get(key, []).filter(x => x !== v)].slice(0, 3)); }
    this.paint();
  },
  expand: { ap: false, ss: false },
  // 장소가 바뀔 때 한 번: 다음 컷부터 이 장소
  async checkin() {
    const l = this.log(); if (!l) return;
    const fix = Geo.fresh();
    if (!fix) { this.msg = Geo.err || "위치를 아직 못 잡았어요. 잠시 뒤 다시 눌러 주세요."; this.paint(); return; }
    const p = { id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), logId: l.id, kind: "checkin", n: 0, start: Frames.lastN(l.id) + 1,
      at: new Date().toISOString(), lat: fix.lat, lng: fix.lng, acc: fix.acc, place: Place.near(fix), ap: "", ss: "", note: "" };
    this.msg = ""; Frames.put(p); this.paint();
    if (!p.place) { try { const name = await Place.name(fix); const cur = Frames.queue.find(x => x.id === p.id) || (state.frames || []).find(x => x.id === p.id);
      if (cur) { Frames.put({ ...cur, local: undefined, place: name }); this.paint(); } } catch (e) {} }
  },
  paint() {
    const box = $("shoot"); if (!box || box.hidden) { paintPill(); return; }
    const l = this.log();
    if (!l) { box.innerHTML = `<div class="sh-top"><button class="navbtn" data-x>닫기</button></div><p class="empty">이 롤 기록을 찾지 못했어요.</p>`; return; }
    const fr = Frames.shots(l.id), n = Frames.lastN(l.id), pts = Frames.points(l.id);
    const fix = Geo.fresh(), wait = Frames.queue.filter(f => f.logId === l.id).length;
    const loc = Geo.err ? `<span class="bad">${esc(Geo.err)}</span>` : fix ? `${esc(Place.near(fix) || "위치 잡음")} <em>±${Math.round(fix.acc)}m</em>` : "위치 찾는 중…";
    const chips = (k, all, common) => {
      const recent = LS.get(k === "ap" ? "recentAp" : "recentSs", []);
      const set = this.expand[k] ? all : all.filter(v => common.includes(v) || recent.includes(v) || this.sel[k] === v);
      return `<div class="sh-chips">${set.map(v => `<button data-sel="${k}" data-v2="${v}" aria-pressed="${this.sel[k] === v}">${k === "ap" ? "f/" + v : ssLabel(v)}</button>`).join("")}<button class="more" data-expand="${k}">${this.expand[k] ? "접기" : "전체"}</button></div>`;
    };
    const old = $("sh-note"), keep = old ? old.value : "", focused = old && document.activeElement === old;
    const act = Active.list();
    const tabs = `<div class="sh-rolls">${act.map(a => `<button data-rolltab="${esc(a.id)}" aria-pressed="${a.id === l.id}"><b>${esc(a.cam || "카메라 미정")}</b><span>${esc(a.brand)} ${esc(a.name || a.iso)} · ${Frames.shots(a.id).length}컷</span></button>`).join("")}<button class="sh-add" data-addroll><b>+</b><span>롤 추가</span></button></div>`;
    box.innerHTML = `
      <div class="sh-top"><button class="navbtn" data-x>닫기</button><button class="navbtn" data-endroll>이 롤 촬영 종료</button></div>
      ${tabs}
      ${this.issued === l.no ? `<div class="sh-issued">새로 시작한 롤<b>${esc(l.brand)} ${esc(l.name || l.iso)}</b><span>필름 통에 <em>${esc(l.no)}</em>라고 적어 두면 나중에 찾기 쉬워요</span></div>` : ""}
      <div class="sh-head"><b>${esc(l.brand)} ${esc(l.name || l.iso)}</b><span>${esc(l.cam || "카메라 미정")}${l.ei ? ` · EI ${esc(l.ei)}` : ""} · <span class="no">${esc(l.no)}</span></span></div>
      ${l.cam ? "" : `<div class="sh-cam"><input id="sh-cam" placeholder="이 롤을 넣은 카메라 (예: FM2)" list="sh-cams" autocomplete="off"><button class="act" data-setcam>저장</button><datalist id="sh-cams">${[...new Set(state.logs.map(x => x.cam).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join("")}</datalist></div>`}
      <div class="sh-count"><b>${n}</b><span>컷</span></div>
      <div class="sh-loc">${loc}</div>
      <button class="sh-btn${Date.now() - this.flash < 400 ? " hit" : ""}" data-snap aria-label="${n + 1}번 컷 기록">찰칵</button>
      <div class="sh-sub">${n + 1}번 컷을 찍을 때 누르세요</div>
      <div class="sh-row2"><button class="act quiet" data-checkin>여기서 찍는 중</button><button class="act quiet" data-skip>이 컷 건너뛰기</button></div>
      ${this.msg ? `<div class="sh-sub bad">${esc(this.msg)}</div>` : ""}
      ${chips("ap", APS_ALL, APS_COMMON)}${chips("ss", SSS_ALL, SSS_COMMON)}
      <input id="sh-note" class="sh-note" placeholder="이 컷 메모 (선택)" autocomplete="off">
      <div class="sh-sync">${wait ? (Frames.sending ? `${wait}컷 시트로 보내는 중…` : `${wait}컷 폰에 저장됨 · 연결되면 시트로 보내요`) : fr.length ? "모든 컷이 시트에 저장됐어요" : ""}</div>
      <ul class="sh-list">${[...fr, ...pts].sort((a, b) => a.at < b.at ? 1 : -1).map(f => f.kind && f.kind !== "frame"
        ? `<li class="pt"><b>${f.kind === "photo" ? "사진" : "장소"}</b><span>${new Date(f.at).toTimeString().slice(0, 5)} · ${esc(f.place || "위치 있음")} · ${f.start ? `${f.start}번 컷부터` : "구간 미정"}</span><button class="act quiet" data-fdel="${esc(f.id)}">지우기</button></li>`
        : `<li><b>${f.n}</b><span>${new Date(f.at).toTimeString().slice(0, 5)} · ${f.note === "[건너뜀]" ? "건너뜀" : esc(f.place || (f.lat ? "위치 있음" : "위치 없음"))}${f.ap ? ` · f/${esc(f.ap)}` : ""}${f.ss ? ` · ${esc(f.ss)}` : ""}${f.note && f.note !== "[건너뜀]" ? ` · ${esc(f.note)}` : ""}</span><button class="act quiet" data-fdel="${esc(f.id)}">지우기</button></li>`).join("")}</ul>`;
    this.msg = "";
    const nn = $("sh-note"); if (nn) { nn.value = keep; if (focused) nn.focus({ preventScroll: true }); }
    paintPill();
  },
  async del(id) {
    const qi = Frames.queue.findIndex(f => f.id === id);
    if (qi >= 0 && !(state.frames || []).some(f => f.id === id)) { Frames.queue.splice(qi, 1); Frames.save(); this.paint(); return; }
    try { applySnap(await post({ action: "frameDelete", id })); } catch (e) { setAction(`<span class="msg">컷을 지우지 못했어요. 연결을 확인해 주세요.</span>`); }
    this.paint();
  }
};

// 촬영 중인 롤이 있으면 화면 아래에 바로가기
function paintPill() {
  const pill = $("rollpill"); if (!pill) return;
  const act = Active.list();
  if (!act.length || !$("shoot").hidden) { pill.hidden = true; return; }
  const cur = act.find(l => l.id === LS.get("currentRoll", null)) || act[act.length - 1];
  pill.hidden = false;
  pill.innerHTML = `<button data-shoot="${esc(cur.id)}">촬영 중 · <b>${esc(rollLabel(cur))}</b>${act.length > 1 ? ` 외 ${act.length - 1}롤` : ` · ${Frames.shots(cur.id).length}컷`}</button>`;
}

/* ---------- 지도 ---------- */
let mapObj = null;
function loadOnce(src, css) {
  return new Promise((res, rej) => {
    if (css && !document.querySelector(`link[href="${css}"]`)) { const k = document.createElement("link"); k.rel = "stylesheet"; k.href = css; document.head.appendChild(k); }
    if (document.querySelector(`script[src="${src}"]`)) { const t = setInterval(() => { if (window.L || window.piexif) { clearInterval(t); res() } }, 50); setTimeout(() => clearInterval(t), 10000); return; }
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
async function drawMap() {
  const el = $("map"); if (!el) return;
  try { await loadOnce("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"); }
  catch (e) { el.innerHTML = `<p class="empty">지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.</p>`; return; }
  if (mapObj) { mapObj.remove(); mapObj = null; }
  const focus = state.mapFocus, logs = state.logs.filter(l => !focus || l.id === focus);
  const pts = [];
  mapObj = L.map(el, { zoomControl: false, attributionControl: true });
  // 지도 바탕: OpenStreetMap (키 필요 없음). 다크 모드는 CSS로 어둡게 바꿈
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapObj);
  logs.forEach(l => {
    const color = getComputedStyle(document.documentElement).getPropertyValue(typeOf(l.type).c.replace(/var\((.+)\)/, "$1")).trim() || "#8E8E93";
    Frames.points(l.id).filter(p => p.lat && p.lng).forEach(p => {
      pts.push([+p.lat, +p.lng]);
      L.circleMarker([+p.lat, +p.lng], { radius: 7, color, weight: 3, dashArray: "3 3", fillColor: "#fff", fillOpacity: .9 })
        .bindPopup(`<b>${esc(rollLabel(l))}</b><br>${p.kind === "photo" ? "아이폰 사진" : "체크인"} · ${dayLabel(p.at)} ${new Date(p.at).toTimeString().slice(0, 5)}${p.place ? `<br>${esc(p.place)}` : ""}${p.start ? `<br>${p.start}번 컷부터` : ""}`).addTo(mapObj);
    });
    const fr = Frames.shots(l.id).filter(f => f.lat && f.lng);
    if (fr.length) {
      const line = fr.map(f => [+f.lat, +f.lng]);
      if (focus && line.length > 1) L.polyline(line, { color, weight: 3, opacity: .6 }).addTo(mapObj);
      fr.forEach(f => {
        pts.push([+f.lat, +f.lng]);
        L.circleMarker([+f.lat, +f.lng], { radius: focus ? 9 : 6, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 })
          .bindPopup(`<b>${esc(rollLabel(l))} · ${f.n}번 컷</b><br>${dayLabel(f.at)} ${new Date(f.at).toTimeString().slice(0, 5)}${f.place ? `<br>${esc(f.place)}` : ""}`)
          .addTo(mapObj);
        if (focus) L.marker([+f.lat, +f.lng], { icon: L.divIcon({ className: "fnum", html: String(f.n), iconSize: [18, 18] }) }).addTo(mapObj);
      });
    } else if (l.lat && l.lng && !Frames.points(l.id).some(p => p.lat)) {
      pts.push([+l.lat, +l.lng]);
      L.circleMarker([+l.lat, +l.lng], { radius: 8, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 })
        .bindPopup(`<b>${esc(l.no)}</b><br>${esc(l.brand)} ${esc(l.name || l.iso)}<br>${dayLabel(l.at)}${l.place ? `<br>${esc(l.place)}` : ""}`).addTo(mapObj);
    }
  });
  if (pts.length) mapObj.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
  else { mapObj.setView([37.5665, 126.978], 11); }
  const c = $("mapnote"); if (c) c.textContent = pts.length ? `${pts.length}곳` : "아직 위치가 남은 기록이 없어요.";
}

// 화면 모드가 바뀌면 지도도 다시 그림
try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if ($("map")) drawMap(); }); } catch (e) {}

/* ---------- 스캔에 위치 넣기 (EXIF) ---------- */
const Exif = {
  logId: null, files: [], offset: 1, out: [], busy: false, msg: "",
  open(id) { this.logId = id; this.files = []; this.out = []; this.offset = 1; this.msg = ""; $("exif").hidden = false; document.body.classList.add("lock"); this.paint(); },
  close() { $("exif").hidden = true; document.body.classList.remove("lock"); this.files = []; this.out = []; },
  frameFor(i) { return Frames.resolve(this.logId, i + this.offset); },
  paint() {
    const l = state.logs.find(x => x.id === this.logId), box = $("exif"); if (!box || box.hidden) return;
    if (!l) { box.innerHTML = `<div class="sh-top"><button class="navbtn" data-xx>닫기</button></div>`; return; }
    const fr = Frames.shots(l.id);
    box.innerHTML = `
      <div class="sh-top"><button class="navbtn" data-xx>닫기</button></div>
      <h2 class="ex-title">스캔에 위치 넣기</h2>
      <p class="ex-sub"><span class="no">${esc(l.no)}</span> ${esc(l.brand)} ${esc(l.name || l.iso)} · 컷 기록 ${fr.length}개</p>
      <label class="rowbtn ex-pick">스캔 JPG 고르기<input id="ex-files" type="file" accept="image/jpeg,.jpg,.jpeg" multiple hidden></label>
      ${this.files.length ? `
        <div class="ex-off"><span>첫 번째 파일은</span><button class="pick" data-off="-1">−</button><b>${this.offset}번 컷</b><button class="pick" data-off="1">+</button></div>
        <p class="ex-hint">파일 이름 순서대로 컷을 맞춰요. 스캔에 0번이나 00번 컷이 섞여 있으면 위 숫자로 맞추세요.</p>
        <ul class="ex-list">${this.files.map((f, i) => { const m = this.frameFor(i);
          return `<li><span class="fn">${esc(f.name)}</span><span class="${m && m.lat ? "" : "miss"}">${m ? `${m.n}번 컷 · ${new Date(m.at).toTimeString().slice(0, 5)}${m.place ? " · " + esc(m.place) : ""}${m.src === "checkin" ? " · 구간(장소)" : m.src === "photo" ? " · 구간(사진)" : ""}${!m.lat ? (m.note === "[건너뜀]" ? " · 건너뜀" : " · 위치 없음") : ""}` : "맞는 컷 없음 · 그대로 둠"}</span></li>`; }).join("")}</ul>
        <div class="btns">${this.out.length ? `<button class="rowbtn" data-exshare>사진에 저장 (${this.out.length}장)</button>` : `<button class="rowbtn" data-exrun ${this.busy ? "disabled" : ""}>${this.busy ? "넣는 중…" : "위치와 촬영 시간 넣기"}</button>`}</div>` : `<p class="ex-hint">현상소에서 받은 JPG를 고르면, 촬영할 때 남긴 컷 기록으로 GPS·촬영 시간·필름 정보를 파일 안에 넣어 드려요. 원본은 바뀌지 않고 새 파일이 만들어져요.</p>`}
      ${this.msg ? `<p class="ex-hint">${this.msg}</p>` : ""}`;
  },
  setFiles(list) {
    const coll = new Intl.Collator("ko", { numeric: true });
    this.files = [...list].filter(f => /jpe?g$/i.test(f.name) || f.type === "image/jpeg").sort((a, b) => coll.compare(a.name, b.name));
    this.out = []; this.msg = list.length !== this.files.length ? "JPG가 아닌 파일은 뺐어요. TIFF는 아직 지원하지 않아요." : ""; this.paint();
  },
  async run() {
    if (this.busy) return; this.busy = true; this.paint();
    try { await loadOnce("https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js"); }
    catch (e) { this.busy = false; this.msg = "EXIF 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요."; this.paint(); return; }
    const l = state.logs.find(x => x.id === this.logId), out = [];
    const ascii = s => String(s || "").replace(/[^\x20-\x7E]/g, "").trim();
    const dms = v => { v = Math.abs(v); const d = Math.floor(v), m = Math.floor((v - d) * 60), s = Math.round(((v - d) * 60 - m) * 60 * 100); return [[d, 1], [m, 1], [s, 100]]; };
    const exifTime = iso => { const d = new Date(iso); return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
    const tz = (() => { const o = -new Date().getTimezoneOffset(); return `${o >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`; })();
    let done = 0, tagged = 0;
    for (let i = 0; i < this.files.length; i++) {
      const file = this.files[i], f = this.frameFor(i);
      try {
        const bin = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsBinaryString(file); });
        let ex; try { ex = piexif.load(bin); } catch (e) { ex = { "0th": {}, Exif: {}, GPS: {}, "1st": {}, thumbnail: null }; }
        ex["0th"] = ex["0th"] || {}; ex.Exif = ex.Exif || {}; ex.GPS = {};
        const desc = ascii(`${l.no} #${f ? f.n : "?"} ${l.brand} ${l.name || ""} ${l.ei || l.iso ? "EI " + (l.ei || l.iso) : ""}`);
        ex["0th"][piexif.ImageIFD.ImageDescription] = desc;
        if (ascii(l.cam)) ex["0th"][piexif.ImageIFD.Model] = ascii(l.cam);
        if (f) {
          const t = exifTime(f.at);
          ex["0th"][piexif.ImageIFD.DateTime] = t;
          ex.Exif[piexif.ExifIFD.DateTimeOriginal] = t; ex.Exif[piexif.ExifIFD.DateTimeDigitized] = t;
          ex.Exif[piexif.ExifIFD.OffsetTimeOriginal] = tz;
          const iso = parseInt(l.ei || l.iso, 10); if (iso) ex.Exif[piexif.ExifIFD.ISOSpeedRatings] = iso;
          if (f.ap) ex.Exif[piexif.ExifIFD.FNumber] = [Math.round(parseFloat(f.ap) * 10), 10];
          if (f.ss && /^1\/(\d+)$/.test(f.ss)) ex.Exif[piexif.ExifIFD.ExposureTime] = [1, +RegExp.$1];
          else if (f.ss && /^(\d+)s$/.test(f.ss)) ex.Exif[piexif.ExifIFD.ExposureTime] = [+RegExp.$1, 1];
          if (f.lat && f.lng) {
            const lat = +f.lat, lng = +f.lng;
            ex.GPS[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
            ex.GPS[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? "N" : "S"; ex.GPS[piexif.GPSIFD.GPSLatitude] = dms(lat);
            ex.GPS[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? "E" : "W"; ex.GPS[piexif.GPSIFD.GPSLongitude] = dms(lng);
            if (f.acc) ex.GPS[piexif.GPSIFD.GPSHPositioningError] = [Math.round(+f.acc * 10), 10];
            const u = new Date(f.at);
            ex.GPS[piexif.GPSIFD.GPSDateStamp] = `${u.getUTCFullYear()}:${pad(u.getUTCMonth() + 1)}:${pad(u.getUTCDate())}`;
            ex.GPS[piexif.GPSIFD.GPSTimeStamp] = [[u.getUTCHours(), 1], [u.getUTCMinutes(), 1], [u.getUTCSeconds(), 1]];
            tagged++;
          }
        }
        let bytes; try { bytes = piexif.dump(ex); } catch (e) { delete ex.thumbnail; ex["1st"] = {}; bytes = piexif.dump(ex); }
        const res = piexif.insert(bytes, bin);
        const arr = new Uint8Array(res.length); for (let k = 0; k < res.length; k++) arr[k] = res.charCodeAt(k) & 255;
        const name = `${l.no}_${f ? pad(f.n) : "x" + (i + 1)}.jpg`;
        out.push(new File([arr], name, { type: "image/jpeg" }));
      } catch (e) { this.msg = `${esc(file.name)}은(는) 읽지 못해서 뺐어요.`; }
      done++; if (done % 3 === 0) { this.msg = `${done}/${this.files.length}장 처리 중…`; this.paint(); }
    }
    this.out = out; this.busy = false;
    this.msg = `${out.length}장 완료 · 위치가 들어간 사진 ${tagged}장. 아래 버튼을 눌러 사진 앱이나 파일에 저장하세요.`;
    this.paint();
  },
  async share() {
    const files = this.out; if (!files.length) return;
    try {
      if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    files.forEach((f, i) => setTimeout(() => { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 2000); }, i * 300));
  }
};

/* ---------- 이벤트 ---------- */
document.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || b.disabled) return; const ds = b.dataset;
  if (ds.shoot) { Shoot.open(ds.shoot); return; }
  if (ds.x !== undefined) { Shoot.close(); return; }
  if (ds.endroll !== undefined) { Shoot.end(); return; }
  if (ds.rolltab) { Shoot.switchTo(ds.rolltab); return; }
  if (ds.addroll !== undefined) { Shoot.close(); state.view = "inv"; history.replaceState(null, "", location.pathname + location.search); render(); setAction(`<span class="msg">새로 넣은 필름을 누르고 "한 롤 썼어요"를 누르세요. 촬영 중인 롤에 추가돼요.</span>`); return; }
  if (ds.setcam !== undefined) { Shoot.setCam(); return; }
  if (ds.skip !== undefined) { Shoot.skip(); return; }
  if (ds.checkin !== undefined) { Shoot.checkin(); return; }
  if (ds.expand) { Shoot.expand[ds.expand] = !Shoot.expand[ds.expand]; Shoot.paint(); return; }
  if (ds.ranges) { Ranges.open(ds.ranges); return; }
  if (ds.rx !== undefined) { Ranges.close(); return; }
  if (ds.rauto !== undefined) { Ranges.auto(); return; }
  if (ds.rsave !== undefined) { Ranges.save(); return; }
  if (ds.rdel) { Ranges.del(ds.rdel); return; }
  if (ds.snap !== undefined) { Shoot.snap(); return; }
  if (ds.sel) { Shoot.setSel(ds.sel, ds.v2); return; }
  if (ds.fdel) { Shoot.del(ds.fdel); return; }
  if (ds.mapl) { state.view = "log"; state.logMode = "map"; state.mapFocus = ds.mapl; location.hash = "log"; render(); return; }
  if (ds.mapall !== undefined) { state.mapFocus = null; render(); return; }
  if (ds.exif) { Exif.open(ds.exif); return; }
  if (ds.xx !== undefined) { Exif.close(); return; }
  if (ds.off) { Exif.offset = Math.max(0, Exif.offset + +ds.off); Exif.out = []; Exif.paint(); return; }
  if (ds.exrun !== undefined) { Exif.run(); return; }
  if (ds.exshare !== undefined) { Exif.share(); return; }
  if (ds.regeo !== undefined) { Geo.stop(); Geo.start(); return; }
});
document.addEventListener("change", e => {
  if (e.target.id === "ex-files") Exif.setFiles(e.target.files || []);
  if (e.target.id === "rg-photos") Ranges.importPhotos(e.target.files || []);
});
document.addEventListener("input", e => { const id = e.target.dataset && e.target.dataset.start; if (id) Ranges.draft[id] = e.target.value; });

// 처음 열 때: 남은 컷 보내기, 바로가기 표시
setTimeout(() => { Frames.flush(); paintPill(); }, 500);

/* ---------- 롤 기록 폼에 현재 위치 넣기 ---------- */
function formGeo(fix) {
  const f = state.form; if (!f || f.mode !== "new") return;
  const line = $("geo-line");
  if (!fix) { if (line) line.innerHTML = Geo.err ? `<span class="bad">${esc(Geo.err)}</span>` : "현재 위치 찾는 중…"; return; }
  state.draft.lat = fix.lat; state.draft.lng = fix.lng;
  const show = name => { const el = $("geo-line"); if (el) el.innerHTML = `현재 위치 <b>${esc(name || "잡음")}</b> <em>±${Math.round(fix.acc)}m</em> <button type="button" class="act quiet sm" data-regeo>다시 잡기</button>`; };
  show(Place.near(fix));
  Place.name(fix).then(n => {
    show(n);
    if (!state.draft.place) { state.draft.place = n; const el = $("f-place"); if (el && !el.value) el.value = n; }
  }).catch(() => {});
}
function geoLineHtml() { return Geo.err ? `<span class="bad">${esc(Geo.err)}</span>` : "현재 위치 찾는 중…"; }

/* ---------- 구간 정하기: 장소(체크인·아이폰 사진)마다 몇 번 컷부터인지 ---------- */
const Ranges = {
  logId: null, draft: {}, msg: "", busy: false,
  open(id) { this.logId = id; this.draft = {}; this.msg = ""; $("ranges").hidden = false; document.body.classList.add("lock"); this.paint(); },
  close() { $("ranges").hidden = true; document.body.classList.remove("lock"); render(); },
  startOf(p) { return this.draft[p.id] !== undefined ? this.draft[p.id] : (p.start == null ? "" : String(p.start)); },
  segments() {
    const list = Frames.points(this.logId).map(p => ({ p, s: parseInt(this.startOf(p), 10) })).filter(x => x.s > 0).sort((a, b) => a.s - b.s);
    return list.map((x, i) => ({ place: x.p.place || "위치만 있음", from: x.s, to: list[i + 1] ? list[i + 1].s - 1 : null }));
  },
  paint() {
    const box = $("ranges"); if (!box || box.hidden) return;
    const l = state.logs.find(x => x.id === this.logId);
    if (!l) { box.innerHTML = `<div class="sh-top"><button class="navbtn" data-rx>닫기</button></div>`; return; }
    const pts = Frames.points(l.id), shots = Frames.shots(l.id), segs = this.segments();
    const dt = iso => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`; };
    box.innerHTML = `
      <div class="sh-top"><button class="navbtn" data-rx>닫기</button></div>
      <h2 class="ex-title">구간 정하기</h2>
      <p class="ex-sub">${esc(rollLabel(l))} · 찰칵 ${shots.length}컷 · 장소 ${pts.length}곳</p>
      <p class="ex-hint">장소마다 몇 번 컷부터 거기서 찍었는지 적어 주세요. 찰칵을 못 누른 컷도 그 장소 위치로 채워져요.</p>
      <div class="btns rg-btns">
        <label class="rowbtn">아이폰 사진에서 가져오기<input id="rg-photos" type="file" accept="image/*" multiple hidden></label>
        ${shots.some(f => f.at) && pts.length ? `<button class="rowbtn soft" data-rauto>시간으로 자동 맞추기</button>` : ""}
      </div>
      <p class="ex-hint">촬영지에서 폰으로 찍은 사진을 고르면 그 사진의 위치와 시간이 장소로 추가돼요. 고를 때 위쪽 <b>옵션 → 위치</b>를 켜 주세요.</p>
      ${pts.length ? `<ul class="rg-list">${pts.map(p => `<li>
          <div class="rg-info"><span class="rg-kind">${p.kind === "photo" ? "사진" : "장소"}</span><b>${esc(p.place || (p.lat ? "위치만 있음" : "위치 없음"))}</b><span>${dt(p.at)}</span></div>
          <div class="rg-in"><input id="rs-${esc(p.id)}" data-start="${esc(p.id)}" inputmode="numeric" placeholder="?" value="${esc(this.startOf(p))}"><span>번 컷부터</span><button class="act quiet sm" data-rdel="${esc(p.id)}">지우기</button></div>
        </li>`).join("")}</ul>` : `<p class="empty">아직 장소가 없어요. 촬영 화면의 "여기서 찍는 중"을 누르거나, 아이폰 사진을 가져오세요.</p>`}
      ${segs.length ? `<div class="rg-sum">${segs.map(g => `<div><b>${g.to ? `${g.from}~${g.to}컷` : `${g.from}컷~`}</b><span>${esc(g.place)}</span></div>`).join("")}</div>` : ""}
      ${pts.length ? `<div class="btns"><button class="rowbtn" data-rsave>저장</button></div>` : ""}
      ${this.msg ? `<p class="ex-hint">${this.msg}</p>` : ""}`;
  },
  auto() {
    const shots = Frames.shots(this.logId).filter(f => f.at).sort((a, b) => a.at < b.at ? -1 : 1);
    if (!shots.length) { this.msg = "찰칵 기록이 없어서 시간으로 맞출 수 없어요. 직접 적어 주세요."; this.paint(); return; }
    const last = Frames.lastN(this.logId);
    Frames.points(this.logId).forEach(p => { const nx = shots.find(f => f.at >= p.at); this.draft[p.id] = String(nx ? nx.n : last + 1); });
    this.msg = "찍은 시간 기준으로 채웠어요. 확인하고 저장을 눌러 주세요."; this.paint();
  },
  save() {
    let n = 0;
    Frames.points(this.logId).forEach(p => {
      if (this.draft[p.id] === undefined) return;
      const v = parseInt(this.draft[p.id], 10), start = v > 0 ? v : null;
      if (start === (p.start == null || p.start === "" ? null : +p.start)) return;
      const { local, ...clean } = p; Frames.put({ ...clean, start }); n++;
    });
    this.draft = {}; this.msg = n ? `${n}곳 저장했어요.` : "바뀐 내용이 없어요."; this.paint();
  },
  async del(id) { await Shoot.del(id); delete this.draft[id]; this.paint(); },
  async importPhotos(files) {
    files = [...files]; if (!files.length || this.busy) return;
    this.busy = true; this.msg = "사진을 읽는 중…"; this.paint();
    try { await loadOnce("https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js"); }
    catch (e) { this.busy = false; this.msg = "사진 정보 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요."; this.paint(); return; }
    const toDec = (v, ref) => { if (!v || v.length < 3) return null; const x = v[0][0] / v[0][1] + v[1][0] / v[1][1] / 60 + v[2][0] / v[2][1] / 3600; return /[SW]/.test(ref || "") ? -x : x; };
    let added = 0, noGps = 0, bad = 0;
    for (const file of files) {
      try {
        const bin = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsBinaryString(file.slice(0, 512 * 1024)); });
        const ex = piexif.load(bin), g = ex.GPS || {}, e = ex.Exif || {};
        const t = e[piexif.ExifIFD.DateTimeOriginal] || (ex["0th"] || {})[piexif.ImageIFD.DateTime];
        const off = e[piexif.ExifIFD.OffsetTimeOriginal];
        const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(t || "");
        const at = m ? (off ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(file.lastModified || Date.now());
        const lat = toDec(g[piexif.GPSIFD.GPSLatitude], g[piexif.GPSIFD.GPSLatitudeRef]), lng = toDec(g[piexif.GPSIFD.GPSLongitude], g[piexif.GPSIFD.GPSLongitudeRef]);
        if (lat == null || lng == null) { noGps++; continue; }
        const p = { id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), logId: this.logId, kind: "photo", n: 0, start: null,
          at: at.toISOString(), lat: +lat.toFixed(6), lng: +lng.toFixed(6), acc: null, place: "", ap: "", ss: "", note: "" };
        try { p.place = await Place.name({ lat: p.lat, lng: p.lng }); } catch (er) {}
        Frames.put(p); added++;
        this.msg = `${added}장 추가함…`; this.paint();
      } catch (er) { bad++; }
    }
    this.busy = false;
    if (added && Frames.shots(this.logId).some(f => f.at)) this.auto();
    this.msg = [added ? `사진 ${added}장을 장소로 추가했어요.` : "", noGps ? `${noGps}장은 위치 정보가 없었어요. 사진을 고를 때 옵션에서 위치를 켜 주세요.` : "",
      bad ? `${bad}장은 읽지 못했어요(HEIC 원본이면 JPEG로 고르면 돼요).` : "", added ? "각 장소에 몇 번 컷부터인지 적고 저장을 눌러 주세요." : ""].filter(Boolean).join(" ");
    this.paint();
  }
};
