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

export const Scene1Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Logo drops in with clean physical weight
  const logoSpring = spring({
    frame: frame - 8,
    fps,
    config: { damping: 20, stiffness: 170, mass: 0.85 },
  });
  const logoY = interpolate(logoSpring, [0, 1], [-48, 0]);
  const logoScale = interpolate(logoSpring, [0, 1], [0.88, 1]);
  const logoOpacity = interpolate(frame, [6, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Pill fade in
  const pillOpacity = interpolate(frame, [22, 42], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });
  const pillY = interpolate(frame, [22, 42], [14, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });

  // Subtle horizontal divider sweep
  const ruleWidth = interpolate(frame, [30, 62], [0, 140], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });

  // Exit transition (frames 215-240)
  const exitProgress = interpolate(frame, [215, 240], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });
  const exitOpacity = interpolate(exitProgress, [0, 1], [1, 0]);
  const exitScale = interpolate(exitProgress, [0, 1], [1, 0.96]);
  const exitY = interpolate(exitProgress, [0, 1], [0, -24]);

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        opacity: exitOpacity,
        transform: `translateY(${exitY}px) scale(${exitScale})`,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 36,
        }}
      >
        {/* Top floating glass status pill */}
        <div
          style={{
            opacity: pillOpacity,
            transform: `translateY(${pillY}px)`,
          }}
        >
          <GlassPill>
            <LiveDot color={COLORS.statusLive} size={8} />
            <span style={{ color: COLORS.fgPrimary }}>HASHKEY CHAIN</span>
            <span style={{ color: COLORS.fgMuted }}>·</span>
            <span>EXECUTION COMMITMENTS</span>
          </GlassPill>
        </div>

        {/* Serrated ticket-stub logo */}
        <div
          style={{
            opacity: logoOpacity,
            transform: `translateY(${logoY}px) scale(${logoScale})`,
            filter: 'drop-shadow(0 24px 60px rgba(0, 0, 0, 0.7))',
          }}
        >
          <TrancheStubLogo width={300} />
        </div>

        {/* Hairline rule */}
        <div
          style={{
            width: ruleWidth,
            height: 1,
            backgroundColor: COLORS.borderStrong,
          }}
        />

        {/* Kinetic display headline */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            textAlign: 'center',
          }}
        >
          <MaskedLine startFrame={44} duration={28}>
            <div
              style={{
                fontFamily: FONTS.display,
                fontWeight: 700,
                fontSize: 78,
                lineHeight: 1.04,
                letterSpacing: '-0.035em',
                color: COLORS.fgPrimary,
              }}
            >
              Lock inventory.
            </div>
          </MaskedLine>
          <MaskedLine startFrame={58} duration={28}>
            <div
              style={{
                fontFamily: FONTS.display,
                fontWeight: 700,
                fontSize: 78,
                lineHeight: 1.04,
                letterSpacing: '-0.035em',
                color: COLORS.fgSecondary,
              }}
            >
              Trade without slippage.
            </div>
          </MaskedLine>
        </div>
      </div>
    </AbsoluteFill>
  );
};
