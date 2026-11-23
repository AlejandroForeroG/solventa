import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export type MenuEntry =
  | { kind: 'link'; label: string; href: string; icon?: ReactNode; disabled?: boolean }
  | { kind: 'action'; label: string; onSelect(): void; icon?: ReactNode; disabled?: boolean }
  | { kind: 'radio'; label: string; checked: boolean; onSelect(): void; lang?: string };

export function MenuButton({ label, content, entries, className = '', align = 'end' }: {
  label: string; content: ReactNode; entries: MenuEntry[]; className?: string; align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = () => Array.from(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function onKeyDown(event: React.KeyboardEvent) {
    const list = items(); const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); list[(index + 1) % list.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); list[(index - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); list[list.length - 1]?.focus(); }
    else if (event.key === 'Tab') setOpen(false);
  }
  return <div className={`menu ${className}`} ref={root} onKeyDown={open ? onKeyDown : undefined}>
    <button ref={trigger} type="button" className="menu-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}>{content}</button>
    {open && <div className={`menu-panel menu-panel-${align}`} role="menu" id={id} aria-label={label}>
      {entries.map(entry => entry.kind === 'link'
        ? <a key={entry.label} role="menuitem" className="menu-item" href={entry.href} tabIndex={-1} aria-disabled={entry.disabled || undefined}
          onClick={event => { if (entry.disabled) event.preventDefault(); else setOpen(false); }}>{entry.icon}<span>{entry.label}</span></a>
        : entry.kind === 'action'
        ? <button key={entry.label} type="button" role="menuitem" className="menu-item" tabIndex={-1} aria-disabled={entry.disabled || undefined}
          onClick={() => { if (entry.disabled) return; close(false); entry.onSelect(); }}>{entry.icon}<span>{entry.label}</span></button>
        : <button key={entry.label} type="button" role="menuitemradio" className="menu-item" tabIndex={-1} aria-checked={entry.checked} lang={entry.lang}
          onClick={() => { close(); entry.onSelect(); }}><span className="menu-check" aria-hidden="true">{entry.checked && <Icon name="check" size={16} />}</span><span>{entry.label}</span></button>)}
    </div>}
  </div>;
}
