// Dependency-free PDF 1.4 writer: standard fonts in WinAnsi, US Letter, no dates, so the same input gives the same bytes.
export type PdfSignature = { section: string; title: string; before: string; signedAt: string; fingerprint: string };
export type PdfOptions = { kicker?: string; meta?: string; stamp?: string; footer?: string; signature?: PdfSignature };

const PAGE = { width: 612, height: 792, left: 60, right: 552, top: 736, bottom: 58 };
const WIDTH = PAGE.right - PAGE.left;
const FONT = { sans: 'F1', bold: 'F2', serif: 'F3', mono: 'F4' } as const;
const ADVANCE = { F1: 0.53, F2: 0.58, F3: 0.47, F4: 0.6 } as const;
const COLOR = { ink: '0.082 0.094 0.114', muted: '0.361 0.388 0.427', rule: '0.788 0.773 0.737', fill: '0.961 0.953 0.937', brand: '0.043 0.420 0.373', seal: '0.114 0.369 0.247' };
const ISSUER = ['Solventa Seguros', 'Entidad aseguradora académica simulada', 'Bogotá D.C., Colombia'];
const LEGEND = 'Simulación académica sin validez legal.';

// WinAnsi matches Latin-1 for accents, ñ, ¿ and ¡; anything else is replaced so a stray character never breaks the file.
const WIN_ANSI: Record<string, number> = { '–': 0x96, '—': 0x97, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95 };
const winAnsi = (text: string) => [...text].map(char => (char.charCodeAt(0) < 256 && char.charCodeAt(0) >= 32 ? char : char in WIN_ANSI ? String.fromCharCode(WIN_ANSI[char]) : '?')).join('');
const literal = (text: string) => '(' + winAnsi(text).replace(/[\\()]/g, match => '\\' + match) + ')';
const fixed = (value: number) => (Math.round(value * 100) / 100).toString();
const sentence = (text: string) => /^[a-z0-9]+(-[a-z0-9]+)+$/.test(text) ? text : text.charAt(0).toUpperCase() + text.slice(1);
const HELVETICA: Record<string, number> = { ' ': 278, P: 667, '.': 278, ',': 278 };
const helveticaWidth = (text: string, size: number) => [...text].reduce((sum, char) => sum + (HELVETICA[char] ?? (/[ilj]/.test(char) ? 222 : /[ft]/.test(char) ? 278 : 556)), 0) * size / 1000;
const MARK = '265 4 m 267 4 269 4 271 4 c 275 4 279 4 283 4 c 285 4 286 4 287 4 c 304 4 317 6 330 17 c 331 18 331 18 332 19 c 340 26 344 38 345 48 c 346 62 342 73 333 83 c 321 95 308 98 292 98 c 290 98 289 98 288 98 c 285 98 282 98 279 98 c 274 98 270 98 265 98 c 252 98 239 98 226 98 c 219 98 212 98 204 98 c 200 98 195 98 191 98 c 188 98 185 98 182 98 c 180 98 178 98 176 98 c 161 99 150 103 140 113 c 139 114 138 114 138 115 c 136 117 136 117 133 119 c 131 121 130 123 128 125 c 125 128 123 130 120 133 c 117 135 114 139 111 142 c 109 144 107 146 105 148 c 105 148 104 149 104 149 c 102 151 101 152 99 153 c 92 162 90 171 90 182 c 90 191 95 199 101 205 c 110 211 118 213 128 211 c 136 209 142 205 148 199 c 150 197 152 195 154 194 c 157 191 160 187 163 184 c 165 182 167 180 169 179 c 172 176 175 173 177 170 c 181 166 184 163 188 160 c 190 158 191 156 193 155 c 210 137 236 131 260 131 c 291 131 322 141 347 160 c 348 161 349 161 350 162 c 372 178 389 198 395 225 c 398 245 394 263 384 279 c 382 282 380 284 377 287 c 375 289 374 290 372 293 c 367 298 363 303 358 307 c 356 309 354 311 353 312 c 344 321 344 321 340 325 c 335 329 331 333 327 337 c 318 346 310 354 300 360 c 299 360 299 360 297 362 c 290 366 283 369 275 372 c 275 372 274 372 273 373 c 261 377 249 377 236 377 c 235 377 233 377 232 377 c 228 377 224 377 220 377 c 216 377 213 377 210 377 c 202 377 193 377 185 377 c 177 377 169 377 161 377 c 154 377 146 377 139 377 c 135 377 131 377 127 377 c 123 377 119 377 115 377 c 113 377 112 377 110 377 c 94 377 82 375 70 364 c 61 354 58 343 58 330 c 59 318 64 308 72 299 c 82 291 93 287 106 287 c 107 287 109 287 110 287 c 111 287 112 287 114 287 c 115 287 117 287 118 287 c 121 287 124 287 127 287 c 132 287 137 287 141 287 c 143 287 145 287 146 287 c 147 287 148 287 149 287 c 160 287 171 287 182 287 c 189 287 197 287 204 287 c 208 287 212 287 216 287 c 220 287 224 287 228 287 c 230 287 232 287 234 287 c 246 286 255 283 264 275 c 265 274 266 273 267 271 c 271 267 275 263 280 259 c 281 257 283 255 284 254 c 287 251 290 249 292 246 c 315 224 315 224 315 208 c 315 200 312 192 307 186 c 299 178 291 176 279 176 c 271 176 263 180 257 186 c 256 188 254 189 253 191 c 252 192 251 193 249 194 c 245 198 240 202 236 207 c 235 209 233 210 231 212 c 229 215 226 217 223 220 c 199 244 174 262 139 262 c 128 262 118 261 108 259 c 108 259 108 259 106 259 c 88 254 71 246 57 235 c 55 234 53 232 51 231 c 47 228 43 224 38 220 c 36 218 34 217 32 215 c 16 201 5 180 4 159 c 3 132 15 111 34 92 c 38 88 42 84 46 80 c 47 79 49 77 50 76 c 53 73 55 71 58 68 c 62 64 65 61 68 57 c 71 55 74 52 77 49 c 78 48 79 47 80 45 c 102 24 127 5 160 5 c 160 5 160 5 164 5 c 165 5 166 5 168 5 c 169 5 171 5 172 5 c 177 5 181 5 185 4 c 187 4 190 4 192 4 c 216 4 241 4 265 4 c h';

