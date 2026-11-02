// 필름정리 위젯 (Scriptable)
// 설치: Scriptable 앱 → + → 이 파일 전체 붙여넣기 → 이름 '필름정리' → 홈 화면에 Scriptable 위젯 추가 →
//       위젯 길게 눌러 편집 → Script: 필름정리 선택
// 아래 두 값만 본인 것으로 바꾸세요. (공개 저장소에는 비워 둡니다)
const URL_ = "";   // Apps Script 웹 앱 주소 (…/exec)
const KEY_ = "";   // 앱 설정에 넣은 키
const APP_URL = "https://lein338.github.io/film-app/";

const C = {
  bg:    Color.dynamic(new Color("#EFF1EF"), new Color("#131514")),
  ink:   Color.dynamic(new Color("#161918"), new Color("#E7EAE7")),
  muted: Color.dynamic(new Color("#69706C"), new Color("#949B97")),
  faint: Color.dynamic(new Color("#A3A9A5"), new Color("#5E6561")),
  late:  Color.dynamic(new Color("#9E3A2C"), new Color("#E07462")),
  soon:  Color.dynamic(new Color("#B06A12"), new Color("#E0A04A")),
};
const TYPES = [
  { k: "B&W",   label: "흑백",  light: "#7E8581", dark: "#9AA19D" },
  { k: "C41",   label: "C-41",  light: "#C47A22", dark: "#E0973D" },
  { k: "E6",    label: "E-6",   light: "#2E7686", dark: "#4FA3B4" },
  { k: "ECN-2", label: "ECN-2", light: "#9E3A2C", dark: "#D0614F" },
];
const dark = Device.isUsingDarkAppearance();
const mono = (s, w) => w === "b" ? Font.semiboldMonospacedSystemFont(s) : Font.regularMonospacedSystemFont(s);

// ---------- 데이터 ----------
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "film-widget-cache.json");

async function load() {
  if (!URL_ || !KEY_) throw new Error("setup");
  const req = new Request(URL_);
  req.method = "POST";
  req.headers = { "Content-Type": "text/plain;charset=utf-8" };
  req.body = JSON.stringify({ key: KEY_ });
  req.timeoutInterval = 20;
  const j = await req.loadJSON();
  if (!j.ok) throw new Error(j.error || "server");
  fm.writeString(cachePath, JSON.stringify(j));
  return { j, stale: false };
}
async function data() {
  try { return await load(); }
  catch (e) {
    if (fm.fileExists(cachePath)) return { j: JSON.parse(fm.readString(cachePath)), stale: true, err: e.message };
    throw e;
  }
}
function rows(sheets) {
  const out = [];
  for (const name of ["135", "120"]) {
    const t = sheets && sheets[name]; if (!t || !t.length) continue;
    const head = t[0].map(h => String(h).trim());
    const col = (c, k) => { const i = head.findIndex(h => h.startsWith(k)); return i < 0 ? "" : String(c[i] ?? "").trim(); };
    for (const c of t.slice(1)) {
      if (!/^(135|120)$/.test(col(c, "판형")) || !col(c, "브랜드")) continue;
      out.push({ fmt: col(c, "판형"), brand: col(c, "브랜드"), name: col(c, "필름명"), iso: col(c, "감도"),
        qty: parseInt(col(c, "수량"), 10) || 0, expiry: col(c, "유통기한"), type: col(c, "유형") });
    }
  }
  return out.filter(r => r.qty > 0);
}
const now = new Date(), NOWM = now.getFullYear() * 12 + now.getMonth() + 1;
function monthsLeft(r) { const m = /^(\d{4})\.(\d{1,2})/.exec(r.expiry); return m ? (+m[1]) * 12 + (+m[2]) - NOWM : null; }

// ---------- 그리기 ----------
function marks(list, width, rowsMax) {
  // 유형마다 한 줄, 롤 하나 = 세로 눈금 하나
  const labelW = 54, mw = 3, mh = 10, gap = 2, lineH = 14;
  const per = Math.max(1, Math.floor((width - labelW) / (mw + gap)));
  const lines = []; list.forEach(t => { const n = Math.ceil(t.n / per) || 1; for (let i = 0; i < n; i++) lines.push({ t, i, from: i * per, to: Math.min(t.n, (i + 1) * per) }); });
  const shown = lines.slice(0, rowsMax);
  const ctx = new DrawContext(); ctx.opaque = false; ctx.respectScreenScale = true;
  ctx.size = new Size(width, shown.length * lineH);
  shown.forEach((l, y) => {
    const top = y * lineH;
    if (l.i === 0) {
      ctx.setFont(Font.systemFont(10)); ctx.setTextColor(new Color(dark ? "#949B97" : "#69706C"));
      ctx.drawText(l.t.label, new Point(0, top));
      ctx.setFont(mono(10, "b")); ctx.setTextColor(new Color(dark ? "#E7EAE7" : "#161918"));
      ctx.drawText(String(l.t.n), new Point(32, top));
    }
    ctx.setFillColor(new Color(dark ? l.t.dark : l.t.light));
    for (let k = 0; k < l.to - l.from; k++) {
      const p = new Path(); p.addRoundedRect(new Rect(labelW + k * (mw + gap), top + 1, mw, mh), 1.5, 1.5);
      ctx.addPath(p); ctx.fillPath();
    }
  });
  return ctx.getImage();
}

