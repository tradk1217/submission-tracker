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
  return `<ruby>${t}<rt>${escapeHtml(kana)}</rt></ruby>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
}