function wrap(text: string, columns: number): string[] {
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(' ')) {
    const chunks = word.length > columns ? word.match(new RegExp(`.{1,${columns}}`, 'g')) ?? [] : [word];
    for (const chunk of chunks) {
      if (row && (row + ' ' + chunk).length > columns) { rows.push(row); row = chunk; }
      else row = row ? row + ' ' + chunk : chunk;
    }
  }
  rows.push(row);
  return rows;
}
const columnsFor = (width: number, size: number, font: keyof typeof ADVANCE) => Math.max(8, Math.floor(width / (size * ADVANCE[font])));

class Canvas {
  readonly ops: string[] = [];
  text(x: number, y: number, value: string, font: string, size: number, color = COLOR.ink) {
    this.ops.push(`BT ${color} rg /${font} ${fixed(size)} Tf 1 0 0 1 ${fixed(x)} ${fixed(y)} Tm ${literal(value)} Tj ET`);
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.6, color = COLOR.rule) {
    this.ops.push(`${color} RG ${fixed(width)} w ${fixed(x1)} ${fixed(y1)} m ${fixed(x2)} ${fixed(y2)} l S`);
  }
  box(x: number, y: number, width: number, height: number, fill?: string, stroke?: string, strokeWidth = 0.6) {
    if (fill) this.ops.push(`${fill} rg ${fixed(x)} ${fixed(y)} ${fixed(width)} ${fixed(height)} re f`);
    if (stroke) this.ops.push(`${stroke} RG ${fixed(strokeWidth)} w ${fixed(x)} ${fixed(y)} ${fixed(width)} ${fixed(height)} re S`);
  }
  raw(op: string) { this.ops.push(op); }
}

type Block = { height: number; keepWithNext?: boolean; draw(canvas: Canvas, top: number): void };

const SECTION = /^(Sección|Cláusula|Clausula) (\d+) · (.+)$/;
function isClauseItem(line: string) { return /^\d+\.\d+ /.test(line); }
function isFact(line: string) {
  const at = line.indexOf(': ');
  return at > 0 && at <= 48 && !line.startsWith('Documento sintético');
}
const monoValue = (value: string) => /[0-9a-f]{16,}/i.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) || value.startsWith('MOCK-') || /^POL-/.test(value);

