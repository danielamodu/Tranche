import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { COLORS, FONTS, GLASS_STYLE } from '../theme';
import { EASE_OUT_EXPO, LiveDot, MaskedLine } from '../components/Primitives';

const STEPS = [
  {
    num: '01',
    title: 'Deposit',
    subtitle: '1:1 Custody Vault',
    desc: 'LPs deposit ERC-20 inventory and publish Fixed or Floating commitments.',
  },
  {
    num: '02',
    title: 'Reserve',
    subtitle: 'Upfront Premium',
    desc: 'Traders or execution agents lock capacity and mint an ERC-721 ExecutionTicket.',
  },
  {
    num: '03',
    title: 'Exercise',
    subtitle: 'Zero Price Impact',
    desc: 'Fill partially or fully before expiry. Unused inventory reclaims permissionlessly.',
  },
];

export const Scene4Flow: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Proof strip entrance
  const proofOpacity = interpolate(frame, [95, 120], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });
  const proofY = interpolate(frame, [95, 120], [16, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });

  // Exit transition (frames 245-270)
  const exitProgress = interpolate(frame, [245, 270], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 120px',
        opacity: interpolate(exitProgress, [0, 1], [1, 0]),
        transform: `scale(${interpolate(exitProgress, [0, 1], [1, 0.96])})`,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 1520,
          display: 'flex',
          flexDirection: 'column',
          gap: 52,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <MaskedLine startFrame={0} duration={22}>
            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 16,
                letterSpacing: '0.1em',
                color: COLORS.fgMuted,
              }}
            >
              03 / PROTOCOL LIFECYCLE
            </div>
          </MaskedLine>
          <MaskedLine startFrame={6} duration={26}>
            <div
              style={{
                fontFamily: FONTS.display,
                fontWeight: 700,
                fontSize: 56,
                letterSpacing: '-0.03em',
                color: COLORS.fgPrimary,
              }}
            >
              Three steps from idle inventory to settled fill.
            </div>
          </MaskedLine>
        </div>

        {/* 3-Step Cards with crisp 18-frame stagger */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 28,
          }}
        >
          {STEPS.map((step, i) => {
            const delay = 20 + i * 16;
            const s = spring({
              frame: frame - delay,
              fps,
              config: { damping: 20, stiffness: 165 },
            });
            const y = interpolate(s, [0, 1], [44, 0]);
            const opacity = interpolate(frame, [delay - 2, delay + 14], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });

            return (
              <div
                key={step.num}
                style={{
                  opacity,
                  transform: `translateY(${y}px)`,
                  backgroundColor: COLORS.surface,
                  border: `1px solid ${COLORS.borderStrong}`,
                  borderRadius: 22,
                  padding: 38,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20,
                  minHeight: 300,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 15,
                      fontWeight: 600,
                      color: COLORS.accentInk,
                      backgroundColor: COLORS.accentPaper,
                      padding: '5px 12px',
                      borderRadius: 9999,
                    }}
                  >
                    {step.num}
                  </span>
                  <span
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 13,
                      letterSpacing: '0.06em',
                      color: COLORS.fgMuted,
                      textTransform: 'uppercase',
                    }}
                  >
                    {step.subtitle}
                  </span>
                </div>

                <div
                  style={{
                    fontFamily: FONTS.display,
                    fontWeight: 700,
                    fontSize: 38,
                    letterSpacing: '-0.025em',
                    color: COLORS.fgPrimary,
                    marginTop: 8,
                  }}
                >
                  {step.title}
                </div>

                <div
                  style={{
                    fontFamily: FONTS.body,
                    fontSize: 20,
                    lineHeight: 1.5,
                    color: COLORS.fgSecondary,
                  }}
                >
                  {step.desc}
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom Verification Proof Strip */}
        <div
          style={{
            opacity: proofOpacity,
            transform: `translateY(${proofY}px)`,
            ...GLASS_STYLE,
            borderRadius: 9999,
            padding: '16px 32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontFamily: FONTS.mono,
            fontSize: 15,
            color: COLORS.fgSecondary,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <LiveDot color={COLORS.statusLive} size={8} />
            <span style={{ color: COLORS.fgPrimary }}>INV-1 SOLVENCY</span>
            <span>1:1 ERC-20 bucket accounting</span>
          </div>
          <span style={{ color: COLORS.borderStrong }}>|</span>
          <div>
            <span style={{ color: COLORS.fgPrimary }}>5,120</span> stateful fuzz
            calls · 0 reverts
          </div>
          <span style={{ color: COLORS.borderStrong }}>|</span>
          <div>
            <span style={{ color: COLORS.fgPrimary }}>61 / 61</span> tests
            passing
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
