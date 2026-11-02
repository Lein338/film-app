/**
 * 필름정리 앱용 Apps Script (읽기 + 사용 기록 쓰기)
 *
 * 하는 일
 * - 135, 120 시트를 읽어서 앱에 보냄
 * - "한 롤 썼어요": 해당 필름 수량 −1, '사용기록' 탭에 한 줄 추가
 * - 되돌리기: 수량 +1, 그 줄 삭제
 * - 메모·현상 단계 수정, 보관 위치 저장('보관위치' 탭)
 * - 위치: 사용기록에 위도·경도, 컷마다 시간·위치를 '컷기록' 탭에 저장
 * 다른 칸(수식, 서식, 요약 시트)은 건드리지 않습니다.
 *
 * KEY: 아래 KEY_CONST에 넣거나, 프로젝트 설정 → 스크립트 속성에 KEY로 넣으세요.
 */
const KEY_CONST = '';
const SHEETS = ['135', '120'];
const LOG = '사용기록';
const LOC = '보관위치';
const FR = '컷기록';
const FR_HEAD = ['롤 번호', '컷', '시간', '위도', '경도', '정확도(m)', '장소', '조리개', '셔터', '메모', 'id', 'logId'];
const TZ = 'Asia/Seoul';
const LOG_HEAD = ['번호', '날짜', '판형', '브랜드', '필름명', '감도', '유형', '유통기한', 'EI', '카메라', '장소', '메모', '현상 단계', '현상소', '맡긴 날', '스캔 받은 날', 'id', 'key', '위도', '경도'];
const STAGE = { shot: '현상 전', lab: '현상 맡김', scan: '스캔 완료' };

function key_() { return KEY_CONST || PropertiesService.getScriptProperties().getProperty('KEY'); }

function doGet(e) { return handle_({ key: e && e.parameter && e.parameter.key }); }
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) {}
  return handle_(body);
}

function handle_(b) {
  if (!key_() || b.key !== key_()) return json_({ ok: false, error: 'bad_key' });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!b.action || b.action === 'read') return json_(snapshot_(ss));
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (b.action === 'use') use_(ss, b);
    else if (b.action === 'undo') undo_(ss, b.id);
    else if (b.action === 'update') update_(ss, b.id, b.fields || {});
    else if (b.action === 'loc') loc_(ss, b.rowKey, b.loc);
    else if (b.action === 'frames') (b.frames || []).forEach(function (f) { frame_(ss, f); });
    else if (b.action === 'frameDelete') frameDelete_(ss, b.id);
    else return json_({ ok: false, error: 'bad_action' });
    SpreadsheetApp.flush();
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally { lock.releaseLock(); }
  return json_(snapshot_(ss));
}

/* ---------- 읽기 ---------- */
function snapshot_(ss) {
  const sheets = {};
  SHEETS.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const values = sh.getDataRange().getDisplayValues();
    const head = values[0].map(function (h) { return String(h).trim(); });
    const end = head.indexOf('') > 0 ? head.indexOf('') : head.length;
    sheets[name] = values.map(function (r) { return r.slice(0, end); })
      .filter(function (r, i) { return i === 0 || /^(135|120)$/.test(String(r[0]).trim()); });
  });
  return { ok: true, at: new Date().toISOString(), sheetUrl: ss.getUrl(), sheets: sheets, logs: readLogs_(ss), locs: readLocs_(ss), frames: readFrames_(ss) };
}
function readLogs_(ss) {
  const sh = ss.getSheetByName(LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, LOG_HEAD.length).getDisplayValues();
  const back = { '현상 전': 'shot', '현상 맡김': 'lab', '스캔 완료': 'scan' };
  return v.filter(function (r) { return r[16]; }).map(function (r) {
    return { no: r[0], at: r[1], fmt: r[2], brand: r[3], name: r[4], iso: r[5], type: r[6], expiry: r[7], ei: r[8],
      cam: r[9], place: r[10], note: r[11], stage: back[r[12]] || 'shot', lab: r[13], labAt: r[14], scanAt: r[15], id: r[16], key: r[17], lat: r[18], lng: r[19] };
  });
}
function readLocs_(ss) {
  const sh = ss.getSheetByName(LOC);
  if (!sh || sh.getLastRow() < 2) return {};
  const out = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getDisplayValues().forEach(function (r) { if (r[2]) out[r[2]] = r[1]; });
  return out;
}

