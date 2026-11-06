export const categories = ['policy', 'payments', 'claims', 'commercial'] as const;
export const channels = ['push', 'email', 'sms'] as const;
export type Category = typeof categories[number];
export type Channel = typeof channels[number];
export type Matrix = Record<Category, Record<Channel, boolean>>;
export type Preferences = { version: number; preferences: Matrix };

export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Number.isSafeInteger(record.version) || Number(record.version) < 0) throw new Error('invalid_response');
  const matrix = record.preferences;
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) throw new Error('invalid_response');
  const rows = matrix as Record<string, unknown>;
  if (Object.keys(rows).length !== categories.length || !categories.every(category => {
    const row = rows[category];
    return !!row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === channels.length
      && channels.every(channel => typeof (row as Record<string, unknown>)[channel] === 'boolean');
  })) throw new Error('invalid_response');
  return { version: Number(record.version), preferences: matrix as Matrix };
}

export function withChannel(matrix: Matrix, category: Category, channel: Channel, enabled: boolean): Matrix {
  return { ...matrix, [category]: { ...matrix[category], [channel]: enabled } };
}
