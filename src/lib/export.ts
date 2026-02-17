// src/lib/export.ts
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // let the download start before revoking
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

export function downloadText(text: string, filename: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  downloadBlob(blob, filename);
}

function escapeCsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Quote if it contains special CSV chars
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const header = columns.map(escapeCsvCell).join(",");
  const lines = rows.map((row) => columns.map((c) => escapeCsvCell(row[c])).join(","));
  return [header, ...lines].join("\n") + "\n";
}