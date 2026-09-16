/**
 * ============================================================================
 *  Music Showcase · 節目單蒐集 — Google Sheet 後端
 *  Repertoire Collection — Google Sheets backend
 * ============================================================================
 *
 *  這個檔案的用途：把 Google Sheet 當成資料庫，讓各家庭自己上網填寫演出曲目。
 *  開放式表單，一首一筆，可重複提交；每筆可「編輯」（開放式）。
 *
 *  API 契約（前端 index.html 會呼叫這些）：
 *    GET  ?action=list               → { ok:true, entries:[...] }（不含聯絡方式/備註）
 *    POST { action:'add',    entry  } → { ok:true, entry, entries }
 *    POST { action:'update', id, entry } → { ok:true, entry, entries }
 *    POST { action:'delete', id      } → { ok:true, entries }
 */

var SHEET_NAME = 'repertoire';

var HEADERS = [
  'id', 'name', 'piece', 'composer',
  'instrument', 'instrument_other',
  'dur_min', 'dur_sec',
  'has_accomp', 'accomp_count', 'accomp_inst', 'accomp_other', 'accomp_teacher',
  'contact', 'note', 'at'
];

var COL = {
  id: 1, name: 2, piece: 3, composer: 4,
  instrument: 5, instrumentOther: 6,
  durMin: 7, durSec: 8,
  hasAccomp: 9, accompCount: 10, accompInst: 11, accompOther: 12, accompTeacher: 13,
  contact: 14, note: 15, at: 16
};

/* ---------------------------------------------------------------- helpers */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#f6efe3');
    sh.setFrozenRows(1);
  }
  return sh;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function str_(v) { return (v === null || v === undefined) ? '' : String(v); }

/** 對外（公開）檢視：拿掉聯絡方式與備註。 */
function publicView_(list) {
  return (list || []).map(function (e) {
    return {
      id: e.id,
      name: e.name, piece: e.piece, composer: e.composer,
      instrument: e.instrument, instrument_other: e.instrument_other,
      dur_min: e.dur_min, dur_sec: e.dur_sec,
      has_accomp: e.has_accomp, accomp_count: e.accomp_count,
      accomp_inst: e.accomp_inst, accomp_other: e.accomp_other, accomp_teacher: e.accomp_teacher,
      at: e.at
    };
  });
}

function rowToEntry_(r) {
  return {
    id:               str_(r[COL.id - 1]),
    name:             str_(r[COL.name - 1]),
    piece:            str_(r[COL.piece - 1]),
    composer:         str_(r[COL.composer - 1]),
    instrument:       str_(r[COL.instrument - 1]),
    instrument_other: str_(r[COL.instrumentOther - 1]),
    dur_min:          str_(r[COL.durMin - 1]),
    dur_sec:          str_(r[COL.durSec - 1]),
    has_accomp:       str_(r[COL.hasAccomp - 1]),
    accomp_count:     str_(r[COL.accompCount - 1]),
    accomp_inst:      str_(r[COL.accompInst - 1]),
    accomp_other:     str_(r[COL.accompOther - 1]),
    accomp_teacher:   str_(r[COL.accompTeacher - 1]),
    contact:          str_(r[COL.contact - 1]),
    note:             str_(r[COL.note - 1]),
    at:               str_(r[COL.at - 1])
  };
}

function entryToRow_(e) {
  return [
    str_(e.id), str_(e.name), str_(e.piece), str_(e.composer),
    str_(e.instrument), str_(e.instrument_other),
    str_(e.dur_min), str_(e.dur_sec),
    str_(e.has_accomp), str_(e.accomp_count), str_(e.accomp_inst),
    str_(e.accomp_other), str_(e.accomp_teacher),
    str_(e.contact), str_(e.note), str_(e.at)
  ];
}

function readAll_() {
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (str_(values[i][0]).trim() === '') continue;
    out.push(rowToEntry_(values[i]));
  }
  return out;
}

function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, COL.id, last - 1, 1).getValues();
  var want = str_(id);
  for (var i = 0; i < ids.length; i++) {
    if (str_(ids[i][0]) === want) return i + 2;
  }
  return -1;
}

/* ------------------------------------------------------------------ doGet */

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'list';
    if (action === 'list' || action === 'ping') {
      return json_({ ok: true, entries: PUB_() });
    }
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function PUB_() { return publicView_(readAll_()); }

/* ----------------------------------------------------------------- doPost */

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // 避免兩位家長同時提交造成搶號 / prevents a race between two submissions
    lock.waitLock(20000);

    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = body.action;
    var sh = getSheet_();

    if (action === 'add')    return json_(handleAdd_(sh, body));
    if (action === 'update') return json_(handleUpdate_(sh, body));
    if (action === 'delete') return json_(handleDelete_(sh, body));

    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ---------------------------------------------------------------- actions */

function handleAdd_(sh, body) {
  var e = body.entry || {};
  if (!str_(e.name).trim()) return { ok: false, error: 'missing name' };
  if (!str_(e.piece).trim()) return { ok: false, error: 'missing piece' };
  if (!e.id) e.id = 'r' + new Date().getTime().toString(36);
  e.at = new Date().toISOString();
  sh.appendRow(entryToRow_(e));
  return { ok: true, entry: publicView_([e])[0], entries: PUB_() };
}

function handleUpdate_(sh, body) {
  var row = findRow_(sh, body.id);
  if (row === -1) return { ok: false, error: 'entry not found' };

  var old = rowToEntry_(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0]);
  var e = body.entry || {};
  if (!str_(e.name).trim()) return { ok: false, error: 'missing name' };
  if (!str_(e.piece).trim()) return { ok: false, error: 'missing piece' };

  // 保留 id / 時間 / 聯絡方式 / 備註（編輯畫面看不到、也拿不到舊值）
  e.id = old.id;
  e.at = old.at || new Date().toISOString();
  e.contact = str_(e.contact) || old.contact;
  e.note = str_(e.note) || old.note;

  sh.getRange(row, 1, 1, HEADERS.length).setValues([entryToRow_(e)]);
  return { ok: true, entry: publicView_([e])[0], entries: PUB_() };
}

function handleDelete_(sh, body) {
  var row = findRow_(sh, body.id);
  if (row === -1) return { ok: false, error: 'entry not found' };
  sh.deleteRow(row);
  return { ok: true, entries: PUB_() };
}

/* --------------------------------------------------------------- utilities */

/** 手動執行這個可以看目前有幾筆曲目 */
function SHOW_STATUS() {
  var all = readAll_();
  Logger.log('已收 ' + all.length + ' 筆曲目');
}