/* ---------- 재고 행 찾기 (앱과 같은 방식의 key) ---------- */
function findRow_(ss, rowKey) {
  const seen = {};
  for (let s = 0; s < SHEETS.length; s++) {
    const sh = ss.getSheetByName(SHEETS[s]);
    if (!sh) continue;
    const v = sh.getDataRange().getDisplayValues();
    const head = v[0].map(function (h) { return String(h).trim(); });
    const col = function (k) { return head.findIndex(function (h) { return h.indexOf(k) === 0; }); };
    const c = { fmt: col('판형'), brand: col('브랜드'), name: col('필름명'), iso: col('감도'), qty: col('수량'), exp: col('유통기한') };
    for (let i = 1; i < v.length; i++) {
      const g = function (j) { return j < 0 ? '' : String(v[i][j]).trim(); };
      if (!/^(135|120)$/.test(g(c.fmt)) || !g(c.brand)) continue;
      const base = [g(c.fmt), g(c.brand), g(c.name), g(c.iso), g(c.exp)].join('|');
      seen[base] = (seen[base] || 0) + 1;
      if (base + '#' + seen[base] === rowKey) {
        return { sh: sh, row: i + 1, qtyCol: c.qty + 1, qty: parseInt(g(c.qty), 10) || 0,
          info: { fmt: g(c.fmt), brand: g(c.brand), name: g(c.name), iso: g(c.iso), expiry: g(c.exp), type: g(col('유형')) } };
      }
    }
  }
  return null;
}

