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