function factRow(label: string, value: string, first: boolean, last: boolean): Block {
  const labelWidth = 150, padding = 3.5, size = 9, leading = 11.5;
  const valueFont = monoValue(value) ? FONT.mono : FONT.sans;
  const valueSize = valueFont === FONT.mono ? 8 : size;
  const labelRows = wrap(label, columnsFor(labelWidth - 2 * padding, size, FONT.sans));
  const valueRows = /^[0-9a-f]{64}$/i.test(value) ? [value.slice(0, 32), value.slice(32)]
    : wrap(valueFont === FONT.mono ? value : sentence(value), columnsFor(WIDTH - labelWidth - 2 * padding, valueSize, valueFont));
  const height = Math.max(labelRows.length, valueRows.length) * leading + 2 * padding - 2;
  return { height: height + (last ? 6 : 0), draw(canvas, top) {
    const bottom = top - height;
    canvas.box(PAGE.left, bottom, labelWidth, height, COLOR.fill);
    canvas.box(PAGE.left, bottom, WIDTH, height, undefined, COLOR.rule);
    canvas.line(PAGE.left + labelWidth, bottom, PAGE.left + labelWidth, top);
    if (!first) canvas.line(PAGE.left, top, PAGE.right, top);
    labelRows.forEach((row, index) => canvas.text(PAGE.left + padding + 3, top - padding - 8.5 - index * leading, row, FONT.sans, size, COLOR.muted));
    valueRows.forEach((row, index) => canvas.text(PAGE.left + labelWidth + padding + 3, top - padding - 8.5 - index * leading, row, valueFont, valueSize));
  } };
}

function paragraph(text: string, size = 10, color = COLOR.ink): Block {
  const leading = size * 1.45;
  const rows = wrap(text, columnsFor(WIDTH, size, FONT.sans));
  return { height: rows.length * leading + 6, draw(canvas, top) {
    rows.forEach((row, index) => canvas.text(PAGE.left, top - size - index * leading, row, FONT.sans, size, color));
  } };
}

function heading(text: string, number?: string): Block {
  return { height: 24, keepWithNext: true, draw(canvas, top) {
    canvas.text(PAGE.left, top - 13, (number ? number + '.  ' : '') + text.toUpperCase(), FONT.bold, 9);
    canvas.line(PAGE.left, top - 17.5, PAGE.right, top - 17.5, 0.8, COLOR.ink);
  } };
}

function clauseItem(line: string): Block {
  const at = line.indexOf(' ');
  const code = line.slice(0, at), text = line.slice(at + 1);
  const rows = wrap(text, columnsFor(WIDTH - 36, 9.5, FONT.sans));
  return { height: rows.length * 13.5 + 8, draw(canvas, top) {
    canvas.text(PAGE.left, top - 11, code, FONT.mono, 9);
    rows.forEach((row, index) => canvas.text(PAGE.left + 36, top - 11 - index * 13.5, row, FONT.sans, 9.5, COLOR.muted));
    canvas.line(PAGE.left, top - rows.length * 13.5 - 5, PAGE.right, top - rows.length * 13.5 - 5, 0.4);
  } };
}

function strokeOps(seed: string, x0: number, baseline: number): string {
  const bytes = (seed.match(/[0-9a-f]{2}/gi) ?? ['7f', '3a', 'c1', '5e']).map(pair => parseInt(pair, 16));
  const at = (index: number) => bytes[index % bytes.length];
  const scale = 0.52;
  const point = (x: number, y: number) => `${fixed(x0 + x * scale)} ${fixed(baseline + (46 - y) * scale)}`;
  let x = 10;
  const y = 46;
  const ops = [`${point(x, y - 6)} m`, `${point(x + 4, y - 30)} ${point(x + 18, y - 34)} ${point(x + 14, y - 8)} c`];
  x += 14;
  const letters = 7 + (at(0) % 3);
  for (let i = 0; i < letters; i++) {
    const width = 13 + (at(i + 1) % 11), rise = 10 + (at(i + 7) % 26), dip = 2 + (at(i + 13) % 9);
    ops.push(`${point(x + width * 0.15, y - rise)} ${point(x + width * 0.85, y - rise)} ${point(x + width * 0.45, y - rise * 0.25)} c`);
    ops.push(`${point(x + width * 0.2, y + dip)} ${point(x + width * 0.8, y + dip)} ${point(x + width, y - 2)} c`);
    x += width;
  }
  ops.push(`${point(x + 12, y - 10)} ${point(x + 4, y + 10)} ${point(x - 40, y + 9)} c`);
  ops.push(`${point(x - 84, y + 8)} ${point(22, y + 14)} ${point(14, y + 10)} c`);
  return `0.11 0.165 0.29 RG 1.1 w 1 J 1 j ${ops.join(' ')} S`;
}

