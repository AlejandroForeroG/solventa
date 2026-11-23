const paths = {
  home: 'm3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
  quote: 'M12 5v14M5 12h14',
  policy: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM8 12l3 3 5-6',
  location: 'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  claims: 'M5 5h14v16H5zM9 5V3h6v2M9 10h6M9 14h6M9 18h3',
  audit: 'M10 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM15 15l6 6M7 10l2 2 4-4',
  reports: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6M9 9h2',
  advisor: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2',
  partner: 'M3 21V7l9-4 9 4v14M3 11h18M7 15h2M15 15h2M10 21v-3h4v3',
  privacy: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2',
  workspace: 'M4 5h16v11H4zM8 20h8M12 16v4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  exit: 'M10 4H4v16h6M14 8l4 4-4 4M8 12h12',
  arrow: 'm9 5 7 7-7 7',
  back: 'm15 5-7 7 7 7',
  next: 'm9 5 7 7-7 7',
  forward: 'M5 12h14M13 6l6 6-6 6',
  alert: 'M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 7.5v.5',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  pending: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z',
  chevron: 'm6 9 6 6 6-6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  coins: 'M12 9c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3ZM4 6v5c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 11v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5',
  calculator: 'M6 3h12v18H6zM9 7h6M9 12h1M14 12h1M9 16h1M14 16h1',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  signature: 'M4 20h16M6 16l1-4 9-9 3 3-9 9zM14 5l3 3',
  fingerprint: 'M9 4 7 20M17 4l-2 16M4 9h17M3 15h17',
  seal: 'M12 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM8.5 14 7 21l5-3 5 3-1.5-7',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
