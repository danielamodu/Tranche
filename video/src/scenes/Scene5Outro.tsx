import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { COLORS, FONTS } from '../theme';
import {
  EASE_OUT_EXPO,
  GlassPill,
  LiveDot,
  MaskedLine,
  TrancheStubLogo,
} from '../components/Primitives';

export const Scene5Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoSpring = spring({
    frame: frame - 8,
    fps,
    config: { damping: 20, stiffness: 155, mass: 0.9 },
  });
  const logoScale = interpolate(logoSpring, [0, 1], [0.9, 1]);
  const logoY = interpolate(logoSpring, [0, 1], [28, 0]);
  const logoOpacity = interpolate(frame, [6, 22], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const pillOpacity = interpolate(frame, [46, 70], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });
  const pillY = interpolate(frame, [46, 70], [16, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 34,
        }}
      >
        <div
          style={{
            opacity: logoOpacity,
            transform: `translateY(${logoY}px) scale(${logoScale})`,
            filter: 'drop-shadow(0 28px 70px rgba(0,0,0,0.8))',
          }}
        >
          <TrancheStubLogo width={340} />
        </div>

        <MaskedLine startFrame={24} duration={28}>
          <div
            style={{
              fontFamily: FONTS.display,
              fontWeight: 700,
              fontSize: 52,
              letterSpacing: '-0.03em',
              color: COLORS.fgPrimary,
              textAlign: 'center',
            }}
          >
            Inventory-backed execution commitments.
          </div>
        </MaskedLine>

        <div
          style={{
            opacity: pillOpacity,
            transform: `translateY(${pillY}px)`,
          }}
        >
          <GlassPill style={{ padding: '12px 26px', fontSize: 16 }}>
            <LiveDot color={COLORS.statusLive} size={8} />
            <span style={{ color: COLORS.fgPrimary }}>HASHKEY CHAIN</span>
            <span style={{ color: COLORS.fgMuted }}>·</span>
            <span>FIXED &amp; FLOATING</span>
            <span style={{ color: COLORS.fgMuted }}>·</span>
            <span>ERC-721 TICKETS</span>
          </GlassPill>
        </div>
      </div>
    </AbsoluteFill>
  );
};
