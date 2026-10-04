export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return todayStr(d);
}

// 日本の国民の祝日（振替休日・国民の休日を含む）を、その年の分だけ計算して返す。2000〜2099年向け。
// 戻り値：Map（'YYYY-MM-DD' → 祝日名）
export function japaneseHolidays(y) {
  const pad = (n) => String(n).padStart(2, '0');
  const map = new Map();
  const add = (m, d, name) => map.set(`${y}-${pad(m)}-${pad(d)}`, name);
  const nthMonday = (m, n) => {
    const first = new Date(y, m - 1, 1).getDay();
    return 1 + ((1 - first + 7) % 7) + (n - 1) * 7;
  };
  const shun = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  const shu = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

  add(1, 1, '元日');
  add(1, nthMonday(1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (y >= 2020) add(2, 23, '天皇誕生日');
  if (y <= 2018) add(12, 23, '天皇誕生日');
  add(3, shun, '春分の日');
  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  if (y === 2020) add(7, 23, '海の日'); else if (y === 2021) add(7, 22, '海の日'); else add(7, nthMonday(7, 3), '海の日');
  if (y === 2020) add(8, 10, '山の日'); else if (y === 2021) add(8, 8, '山の日'); else add(8, 11, '山の日');
  add(9, nthMonday(9, 3), '敬老の日');
  add(9, shu, '秋分の日');
  if (y === 2020) add(7, 24, 'スポーツの日'); else if (y === 2021) add(7, 23, 'スポーツの日'); else add(10, nthMonday(10, 2), 'スポーツの日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');
  if (y === 2019) { add(5, 1, '天皇の即位の日'); add(10, 22, '即位礼正殿の儀の行われる日'); }

  const base = [...map.keys()].sort();
  // 国民の休日：前後が祝日にはさまれた平日
  for (let d = `${y}-01-02`; d < `${y}-12-31`; d = addDays(d, 1)) {
    if (map.has(d) || new Date(d + 'T00:00:00').getDay() === 0) continue;
    if (base.includes(addDays(d, -1)) && base.includes(addDays(d, 1))) map.set(d, '国民の休日');
  }
  // 振替休日：日曜と重なった祝日は、次の祝日でない日
  for (const k of base) {
    if (new Date(k + 'T00:00:00').getDay() !== 0) continue;
    let d = addDays(k, 1);
    while (map.has(d)) d = addDays(d, 1);
    map.set(d, '振替休日');
  }
  return map;
}

export function formatDateJp(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function formatDateTimeJp(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function deadlineState(deadlineIso) {
  if (!deadlineIso) return null;
  const now = Date.now();
  const dl = new Date(deadlineIso).getTime();
  const diffMs = dl - now;
  const hours = diffMs / 3600000;
  if (diffMs < 0) return { level: 'over', label: '期限超過', hours };
  if (hours <= 24) return { level: 'today', label: '本日締切', hours };
  if (hours <= 48) return { level: 'soon', label: '期限間近', hours };
  return { level: 'ok', label: '余裕あり', hours };
}

// ふりがな任意入力を <ruby> で表示する。無い場合はそのまま表示。
export function rubyHtml(text, kana) {
  const t = escapeHtml(text || '');
  if (!kana) return t;
  if (!/[一-龯]/.test(text || '')) return t; // 漢字を含まない語にはルビを付けない
  return `<ruby>${t}<rt>${escapeHtml(kana)}</rt></ruby>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function katakanaToHiragana(s) {
  return s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// ひらがな・カタカナ・数字・記号のみ(漢字を含まない)かどうか
export function isKanaOrPlain(s) {
  return /^[ぁ-ゖァ-ヶーー0-9０-９a-zA-Z\s・、。ー\-]*$/.test(s);
}

// 氏名入力欄からふりがな欄を自動入力する。
// ・ひらがな/カタカナ/数字だけの入力は、そのままひらがなに変換して反映(毎回、現在の入力全体を見て反映するので途中で止まらない)
// ・漢字を含む場合は自動反映しない(手入力してもらう)
// ・ふりがな欄をユーザーが自分で編集したら、以降は自動上書きしない
export function attachFuriganaAutofill(nameInput, kanaInput) {
  let userEdited = false;
  kanaInput.addEventListener('input', () => { userEdited = true; });
  const sync = () => {
    if (userEdited) return;
    const val = nameInput.value;
    if (val && isKanaOrPlain(val)) {
      kanaInput.value = katakanaToHiragana(val);
    }
  };
  nameInput.addEventListener('input', sync);
  nameInput.addEventListener('compositionend', sync);
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
}

// クラウド同期用の匿名コード。出席番号のような推測されやすい連番ではなく、
// 各端末の名簿に手入力/CSVで揃えて使う、ランダムな識別子。
export function generateCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 紛らわしい文字(0,O,1,I等)を除外
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// シンプルなCSVパーサー（ダブルクォート囲み・カンマ区切りに対応）。
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function csvField(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(rows) {
  const body = rows.map(r => r.map(csvField).join(',')).join('\r\n');
  return '﻿' + body; // Excel向けにBOM付与
}

export function downloadCsv(filename, rows) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
