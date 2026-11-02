// 필름정리 위젯 (Scriptable)
// 설치: Scriptable 앱 → + → 이 파일 전체 붙여넣기 → 이름 '필름정리' → 홈 화면에 Scriptable 위젯 추가 →
//       위젯 길게 눌러 편집 → Script: 필름정리 선택
// 아래 두 값만 본인 것으로 바꾸세요. (공개 저장소에는 비워 둡니다)
const URL_ = "";   // Apps Script 웹 앱 주소 (…/exec)
const KEY_ = "";   // 앱 설정에 넣은 키
const APP_URL = "";  // 비워 두면 위젯을 눌렀을 때 아무 앱도 열지 않아요 (아래 설명 참고)

const C = {
  bg:    Color.dynamic(new Color("#FFFFFF"), new Color("#1C1C1E")),
  ink:   Color.dynamic(new Color("#000000"), new Color("#FFFFFF")),
  muted: Color.dynamic(new Color("#3C3C43", 0.6), new Color("#EBEBF5", 0.6)),
  track: Color.dynamic(new Color("#767680", 0.12), new Color("#767680", 0.24)),
};
const TYPES = [
  { k: "B&W",   label: "흑백",  light: "#8E8E93", dark: "#98989D" },
  { k: "C41",   label: "C-41",  light: "#FF9500", dark: "#FF9F0A" },
  { k: "E6",    label: "E-6",   light: "#30B0C7", dark: "#40C8E0" },
  { k: "ECN-2", label: "ECN-2", light: "#FF3B30", dark: "#FF453A" },
];
const tc = t => Color.dynamic(new Color(t.light), new Color(t.dark));

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
function addText(stack, s, font, color) {
  const t = stack.addText(s); t.font = font; t.textColor = color; t.lineLimit = 1; t.minimumScaleFactor = 0.7; return t;
}
// 유형별 가로 막대 (전체 대비 비율)
function typeRow(parent, t, total, barW) {
  const row = parent.addStack(); row.centerAlignContent();
  const dot = row.addStack(); dot.size = new Size(8, 8); dot.cornerRadius = 4; dot.backgroundColor = tc(t);
  row.addSpacer(6);
  const lab = row.addStack(); lab.size = new Size(40, 0);
  addText(lab, t.label, Font.systemFont(13), C.muted); lab.addSpacer();
  if (barW) {
    const track = row.addStack(); track.size = new Size(barW, 6); track.cornerRadius = 3; track.backgroundColor = C.track;
    const fill = track.addStack(); fill.size = new Size(Math.max(6, Math.round(barW * t.n / Math.max(1, total))), 6);
    fill.cornerRadius = 3; fill.backgroundColor = tc(t); track.addSpacer();
    row.addSpacer(8);
  } else row.addSpacer();
  addText(row, String(t.n), Font.semiboldSystemFont(13), C.ink);
}

async function build() {
  const fam = config.widgetFamily || "medium";
  let d, err = null;
  try { d = await data(); } catch (e) { err = e; }

  if (fam.startsWith("accessory")) {
    const w = new ListWidget(); if (APP_URL) w.url = APP_URL;
    if (err) { addText(w, "필름정리", Font.semiboldSystemFont(13), Color.white()); return w; }
    const rs = rows(d.j.sheets), total = rs.reduce((s, r) => s + r.qty, 0);
    if (fam === "accessoryInline") { addText(w, `필름 ${total}롤`, Font.systemFont(13), Color.white()); return w; }
    if (fam === "accessoryCircular") {
      w.addSpacer(); const c = w.addStack(); c.addSpacer(); addText(c, String(total), Font.boldRoundedSystemFont(22), Color.white()); c.addSpacer();
      const u = w.addStack(); u.addSpacer(); addText(u, "롤", Font.systemFont(10), Color.white()); u.addSpacer(); w.addSpacer(); return w;
    }
    addText(w, `필름 ${total}롤`, Font.semiboldSystemFont(15), Color.white());
    const byT = TYPES.map(t => ({ ...t, n: rs.filter(r => r.type === t.k).reduce((s, r) => s + r.qty, 0) })).filter(t => t.n > 0);
    addText(w, byT.map(t => `${t.label} ${t.n}`).join("  "), Font.systemFont(12), Color.white());
    return w;
  }

  const w = new ListWidget();
  w.backgroundColor = C.bg; if (APP_URL) w.url = APP_URL;
  w.setPadding(16, 16, 16, 16);
  w.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000);
  if (err) {
    addText(w, "필름정리", Font.semiboldSystemFont(15), C.ink); w.addSpacer(4);
    const t = w.addText(err.message === "setup" ? "스크립트 맨 위에 주소와 키를 넣어 주세요." : "시트를 불러오지 못했어요.");
    t.font = Font.systemFont(13); t.textColor = C.muted; w.addSpacer(); return w;
  }
  const rs = rows(d.j.sheets);
  const total = rs.reduce((s, r) => s + r.qty, 0);
  const n135 = rs.filter(r => r.fmt === "135").reduce((s, r) => s + r.qty, 0);
  const byType = TYPES.map(t => ({ ...t, n: rs.filter(r => r.type === t.k).reduce((s, r) => s + r.qty, 0) })).filter(t => t.n > 0);

  const head = (stack) => {
    const h = stack.addStack(); h.centerAlignContent();
    addText(h, "필름", Font.semiboldSystemFont(13), C.muted);
    if (d.stale) { h.addSpacer(4); addText(h, "· 사본", Font.systemFont(11), C.muted); }
    stack.addSpacer(2);
    const big = stack.addStack(); big.bottomAlignContent();
    addText(big, String(total), Font.boldRoundedSystemFont(fam === "small" ? 40 : 44), C.ink);
    big.addSpacer(3);
    const u = big.addStack(); u.layoutVertically(); addText(u, "롤", Font.semiboldSystemFont(15), C.muted); u.addSpacer(5);
    addText(stack, `135 ${n135}  ·  120 ${total - n135}`, Font.systemFont(12), C.muted);
  };

  if (fam === "small") {
    head(w); w.addSpacer();
    byType.slice(0, 3).forEach((t, i) => { if (i) w.addSpacer(3); typeRow(w, t, total, 0); });
  } else {
    const body = w.addStack(); body.centerAlignContent();
    const left = body.addStack(); left.layoutVertically(); head(left);
    body.addSpacer(18);
    const right = body.addStack(); right.layoutVertically();
    const barW = fam === "large" ? 150 : 82;
    byType.forEach((t, i) => { if (i) right.addSpacer(7); typeRow(right, t, total, barW); });
    if (fam === "large") {
      w.addSpacer(16);
      const brands = {}; rs.forEach(r => brands[r.brand] = (brands[r.brand] || 0) + r.qty);
      addText(w, "브랜드", Font.semiboldSystemFont(13), C.muted); w.addSpacer(6);
      Object.entries(brands).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([b, n]) => {
        const r = w.addStack(); addText(r, b, Font.systemFont(15), C.ink); r.addSpacer(); addText(r, `${n}롤`, Font.systemFont(15), C.muted); w.addSpacer(5);
      });
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
