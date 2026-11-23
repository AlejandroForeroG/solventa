// Dependency-free PDF 1.4 writer: standard fonts in WinAnsi, US Letter, no dates, so the same input gives the same bytes.
export type PdfSignature = { section: string; title: string; before: string; signedAt: string; fingerprint: string };
export type PdfOptions = { kicker?: string; meta?: string; stamp?: string; footer?: string; signature?: PdfSignature };

const PAGE = { width: 612, height: 792, left: 60, right: 552, top: 736, bottom: 72 };
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
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

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
  const labelWidth = 172, padding = 7, size = 9.5, leading = 12.5;
  const valueFont = monoValue(value) ? FONT.mono : FONT.sans;
  const valueSize = valueFont === FONT.mono ? 8.5 : size;
  const labelRows = wrap(label, columnsFor(labelWidth - 2 * padding, size, FONT.sans));
  const valueRows = wrap(valueFont === FONT.mono ? value : sentence(value), columnsFor(WIDTH - labelWidth - 2 * padding, valueSize, valueFont));
  const height = Math.max(labelRows.length, valueRows.length) * leading + 2 * padding - 2;
  return { height: height + (last ? 10 : 0), draw(canvas, top) {
    const bottom = top - height;
    canvas.box(PAGE.left, bottom, labelWidth, height, COLOR.fill);
    canvas.box(PAGE.left, bottom, WIDTH, height, undefined, COLOR.rule);
    canvas.line(PAGE.left + labelWidth, bottom, PAGE.left + labelWidth, top);
    if (!first) canvas.line(PAGE.left, top, PAGE.right, top);
    labelRows.forEach((row, index) => canvas.text(PAGE.left + padding, top - padding - 8 - index * leading, row, FONT.sans, size, COLOR.muted));
    valueRows.forEach((row, index) => canvas.text(PAGE.left + labelWidth + padding, top - padding - 8 - index * leading, row, valueFont, valueSize));
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
  return { height: 32, keepWithNext: true, draw(canvas, top) {
    canvas.text(PAGE.left, top - 19, (number ? number + '.  ' : '') + text.toUpperCase(), FONT.bold, 9.5);
    canvas.line(PAGE.left, top - 25, PAGE.right, top - 25, 0.8, COLOR.ink);
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
  const scale = 0.62;
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
  const x = PAGE.left + 280;
  const valueWidth = PAGE.right - (x + 66);
  const facts: [string, string, string][] = [['Fecha y hora', signature.signedAt, FONT.sans], ['Método', 'Código de un solo uso (simulado)', FONT.sans],
    ['Huella', signature.fingerprint.slice(0, 20) + '...', FONT.mono]];
  const rows = facts.map(([label, value, font]) => ({ label, font, lines: wrap(value, columnsFor(valueWidth, 8.5, font as keyof typeof ADVANCE)) }));
  const factsHeight = rows.reduce((sum, row) => sum + row.lines.length * 11.5 + 4, 0);
  return { height: Math.max(108, 34 + factsHeight + 8), draw(canvas, top) {
    const lineY = top - 62;
    canvas.raw(strokeOps(signature.fingerprint, PAGE.left + 4, lineY + 6));
    canvas.line(PAGE.left, lineY, PAGE.left + 240, lineY, 0.8, COLOR.ink);
    canvas.text(PAGE.left, lineY - 14, 'Titular de la póliza', FONT.bold, 9.5);
    canvas.text(PAGE.left, lineY - 27, 'Tomador y asegurado', FONT.sans, 8.5, COLOR.muted);
    canvas.box(x, top - 26, 200, 18, undefined, COLOR.seal, 1);
    canvas.text(x + 8, top - 20.5, 'FIRMADO ELECTRÓNICAMENTE (SIMULADO)', FONT.bold, 7.5, COLOR.seal);
    let y = top - 44;
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
  canvas.text(PAGE.left, PAGE.top, 'solventa', FONT.bold, 22, COLOR.brand);
  ISSUER.forEach((row, index) => canvas.text(PAGE.right - 172, PAGE.top + 10 - index * 11, row, index === 0 ? FONT.bold : FONT.sans, index === 0 ? 9 : 8, index === 0 ? COLOR.ink : COLOR.muted));
  canvas.line(PAGE.left, PAGE.top - 20, PAGE.right, PAGE.top - 20, 1.2, COLOR.ink);
  canvas.line(PAGE.left, PAGE.top - 23, PAGE.right, PAGE.top - 23, 0.5, COLOR.ink);
}

function footer(canvas: Canvas, page: number, total: number, note: string) {
  canvas.line(PAGE.left, PAGE.bottom - 18, PAGE.right, PAGE.bottom - 18, 0.5);
  canvas.text(PAGE.left, PAGE.bottom - 31, note, FONT.sans, 7.5, COLOR.muted);
  canvas.text(PAGE.right - 62, PAGE.bottom - 31, `Página ${page} de ${total}`, FONT.sans, 7.5, COLOR.muted);
}

export function renderPdf(title: string, lines: string[], options: PdfOptions = {}): Uint8Array {
  const titleRows = wrap(title, Math.floor((WIDTH - 118) / (20 * 0.44)));
  const kicker = options.kicker ?? 'Documento';
  const titleHeight = 30 + titleRows.length * 24 + (options.meta ? 30 : 14);
  const pages = paginate(blocksFor(lines, options), PAGE.top - 36 - titleHeight);
  const note = options.footer ? `Solventa Seguros · ${options.footer} · ${LEGEND}` : `Solventa Seguros · ${LEGEND}`;
  const streams = pages.map((blocks, index) => {
    const canvas = new Canvas();
    letterhead(canvas);
    let y = PAGE.top - 36;
    if (index === 0) {
      canvas.text(PAGE.left, y - 10, winAnsi(kicker).toUpperCase(), FONT.sans, 8, COLOR.muted);
      titleRows.forEach((row, rowIndex) => canvas.text(PAGE.left, y - 34 - rowIndex * 24, row, FONT.serif, 20));
      if (options.meta) canvas.text(PAGE.left, y - 34 - titleRows.length * 24 - 6, options.meta, FONT.sans, 9, COLOR.muted);
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
