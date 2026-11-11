// Minimal text-only PDF 1.4 writer: Helvetica in WinAnsi, A4, no external dependency and no dates, so the same input gives the same bytes.
const PAGE = { width: 595, height: 842, margin: 56 };
const BODY = { size: 11, leading: 15, columns: 84 };
const TITLE = { size: 16, leading: 28 };
const LINES_PER_PAGE = Math.floor((PAGE.height - 2 * PAGE.margin - TITLE.leading) / BODY.leading);

// WinAnsi matches Latin-1 for accents, ñ, ¿ and ¡; anything else is replaced so a stray character never breaks the file.
const winAnsi = (text: string) => [...text].map(char => (char.charCodeAt(0) < 256 && char.charCodeAt(0) >= 32 ? char : '?')).join('');
const literal = (text: string) => '(' + winAnsi(text).replace(/[\\()]/g, match => '\\' + match) + ')';

function wrap(line: string): string[] {
  const rows: string[] = [];
  let row = '';
  for (const word of line.split(' ')) {
    const chunks = word.length > BODY.columns ? word.match(new RegExp(`.{1,${BODY.columns}}`, 'g')) ?? [] : [word];
    for (const chunk of chunks) {
      if (row && (row + ' ' + chunk).length > BODY.columns) { rows.push(row); row = chunk; }
      else row = row ? row + ' ' + chunk : chunk;
    }
  }
  rows.push(row);
  return rows;
}

function pageStream(title: string | null, rows: string[]): string {
  const top = PAGE.height - PAGE.margin;
  const parts = ['BT'];
  let y = top;
  if (title !== null) {
    parts.push(`/F2 ${TITLE.size} Tf 1 0 0 1 ${PAGE.margin} ${y - TITLE.size} Tm ${literal(title)} Tj`);
    y -= TITLE.leading;
  }
  parts.push(`/F1 ${BODY.size} Tf`);
  for (const row of rows) {
    y -= BODY.leading;
    parts.push(`1 0 0 1 ${PAGE.margin} ${y} Tm ${literal(row)} Tj`);
  }
  parts.push('ET');
  return parts.join('\n');
}

export function renderPdf(title: string, lines: string[]): Uint8Array {
  const rows = lines.flatMap(wrap);
  const firstCapacity = LINES_PER_PAGE;
  const chunks = [rows.slice(0, firstCapacity)];
  for (let at = firstCapacity; at < rows.length; at += LINES_PER_PAGE + 2) chunks.push(rows.slice(at, at + LINES_PER_PAGE + 2));
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'];
  const pageIds: number[] = [];
  chunks.forEach((chunk, index) => {
    const stream = pageStream(index === 0 ? title : null, chunk);
    const pageId = objects.length + 1;
    pageIds.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
  let output = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = output.length;
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is below 256, so one character is one byte and the offsets above are byte offsets.
  return Uint8Array.from(output, char => char.charCodeAt(0));
}
