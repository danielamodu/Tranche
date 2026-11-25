import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { COLORS, FONTS, GLASS_STYLE } from '../theme';

export const EASE_OUT_EXPO = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_DRAWER = Easing.bezier(0.32, 0.72, 0, 1);

export const TrancheStubLogo: React.FC<{
  width?: number;
  style?: React.CSSProperties;
}> = ({ width = 260, style }) => {
  const height = Math.round(width * 0.44);
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 260 114"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={style}
    >
      {/* Serrated cream ticket-stub matching assets/brand/tranche-logo-dark.png */}
      <path
        d="M0 4C0 1.79086 1.79086 0 4 0H256C258.209 0 260 1.79086 260 4V112L195 82L130 112L65 82L0 112V4Z"
        fill={COLORS.accentPaper}
      />
      <text
        x="130"
        y="53"
        textAnchor="middle"
        fill={COLORS.accentInk}
        fontFamily={FONTS.display}
        fontWeight="800"
        fontSize="50"
        letterSpacing="-2.4"
      >
        tranche
      </text>
    </svg>
  );
};

export const GlassPill: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => {
  return (
    <div
      style={{
        ...GLASS_STYLE,
        borderRadius: 9999,
        padding: '10px 20px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: FONTS.mono,
        fontSize: 15,
        fontWeight: 500,
        letterSpacing: '0.06em',
        color: COLORS.fgSecondary,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const LiveDot: React.FC<{
  color?: string;
  size?: number;
  pulse?: boolean;
}> = ({ color = COLORS.statusLive, size = 9, pulse = true }) => {
  const frame = useCurrentFrame();
  const ringScale = pulse ? interpolate(frame % 60, [0, 60], [1, 2.4]) : 1;
  const ringOpacity = pulse ? interpolate(frame % 60, [0, 60], [0.55, 0]) : 0;

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      {pulse && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 9999,
            backgroundColor: color,
            transform: `scale(${ringScale})`,
            opacity: ringOpacity,
          }}
        />
      )}
      <span
        style={{
          width: size,
          height: size,
          borderRadius: 9999,
          backgroundColor: color,
        }}
      />
    </span>
  );
};

export const MaskedLine: React.FC<{
  children: React.ReactNode;
  startFrame: number;
  duration?: number;
  style?: React.CSSProperties;
}> = ({ children, startFrame, duration = 26, style }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [0, 1],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: EASE_OUT_EXPO,
    }
  );
  const y = interpolate(progress, [0, 1], [115, 0]);

  return (
    <div style={{ overflow: 'hidden', paddingBottom: 6 }}>
      <div
        style={{
          transform: `translateY(${y}%)`,
          opacity: interpolate(progress, [0, 0.35], [0, 1], {
            extrapolateRight: 'clamp',
          }),
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  );
};

export const SerratedBottom: React.FC<{
  width: number;
  fill?: string;
  teeth?: number;
  height?: number;
}> = ({ width, fill = COLORS.surface, teeth = 16, height = 14 }) => {
  const step = width / teeth;
  let d = `M 0 0 L ${width} 0 L ${width} ${height}`;
  for (let i = teeth; i > 0; i--) {
    const midX = (i - 0.5) * step;
    const leftX = (i - 1) * step;
    d += ` L ${midX} 0 L ${leftX} ${height}`;
  }
  d += ' Z';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block' }}
    >
      <path d={d} fill={fill} />
    </svg>
  );
};

export const BackgroundGrid: React.FC = () => {
  const frame = useCurrentFrame();
  const driftY = interpolate(frame, [0, 1440], [0, -64]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: COLORS.canvas,
        overflow: 'hidden',
      }}
    >
      {/* Subtle architectural grid */}
      <div
        style={{
          position: 'absolute',
          inset: -80,
          backgroundImage: `
            linear-gradient(to right, rgba(248, 247, 238, 0.032) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(248, 247, 238, 0.032) 1px, transparent 1px)
          `,
          backgroundSize: '64px 64px',
          transform: `translateY(${driftY}px)`,
          maskImage:
            'radial-gradient(ellipse 72% 68% at 50% 48%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.35) 60%, rgba(0,0,0,0) 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 72% 68% at 50% 48%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.35) 60%, rgba(0,0,0,0) 100%)',
        }}
      />
      {/* Top optical warm-paper ambient light */}
      <div
        style={{
          position: 'absolute',
          top: -280,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 1400,
          height: 620,
          borderRadius: '50%',
          background:
            'radial-gradient(circle, rgba(248, 247, 238, 0.055) 0%, rgba(248, 247, 238, 0) 68%)',
        }}
      />
    </div>
  );
};