function signatureBlock(signature: PdfSignature): Block {
  const x = PAGE.left + 262;
  const valueWidth = PAGE.right - (x + 66);
  const facts: [string, string, string][] = [['Fecha y hora', signature.signedAt, FONT.sans], ['Método', 'Código de un solo uso (simulado)', FONT.sans],
    ['Huella', signature.fingerprint.slice(0, 20) + '...', FONT.mono]];
  const rows = facts.map(([label, value, font]) => ({ label, font, lines: wrap(value, columnsFor(valueWidth, 8.5, font as keyof typeof ADVANCE)) }));
  const factsHeight = rows.reduce((sum, row) => sum + row.lines.length * 11.5 + 4, 0);
  return { height: Math.max(84, 30 + factsHeight + 4), draw(canvas, top) {
    const lineY = top - 46;
    canvas.raw(strokeOps(signature.fingerprint, PAGE.left + 4, lineY + 6));
    canvas.line(PAGE.left, lineY, PAGE.left + 240, lineY, 0.8, COLOR.ink);
    canvas.text(PAGE.left, lineY - 13, 'Titular de la póliza', FONT.bold, 9);
    canvas.text(PAGE.left, lineY - 24, 'Tomador y asegurado', FONT.sans, 8, COLOR.muted);
    canvas.box(x, top - 22, 200, 17, undefined, COLOR.seal, 1);
    canvas.text(x + 8, top - 16.5, 'FIRMADO ELECTRÓNICAMENTE (SIMULADO)', FONT.bold, 7.5, COLOR.seal);
    let y = top - 36;
    for (const row of rows) {
      canvas.text(x, y, row.label, FONT.sans, 8.5, COLOR.muted);
      row.lines.forEach((line, index) => canvas.text(x + 66, y - index * 11.5, line, row.font, row.font === FONT.mono ? 8 : 8.5));
      y -= row.lines.length * 11.5 + 4;
    }
  } };
}

function blocksFor(lines: string[], options: PdfOptions): Block[] {
  const blocks: Block[] = [];
  let factIndex = 0;
  let sections = 0;
  const facts = (index: number) => isFact(lines[index] ?? '');
  lines.forEach((line, index) => {
    if (line === '') { blocks.push({ height: 6, draw() {} }); factIndex = 0; return; }
    if (options.signature && line === options.signature.before) blocks.push(heading(options.signature.title, options.signature.section), signatureBlock(options.signature));
    const section = SECTION.exec(line);
    if (section) {
      blocks.push(section[1] === 'Sección' ? heading(section[3], section[2]) : heading(`Cláusula ${section[2]} · ${section[3]}`));
      sections++; factIndex = 0; return;
    }
    if (isClauseItem(line)) { blocks.push(clauseItem(line)); return; }
    if (facts(index)) {
      const at = line.indexOf(': ');
      if (factIndex === 0 && sections === 0) { blocks.push(heading('Datos del documento')); sections++; }
      blocks.push(factRow(line.slice(0, at), line.slice(at + 2), factIndex === 0, !facts(index + 1)));
      factIndex++;
      return;
    }
    factIndex = 0;
    const notice = line.startsWith('Documento sintético');
    blocks.push(paragraph(line, notice ? 8.5 : 10, notice ? COLOR.muted : COLOR.ink));
  });
  return blocks;
}