/* ---------- 쓰기 ---------- */
function logSheet_(ss) {
  let sh = ss.getSheetByName(LOG);
  if (!sh) {
    sh = ss.insertSheet(LOG);
    sh.getRange(1, 1, 1, LOG_HEAD.length).setValues([LOG_HEAD]).setFontWeight('bold');
    sh.getRange('A:R').setNumberFormat('@');
    sh.setFrozenRows(1);
    sh.hideColumns(17, 2); // id, key
  }
  if (sh.getLastColumn() < LOG_HEAD.length) { // 예전 탭에 위도·경도 칸 추가
    sh.getRange(1, 1, 1, LOG_HEAD.length).setValues([LOG_HEAD]).setFontWeight('bold');
    sh.getRange('S:T').setNumberFormat('@');
  }
  return sh;
}
function fmt_(iso, withTime) {
  const d = iso ? new Date(iso) : new Date();
  return Utilities.formatDate(isNaN(d) ? new Date() : d, TZ, withTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
}
function nextNo_(sh, at) {
  const yy = Utilities.formatDate(new Date(at), TZ, 'yy');
  let max = 0;
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().forEach(function (r) {
    const m = /^(\d{2})-(\d+)$/.exec(r[0]); if (m && m[1] === yy) max = Math.max(max, +m[2]);
  });
  return yy + '-' + ('00' + (max + 1)).slice(-3);
}
function use_(ss, b) {
  const f = findRow_(ss, b.rowKey);
  if (!f) throw new Error('row_not_found');
  if (f.qty < 1) throw new Error('no_stock');
  f.sh.getRange(f.row, f.qtyCol).setValue(f.qty - 1);
  const sh = logSheet_(ss), x = b.fields || {}, at = b.at || new Date().toISOString();
  const no = nextNo_(sh, at), id = Utilities.getUuid();
  sh.appendRow([no, fmt_(at, true), f.info.fmt, f.info.brand, f.info.name, f.info.iso, f.info.type, f.info.expiry,
    x.ei || '', x.cam || '', x.place || '', x.note || '', STAGE.shot, '', '', '', id, b.rowKey, x.lat || '', x.lng || '']);
}
function logRow_(sh, id) {
  if (sh.getLastRow() < 2) return -1;
  const ids = sh.getRange(2, 17, sh.getLastRow() - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}
function undo_(ss, id) {
  const sh = logSheet_(ss), r = logRow_(sh, id);
  if (r < 0) throw new Error('log_not_found');
  const rowKey = sh.getRange(r, 18).getDisplayValue();
  const f = findRow_(ss, rowKey);
  if (f) f.sh.getRange(f.row, f.qtyCol).setValue(f.qty + 1);
  sh.deleteRow(r);
  // 그 롤의 컷 기록도 같이 지움
  const fs = ss.getSheetByName(FR);
  if (fs && fs.getLastRow() > 1) {
    const ids = fs.getRange(2, 12, fs.getLastRow() - 1, 1).getDisplayValues();
    for (let i = ids.length - 1; i >= 0; i--) if (ids[i][0] === id) fs.deleteRow(i + 2);
  }
}
function update_(ss, id, x) {
  const sh = logSheet_(ss), r = logRow_(sh, id);
  if (r < 0) throw new Error('log_not_found');
  const set = function (c, v) { if (v !== undefined) sh.getRange(r, c).setValue(v === null ? '' : String(v)); };
  if (x.at) set(2, fmt_(x.at, true));
  set(9, x.ei); set(10, x.cam); set(11, x.place); set(12, x.note);
  if (x.stage) set(13, STAGE[x.stage] || STAGE.shot);
  set(14, x.lab);
  if (x.labAt !== undefined) set(15, x.labAt ? fmt_(x.labAt) : '');
  if (x.scanAt !== undefined) set(16, x.scanAt ? fmt_(x.scanAt) : '');
  set(19, x.lat); set(20, x.lng);
}
/* ---------- 컷 기록 ---------- */
function frameSheet_(ss) {
  let sh = ss.getSheetByName(FR);
  if (!sh) {
    sh = ss.insertSheet(FR);
    sh.getRange(1, 1, 1, FR_HEAD.length).setValues([FR_HEAD]).setFontWeight('bold');
    sh.getRange('A:L').setNumberFormat('@');
    sh.setFrozenRows(1);
    sh.hideColumns(11, 2); // id, logId
  }
  return sh;
}
function readFrames_(ss) {
  const sh = ss.getSheetByName(FR);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, FR_HEAD.length).getDisplayValues().filter(function (r) { return r[10]; }).map(function (r) {
    return { no: r[0], n: +r[1] || 0, at: r[2], lat: r[3], lng: r[4], acc: r[5], place: r[6], ap: r[7], ss: r[8], note: r[9], id: r[10], logId: r[11] };
  });
}
function frameRow_(sh, id) {
  if (sh.getLastRow() < 2) return -1;
  const ids = sh.getRange(2, 11, sh.getLastRow() - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}
function frame_(ss, f) {
  if (!f || !f.id || !f.logId) return;
  const sh = frameSheet_(ss), ls = logSheet_(ss), lr = logRow_(ls, f.logId);
  if (lr < 0) return; // 롤 기록이 지워졌으면 무시
  const no = ls.getRange(lr, 1).getDisplayValue();
  const row = [no, String(f.n || ''), fmt_(f.at, true) + (f.at ? ':' + Utilities.formatDate(new Date(f.at), TZ, 'ss') : ''),
    f.lat == null ? '' : String(f.lat), f.lng == null ? '' : String(f.lng), f.acc == null ? '' : String(Math.round(f.acc)),
    f.place || '', f.ap || '', f.ss || '', f.note || '', f.id, f.logId];
  const r = frameRow_(sh, f.id);
  if (r > 0) sh.getRange(r, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}
function frameDelete_(ss, id) {
  const sh = ss.getSheetByName(FR); if (!sh) return;
  const r = frameRow_(sh, id); if (r > 0) sh.deleteRow(r);
}

function loc_(ss, rowKey, loc) {
  let sh = ss.getSheetByName(LOC);
  if (!sh) {
    sh = ss.insertSheet(LOC);
    sh.getRange(1, 1, 1, 3).setValues([['필름', '보관 위치', 'key']]).setFontWeight('bold');
    sh.getRange('A:C').setNumberFormat('@'); sh.setFrozenRows(1); sh.hideColumns(3);
  }
  let r = -1;
  if (sh.getLastRow() > 1) {
    const keys = sh.getRange(2, 3, sh.getLastRow() - 1, 1).getDisplayValues();
    for (let i = 0; i < keys.length; i++) if (keys[i][0] === rowKey) { r = i + 2; break; }
  }
  if (!loc) { if (r > 0) sh.deleteRow(r); return; }
  const f = findRow_(ss, rowKey), label = f ? [f.info.fmt, f.info.brand, f.info.name || f.info.iso, f.info.expiry].join(' ') : rowKey;
  if (r > 0) sh.getRange(r, 1, 1, 3).setValues([[label, loc, rowKey]]);
  else sh.appendRow([label, loc, rowKey]);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 원래 쓰던 시트 자동화 (그대로 유지) ----------
 * 1) 요약 K7 체크 → 135/120 탭에 등록
 * 2) 판형 칸을 바꾸면 135↔120 탭 사이로 행 이동
 * 3) 유형 칸을 바꾸면 유형별 정렬
 * 앱이 수량을 바꿀 때는 onEdit이 실행되지 않아요 (스크립트가 바꾼 값은 onEdit 대상이 아님).
 */
function onEdit(e) {
  if (!e || !e.range) return;

  const range = e.range;
  const sheet = range.getSheet();
  const sheetName = sheet.getName();
  const row = range.getRow();
  const col = range.getColumn();
  const val = e.value !== undefined ? String(e.value).trim() : "";
  const ss = e.source;

  // =========================================================================
  // [기능 1] 요약 시트에서 K7 등록 체크박스 클릭 시 자동 전송 및 초기화
  // =========================================================================
  if (sheetName === "요약" && range.getA1Notation() === "K7" && range.getValue() === true) {
    const inputVals = sheet.getRange("B7:J7").getValues()[0];
    const format = String(inputVals[0]).trim(); // B7: 판형 ("135" 또는 "120")

    if (format === "135") {
      const targetSheet = ss.getSheetByName("135");
      if (targetSheet) {
        // 135 시트 컬럼 순서 (9개): 판형, 매수, 브랜드, 필름명, 감도, 수량, 유통기한, 유형, 비고
        targetSheet.appendRow(inputVals);

        // 추가 후 유형(H열 = 8번째 열) 기준 자동 정렬
        const tLastRow = targetSheet.getLastRow();
        if (tLastRow > 1) {
          targetSheet.getRange(2, 1, tLastRow - 1, 9).sort({ column: 8, ascending: true });
        }
      }
    } else if (format === "120") {
      const targetSheet = ss.getSheetByName("120");
      if (targetSheet) {
        // 120 시트 컬럼 순서 (8개, 매수 제외): 판형, 브랜드, 필름명, 감도, 수량, 유통기한, 유형, 비고
        const row120 = [
          inputVals[0], // 판형
          inputVals[2], // 브랜드
          inputVals[3], // 필름명
          inputVals[4], // 감도
          inputVals[5], // 수량
          inputVals[6], // 유통기한
          inputVals[7], // 유형
          inputVals[8]  // 비고
        ];
        targetSheet.appendRow(row120);

        // 추가 후 유형(G열 = 7번째 열) 기준 자동 정렬
        const tLastRow = targetSheet.getLastRow();
        if (tLastRow > 1) {
          targetSheet.getRange(2, 1, tLastRow - 1, 8).sort({ column: 7, ascending: true });
        }
      }
    }

    // 입력 행 초기화 및 체크박스 해제 (수식/드롭다운 유지)
    sheet.getRange("B7:J7").clearContent();
    range.setValue(false);
    return;
  }

  // 1행(헤더) 수정 시에는 아래 자동 정렬/이동 로직 무시
  if (row <= 1) return;

  // =========================================================================
  // [기능 2] 135 또는 120 시트의 A열(판형) 변경 시 해당 시트로 행 이동
  // =========================================================================
  if (col === 1 && (val === "135" || val === "120")) {
    const targetSheetName = val;

    // 현재 시트와 대상 시트가 다를 때만 이동 실행
    if (sheetName !== targetSheetName && (sheetName === "135" || sheetName === "120")) {
      const targetSheet = ss.getSheetByName(targetSheetName);

      if (targetSheet) {
        const numCols = sheet.getLastColumn();
        const rowData = sheet.getRange(row, 1, 1, numCols).getValues()[0];

        if (targetSheetName === "135" && sheetName === "120") {
          // 120 -> 135 이동 시: 매수(빈값)를 2번째에 삽입
          const newRow = [rowData[0], "", ...rowData.slice(1)];
          targetSheet.appendRow(newRow);
        } else if (targetSheetName === "120" && sheetName === "135") {
          // 135 -> 120 이동 시: 매수(2번째 열) 제외
          const newRow = [rowData[0], ...rowData.slice(2)];
          targetSheet.appendRow(newRow);
        }

        // 기존 시트에서 행 삭제
        sheet.deleteRow(row);

        // 대상 시트의 유형 열 기준으로 자동 정렬 (135는 H열/8, 120은 G열/7)
        const tLastRow = targetSheet.getLastRow();
        const tTypeCol = targetSheetName === "135" ? 8 : 7;
        const tNumCols = targetSheet.getLastColumn();
        if (tLastRow > 1) {
          targetSheet.getRange(2, 1, tLastRow - 1, tNumCols).sort({ column: tTypeCol, ascending: true });
        }
        return;
      }
    }
  }

  // =========================================================================
  // [기능 3] 유형 열 수정 시 현재 시트 내에서 유형별 자동 정렬
  //          - 135 시트: H열 (8번째 열)
  //          - 120 시트: G열 (7번째 열)
  // =========================================================================
  if ((sheetName === "135" && col === 8) || (sheetName === "120" && col === 7)) {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const sortCol = sheetName === "135" ? 8 : 7;

    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, lastCol).sort({ column: sortCol, ascending: true });
    }
  }
}
