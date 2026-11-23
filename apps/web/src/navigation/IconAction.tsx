import type { MouseEvent } from 'react';
import { Icon, type IconName } from './Icon';

type Common = { label: string; icon: IconName; className?: string; current?: boolean };

export function IconButton({ label, icon, className = '', current, onClick, disabled }: Common & { onClick(): void; disabled?: boolean }) {
  return <button type="button" className={`icon-action ${className}`} aria-label={label} data-tooltip={label} aria-current={current ? 'page' : undefined} disabled={disabled} onClick={onClick}>
    <Icon name={icon} size={20} />
  </button>;
}

export function IconLink({ label, icon, className = '', current, href, onClick }: Common & { href: string; onClick?(event: MouseEvent<HTMLAnchorElement>): void }) {
  return <a className={`icon-action ${className}`} href={href} aria-label={label} data-tooltip={label} aria-current={current ? 'page' : undefined} onClick={onClick}>
    <Icon name={icon} size={20} />
  </a>;
}