function paginate(blocks: Block[], firstTop: number): Block[][] {
  const pages: Block[][] = [[]];
  let y = firstTop;
  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    const needed = block.height + (block.keepWithNext && next ? next.height : 0);
    if (y - needed < PAGE.bottom && pages[pages.length - 1].length > 0) { pages.push([]); y = PAGE.top - 64; }
    pages[pages.length - 1].push(block);
    y -= block.height;
  });
  return pages;
}

function letterhead(canvas: Canvas) {
  const scale = 25 / 381;
  canvas.raw(`q ${COLOR.brand} rg ${fixed(scale)} 0 0 ${fixed(-scale)} ${PAGE.left} ${PAGE.top + 17} cm ${MARK} f Q`);
  canvas.text(PAGE.left + 31, PAGE.top - 1, 'solventa', FONT.bold, 21, COLOR.brand);
  ISSUER.forEach((row, index) => canvas.text(PAGE.right - 172, PAGE.top + 10 - index * 11, row, index === 0 ? FONT.bold : FONT.sans, index === 0 ? 9 : 8, index === 0 ? COLOR.ink : COLOR.muted));
  canvas.line(PAGE.left, PAGE.top - 20, PAGE.right, PAGE.top - 20, 1.2, COLOR.ink);
  canvas.line(PAGE.left, PAGE.top - 23, PAGE.right, PAGE.top - 23, 0.5, COLOR.ink);
}

function footer(canvas: Canvas, page: number, total: number, note: string) {
  canvas.line(PAGE.left, PAGE.bottom - 18, PAGE.right, PAGE.bottom - 18, 0.5);
  canvas.text(PAGE.left, PAGE.bottom - 31, note, FONT.sans, 7.5, COLOR.muted);
  const label = `Página ${page} de ${total}`;
  canvas.text(PAGE.right - helveticaWidth(label, 7.5), PAGE.bottom - 31, label, FONT.sans, 7.5, COLOR.muted);
}

export function renderPdf(title: string, lines: string[], options: PdfOptions = {}): Uint8Array {
  const titleRows = wrap(title, Math.floor((WIDTH - 118) / (20 * 0.44)));
  const kicker = options.kicker ?? 'Documento';
  const titleHeight = 26 + titleRows.length * 24 + (options.meta ? 22 : 10);
  const pages = paginate(blocksFor(lines, options), PAGE.top - 36 - titleHeight);
  const note = options.footer ? `Solventa Seguros · ${options.footer} · ${LEGEND}` : `Solventa Seguros · ${LEGEND}`;
  const streams = pages.map((blocks, index) => {
    const canvas = new Canvas();
    letterhead(canvas);
    let y = PAGE.top - 36;
    if (index === 0) {
      canvas.text(PAGE.left, y - 10, winAnsi(kicker).toUpperCase(), FONT.sans, 8, COLOR.muted);
      titleRows.forEach((row, rowIndex) => canvas.text(PAGE.left, y - 31 - rowIndex * 24, row, FONT.serif, 20));
      if (options.meta) canvas.text(PAGE.left, y - 31 - titleRows.length * 24 - 2, options.meta, FONT.sans, 9, COLOR.muted);
      if (options.stamp) {
        const width = Math.max(80, options.stamp.length * 7.2 + 24);
        canvas.box(PAGE.right - width, y - 40, width, 22, undefined, COLOR.seal, 1.4);
        canvas.text(PAGE.right - width + 12, y - 32, options.stamp.toUpperCase(), FONT.bold, 10, COLOR.seal);
      }
      y -= titleHeight;
    } else y -= 28;
    for (const block of blocks) { block.draw(canvas, y); y -= block.height; }
    footer(canvas, index + 1, pages.length, note);
    return canvas.ops.join('\n');
  });
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', `<< /Title ${literal(title)} /Author ${literal(ISSUER[0] + ' (simulación académica)')} /Subject ${literal(kicker)} /Creator ${literal('Solventa')} /Producer ${literal('Solventa')} >>`];
  const fonts = ['Helvetica', 'Helvetica-Bold', 'Times-Roman', 'Courier'];
  fonts.forEach(name => objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
  const pageIds: number[] = [];
  streams.forEach(stream => {
    const pageId = objects.length + 1;
    pageIds.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R /F4 7 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
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
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is below 256, so one character is one byte and the offsets above are byte offsets.
  return Uint8Array.from(output, char => char.charCodeAt(0));
}