function addText(stack, s, font, color, lines = 1) {
  const t = stack.addText(s); t.font = font; t.textColor = color; t.lineLimit = lines; t.minimumScaleFactor = 0.8; return t;
}

async function build() {
  const fam = config.widgetFamily || "medium";
  const w = new ListWidget();
  w.backgroundColor = C.bg; w.url = APP_URL;
  w.setPadding(14, 16, 14, 16);
  w.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000);

  let d;
  try { d = await data(); }
  catch (e) {
    addText(w, "필름정리", Font.semiboldSystemFont(13), C.ink);
    w.addSpacer(6);
    addText(w, e.message === "setup" ? "스크립트 맨 위에 주소와 키를 넣어 주세요." : "시트를 불러오지 못했어요.", Font.systemFont(12), C.muted, 3);
    return w;
  }
  const rs = rows(d.j.sheets);
  const total = rs.reduce((s, r) => s + r.qty, 0);
  const byType = TYPES.map(t => ({ ...t, n: rs.filter(r => r.type === t.k).reduce((s, r) => s + r.qty, 0) })).filter(t => t.n > 0);

  // 머리
  const top = w.addStack(); top.centerAlignContent();
  addText(top, "필름정리", Font.semiboldSystemFont(12), C.ink);
  top.addSpacer();
  if (d.stale) addText(top, "사본", mono(9), C.faint);

  if (fam === "accessoryRectangular" || fam === "accessoryInline" || fam === "accessoryCircular") {
    const ww = new ListWidget(); ww.url = APP_URL;
    addText(ww, `필름 ${total}롤`, Font.semiboldSystemFont(14), Color.white());
    addText(ww, byType.map(t => `${t.label} ${t.n}`).join(" · "), Font.systemFont(11), Color.white(), 2);
    return ww;
  }

  w.addSpacer(fam === "small" ? 4 : 6);
  const big = w.addStack(); big.bottomAlignContent();
  addText(big, String(total), mono(fam === "small" ? 34 : 38, "b"), C.ink);
  big.addSpacer(4);
  const unit = big.addStack(); unit.layoutVertically(); unit.addSpacer();
  addText(unit, "롤", Font.systemFont(12), C.muted);
  if (fam !== "small") {
    big.addSpacer();
    const sp = big.addStack(); sp.layoutVertically(); sp.addSpacer();
    const n135 = rs.filter(r => r.fmt === "135").reduce((s, r) => s + r.qty, 0);
    addText(sp, `135 ${n135}  ·  120 ${total - n135}`, mono(10), C.muted);
  }

  w.addSpacer(8);
  const width = fam === "small" ? 124 : fam === "large" ? 300 : 300;
  w.addImage(marks(byType, width, fam === "small" ? 4 : 6));

  if (fam !== "small") {
    // 기한 급한 필름
    const dated = rs.map(r => ({ r, m: monthsLeft(r) })).filter(x => x.m !== null);
    const soon = dated.filter(x => x.m >= 0 && x.m <= 6).sort((a, b) => a.m - b.m);
    const late = dated.filter(x => x.m < 0).sort((a, b) => b.m - a.m);
    const pick = [...soon, ...late].slice(0, fam === "large" ? 7 : 2);
    if (pick.length) {
      w.addSpacer(8);
      addText(w, soon.length ? "기한 급한 필름" : "기한 지난 필름", Font.mediumSystemFont(10), C.muted);
      w.addSpacer(3);
      for (const { r, m } of pick) {
        const line = w.addStack(); line.centerAlignContent();
        const t = TYPES.find(x => x.k === r.type);
        const bar = line.addStack(); bar.size = new Size(3, 12); bar.cornerRadius = 1;
        bar.backgroundColor = new Color(t ? (dark ? t.dark : t.light) : "#A3A9A5");
        line.addSpacer(6);
        addText(line, `${r.brand} ${r.name || r.iso}`, Font.mediumSystemFont(12), C.ink);
        line.addSpacer();
        addText(line, m < 0 ? `${Math.floor(-m / 12) ? Math.floor(-m / 12) + "년" : -m + "개월"} 지남` : m === 0 ? "이번 달" : `${m}개월`, mono(10), m < 0 ? C.late : C.soon);
        addText(line, `  ×${r.qty}`, mono(10), C.muted);
        w.addSpacer(2);
      }
    }
  }
  w.addSpacer();
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else if (config.runsInAccessoryWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
