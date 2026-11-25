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

export const Scene2Contrast: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Left card (AMM Problem) enters first
  const leftSpring = spring({
    frame: frame - 12,
    fps,
    config: { damping: 22, stiffness: 165 },
  });
  const leftY = interpolate(leftSpring, [0, 1], [48, 0]);
  const leftOpacity = interpolate(frame, [10, 26], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Slippage counter ticks up from 0.0 to 24.0
  const slippageVal = interpolate(frame, [30, 105], [0, 24.0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });
  const barWidth = interpolate(frame, [30, 105], [4, 88], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });

  // Right card (Tranche Solution) arrives cleanly at frame 105
  const rightSpring = spring({
    frame: frame - 105,
    fps,
    config: { damping: 20, stiffness: 170 },
  });
  const rightY = interpolate(rightSpring, [0, 1], [54, 0]);
  const rightOpacity = interpolate(frame, [103, 120], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Dim left card slightly once Tranche card lands
  const leftDim = interpolate(frame, [108, 136], [1, 0.45], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });

  // Exit transition (frames 275-300)
  const exitProgress = interpolate(frame, [275, 300], [0, 1], {
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
          gap: 44,
        }}
      >
        {/* Section kicker + heading */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <MaskedLine startFrame={0} duration={22}>
            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 16,
                letterSpacing: '0.1em',
                color: COLORS.fgMuted,
                textTransform: 'uppercase',
              }}
            >
              01 / EXECUTION CERTAINTY
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
              Passive pools leak value. Commitments lock it.
            </div>
          </MaskedLine>
        </div>

        {/* Two-column comparison */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 32,
          }}
        >
          {/* Passive AMM Card */}
          <div
            style={{
              opacity: leftOpacity * leftDim,
              transform: `translateY(${leftY}px)`,
              backgroundColor: COLORS.surface,
              border: `1px solid ${COLORS.borderHairline}`,
              borderRadius: 24,
              padding: 44,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              minHeight: 420,
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
                  letterSpacing: '0.08em',
                  color: COLORS.fgMuted,
                }}
              >
                PASSIVE AMM POOL
              </span>
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 14,
                  color: COLORS.statusDanger,
                  padding: '6px 12px',
                  borderRadius: 9999,
                  backgroundColor: 'rgba(248, 113, 113, 0.1)',
                  border: '1px solid rgba(248, 113, 113, 0.25)',
                }}
              >
                $10,000 ORDER
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div
                style={{
                  fontFamily: FONTS.mono,
                  fontWeight: 600,
                  fontSize: 84,
                  lineHeight: 1,
                  letterSpacing: '-0.04em',
                  color: COLORS.statusDanger,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                -{slippageVal.toFixed(1)}%
              </div>
              <div
                style={{
                  fontFamily: FONTS.body,
                  fontSize: 22,
                  color: COLORS.fgSecondary,
                }}
              >
                Price impact on thin HashKey pools (2.7% – 24%)
              </div>

              {/* Impact meter */}
              <div
                style={{
                  width: '100%',
                  height: 10,
                  backgroundColor: COLORS.elevated,
                  borderRadius: 9999,
                  overflow: 'hidden',
                  marginTop: 8,
                }}
              >
                <div
                  style={{
                    width: `${barWidth}%`,
                    height: '100%',
                    backgroundColor: COLORS.statusDanger,
                    borderRadius: 9999,
                  }}
                />
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 12,
                fontFamily: FONTS.mono,
                fontSize: 14,
                color: COLORS.fgMuted,
              }}
            >
              <span>× MEV EXPOSED</span>
              <span>·</span>
              <span>× UNPREDICTABLE FILL</span>
            </div>
          </div>

          {/* Tranche Commitment Card */}
          <div
            style={{
              opacity: rightOpacity,
              transform: `translateY(${rightY}px)`,
              ...GLASS_STYLE,
              backgroundColor: 'rgba(18, 18, 17, 0.88)',
              border: `1px solid rgba(248, 247, 238, 0.22)`,
              borderRadius: 24,
              padding: 44,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              minHeight: 420,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <LiveDot color={COLORS.statusLive} size={9} />
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 15,
                    letterSpacing: '0.08em',
                    color: COLORS.fgPrimary,
                  }}
                >
                  TRANCHE COMMITMENT
                </span>
              </div>
              <span
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 14,
                  color: COLORS.accentInk,
                  backgroundColor: COLORS.accentPaper,
                  padding: '6px 14px',
                  borderRadius: 9999,
                  fontWeight: 600,
                }}
              >
                1:1 CUSTODY VAULT
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div
                style={{
                  fontFamily: FONTS.mono,
                  fontWeight: 600,
                  fontSize: 84,
                  lineHeight: 1,
                  letterSpacing: '-0.04em',
                  color: COLORS.fgPrimary,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                0.00%
              </div>
              <div
                style={{
                  fontFamily: FONTS.body,
                  fontSize: 22,
                  color: COLORS.fgSecondary,
                }}
              >
                Zero price impact up to full reserved size
              </div>

              {/* Clean locked bar */}
              <div
                style={{
                  width: '100%',
                  height: 10,
                  backgroundColor: COLORS.elevated,
                  borderRadius: 9999,
                  overflow: 'hidden',
                  marginTop: 8,
                }}
              >
                <div
                  style={{
                    width: `${interpolate(frame, [120, 165], [0, 100], {
                      extrapolateLeft: 'clamp',
                      extrapolateRight: 'clamp',
                      easing: EASE_OUT_EXPO,
                    })}%`,
                    height: '100%',
                    backgroundColor: COLORS.statusLive,
                    borderRadius: 9999,
                  }}
                />
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 12,
                fontFamily: FONTS.mono,
                fontSize: 14,
                color: COLORS.fgPrimary,
              }}
            >
              <span
                style={{
                  padding: '5px 12px',
                  borderRadius: 8,
                  backgroundColor: COLORS.subtle,
                  border: `1px solid ${COLORS.borderStrong}`,
                }}
              >
                FIXED STRIKE
              </span>
              <span
                style={{
                  padding: '5px 12px',
                  borderRadius: 8,
                  backgroundColor: COLORS.subtle,
                  border: `1px solid ${COLORS.borderStrong}`,
                }}
              >
                ORACLE + SPREAD
              </span>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
