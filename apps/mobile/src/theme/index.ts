import { brandColors } from '@solventa/assets';

export const theme = {
  colors: {
    background: '#F2F0EA',
    foreground: '#142C28',
    surface: brandColors.white,
    primary: brandColors.green,
    primaryDark: brandColors.dark,
    onPrimary: brandColors.white,
    muted: '#596C66',
    border: '#DFE5DF',
    mint: '#DFF5EB',
    onMint: '#176449',
    warningSurface: '#FFF3DE',
    warningText: '#785116',
  },
  spacing: {
    lg: 24,
    xl: 32,
  },
} as const;
