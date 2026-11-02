/**
 * 필름정리 앱용 데이터 통로 (읽기 전용)
 *
 * 설치
 * 1. 구글 시트 '필름정리' → 확장 프로그램 → Apps Script
 * 2. 이 파일 내용을 Code.gs에 붙여넣고 저장
 * 3. 왼쪽 톱니바퀴(프로젝트 설정) → 스크립트 속성 → 속성 추가
 *      속성: KEY   값: 아무도 모를 긴 문자열 (예: 비밀번호 생성기로 만든 32자)
 * 4. 오른쪽 위 배포 → 새 배포 → 유형: 웹 앱
 *      실행 사용자: 나 / 액세스 권한: 모든 사용자
 * 5. 나온 웹 앱 URL과 KEY를 필름정리 앱 설정에 입력
 *
 * 이 스크립트는 시트를 읽기만 합니다. 시트를 바꾸는 코드는 없습니다.
 * KEY가 맞지 않으면 아무 데이터도 돌려주지 않습니다.
 */

const SHEETS = ['135', '120'];

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) {}
  return respond_(body.key);
}

function doGet(e) {
  return respond_(e && e.parameter && e.parameter.key);
}

function respond_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!expected || key !== expected) {
    return json_({ ok: false, error: 'bad_key' });
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = {};
  SHEETS.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const values = sh.getDataRange().getDisplayValues();
    // 표 오른쪽의 요약 칸(총 수량 등)은 빼고, 판형이 있는 행만 보냄
    const head = values[0].map(function (h) { return String(h).trim(); });
    const end = head.indexOf('') > 0 ? head.indexOf('') : head.length;
    sheets[name] = values
      .map(function (row) { return row.slice(0, end); })
      .filter(function (row, i) { return i === 0 || /^(135|120)$/.test(String(row[0]).trim()); });
  });
  return json_({ ok: true, at: new Date().toISOString(), sheetUrl: ss.getUrl(), sheets: sheets });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
