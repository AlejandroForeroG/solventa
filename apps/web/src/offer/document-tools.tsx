import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const policyNumber = (policyId: string) => `POL-${policyId.slice(0, 8).toUpperCase()}`;

export function savePdf(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function usePrintSheet() {
  const [job, setJob] = useState<{ title: string; pages: ReactNode } | null>(null);
  useEffect(() => {
    if (!job || typeof window.print !== 'function') return;
    const previous = document.title;
    document.title = job.title;
    const finish = () => { document.title = previous; setJob(null); };
    window.addEventListener('afterprint', finish, { once: true });
    try { window.print(); } catch { finish(); }
    return () => { window.removeEventListener('afterprint', finish); document.title = previous; };
  }, [job]);
  return {
    print: (title: string, pages: ReactNode) => setJob({ title, pages }),
    portal: job ? createPortal(<div className="doc-print-root">{job.pages}</div>, document.body) : null,
  };
}

export function signatureStroke(seed: string): string {
  const bytes = (seed.match(/[0-9a-f]{2}/gi) ?? ['7f', '3a', 'c1', '5e', '92', '4b', 'd8', '26', 'a7', '61', 'f0', '18']).map(pair => parseInt(pair, 16));
  const at = (index: number) => bytes[index % bytes.length];
  let x = 10, y = 46;
  let d = `M ${x} ${y - 6} C ${x + 4} ${y - 30} ${x + 18} ${y - 34} ${x + 14} ${y - 8}`;
  x += 14;
  const letters = 7 + (at(0) % 3);
  for (let i = 0; i < letters; i++) {
    const width = 13 + (at(i + 1) % 11);
    const rise = 10 + (at(i + 7) % 26);
    const dip = 2 + (at(i + 13) % 9);
    d += ` C ${x + width * 0.15} ${y - rise} ${x + width * 0.85} ${y - rise} ${x + width * 0.45} ${y - rise * 0.25}`;
    d += ` C ${x + width * 0.2} ${y + dip} ${x + width * 0.8} ${y + dip} ${x + width} ${y - 2}`;
    x += width;
  }
  d += ` C ${x + 12} ${y - 10} ${x + 4} ${y + 10} ${x - 40} ${y + 9} S ${22} ${y + 14} ${14} ${y + 10}`;
  return d;
}

