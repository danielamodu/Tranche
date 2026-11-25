import { loadFont as loadArchivo } from '@remotion/google-fonts/Archivo';
import { loadFont as loadDMSans } from '@remotion/google-fonts/DMSans';
import { loadFont as loadJetBrainsMono } from '@remotion/google-fonts/JetBrainsMono';

export const archivo = loadArchivo('normal', {
  weights: ['600', '700', '800'],
  subsets: ['latin'],
});

export const dmSans = loadDMSans('normal', {
  weights: ['400', '500', '600'],
  subsets: ['latin'],
});

export const jetBrainsMono = loadJetBrainsMono('normal', {
  weights: ['400', '500', '600'],
  subsets: ['latin'],
});

export const FONTS = {
  display: archivo.fontFamily,
  body: dmSans.fontFamily,
  mono: jetBrainsMono.fontFamily,
} as const;

export const COLORS = {
  canvas: '#050505',
  surface: '#0C0C0B',
  elevated: '#141412',
  subtle: '#1C1C19',
  borderHairline: '#1F1F1C',
  borderStrong: '#32322D',
  fgPrimary: '#F8F7EE',
  fgSecondary: '#A3A299',
  fgMuted: '#66655E',
  accentPaper: '#F8F7EE',
  accentInk: '#050505',
  statusLive: '#4ADE80',
  statusWarn: '#FBBF24',
  statusDanger: '#F87171',
} as const;

export const GLASS_STYLE = {
  background: 'rgba(20, 20, 19, 0.72)',
  border: '1px solid rgba(248, 247, 238, 0.12)',
  boxShadow:
    'inset 0 1px 0 rgba(255, 255, 255, 0.11), 0 12px 36px rgba(0, 0, 0, 0.5)',
  backdropFilter: 'blur(20px) saturate(160%)',
} as const;
