import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { COLORS, FONTS, GLASS_STYLE } from '../theme';
import {
  EASE_DRAWER,
  EASE_OUT_EXPO,
  LiveDot,
  SerratedBottom,
  TrancheStubLogo,
} from '../components/Primitives';

export const Scene3Ticket: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Floating glass nav pill enters at top
  const navSpring = spring({
    frame: frame - 6,
    fps,
    config: { damping: 22, stiffness: 180 },
  });
  const navY = interpolate(navSpring, [0, 1], [-40, 0]);
  const navOpacity = interpolate(frame, [4, 22], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Active tab slides from Trade (0) to Tickets (1) around frame 92
  const tabSlide = interpolate(frame, [90, 114], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_DRAWER,
  });

  // Offer row enters (frames 16-105), gets clicked at frame 76, then yields to Ticket
  const offerEnter = spring({
    frame: frame - 16,
    fps,
    config: { damping: 22, stiffness: 170 },
  });
  const buttonPress = interpolate(frame, [72, 78, 86], [1, 0.94, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const offerExit = interpolate(frame, [92, 116], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });

  // Hero ExecutionTicket enters at frame 108
  const ticketSpring = spring({
    frame: frame - 108,
    fps,
    config: { damping: 18, stiffness: 145, mass: 0.9 },
  });
  const ticketY = interpolate(ticketSpring, [0, 1], [90, 0]);
  const ticketScale = interpolate(ticketSpring, [0, 1], [0.88, 1]);
  const ticketRotate = interpolate(ticketSpring, [0, 1], [-4, 0]);
  const ticketOpacity = interpolate(frame, [106, 124], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Live countdown on ticket (09:59 -> 09:55)
  const elapsedSec = Math.floor(Math.max(0, frame - 115) / 60);
  const secondsLeft = Math.max(0, 59 - elapsedSec);
  const countdownText = `09:${String(secondsLeft).padStart(2, '0')}`;

  // Fill progress bar animates at frame 230-295 -> SETTLED
  const fillPct = interpolate(frame, [225, 290], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });
  const isSettled = frame >= 285;
  const settledSpring = spring({
    frame: frame - 285,
    fps,
    config: { damping: 18, stiffness: 200 },
  });

  // Exit scene (frames 365-390)
  const exitProgress = interpolate(frame, [365, 390], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE_OUT_EXPO,
  });

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        opacity: interpolate(exitProgress, [0, 1], [1, 0]),
        transform: `scale(${interpolate(exitProgress, [0, 1], [1, 0.96])})`,
      }}
    >
      {/* Floating Apple Liquid Glass Top Nav */}
      <div
        style={{
          position: 'absolute',
          top: 64,
          left: '50%',
          transform: `translateX(-50%) translateY(${navY}px)`,
          opacity: navOpacity,
          ...GLASS_STYLE,
          borderRadius: 9999,
          padding: '8px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            padding: '0 18px 0 12px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <TrancheStubLogo width={76} />
        </div>

        {/* Segmented pill with sliding highlight */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            backgroundColor: 'rgba(255,255,255,0.04)',
            borderRadius: 9999,
            padding: 4,
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 4,
              bottom: 4,
              left: 4 + tabSlide * 116,
              width: 112,
              borderRadius: 9999,
              backgroundColor: COLORS.accentPaper,
            }}
          />
          {['Trade', 'Tickets', 'Vault'].map((label, idx) => {
            const isActive =
              (idx === 0 && tabSlide < 0.5) || (idx === 1 && tabSlide >= 0.5);
            return (
              <div
                key={label}
                style={{
                  position: 'relative',
                  zIndex: 1,
                  width: 112,
                  textAlign: 'center',
                  padding: '8px 0',
                  fontFamily: FONTS.body,
                  fontWeight: 600,
                  fontSize: 16,
                  color: isActive ? COLORS.accentInk : COLORS.fgSecondary,
                }}
              >
                {label}
              </div>
            );
          })}
        </div>

        <div
          style={{
            padding: '8px 16px',
            fontFamily: FONTS.mono,
            fontSize: 14,
            color: COLORS.fgSecondary,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <LiveDot color={COLORS.statusLive} size={7} />
          <span>HSK 177</span>
        </div>
      </div>

      {/* Phase A: Offer Row & Reserve Click */}
      {offerExit < 0.99 && (
        <div
          style={{
            position: 'absolute',
            width: 1240,
            opacity:
              interpolate(frame, [14, 30], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }) *
              (1 - offerExit),
            transform: `translateY(${
              interpolate(offerEnter, [0, 1], [40, 0]) - offerExit * 40
            }px) scale(${1 - offerExit * 0.05})`,
          }}
        >
          <div
            style={{
              fontFamily: FONTS.mono,
              fontSize: 15,
              letterSpacing: '0.09em',
              color: COLORS.fgMuted,
              marginBottom: 18,
            }}
          >
            LIVE COMMITMENT OFFER · FIXED STRIKE
          </div>

          <div
            style={{
              backgroundColor: COLORS.surface,
              border: `1px solid ${COLORS.borderStrong}`,
              borderRadius: 22,
              padding: '32px 40px',
              display: 'grid',
              gridTemplateColumns: '1.3fr 1fr 1fr 0.8fr 0.8fr auto',
              alignItems: 'center',
              gap: 24,
              boxShadow: '0 24px 64px -16px rgba(0,0,0,0.75)',
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: FONTS.display,
                  fontWeight: 700,
                  fontSize: 28,
                  color: COLORS.fgPrimary,
                }}
              >
                WETH / USDC
              </div>
              <div
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 13,
                  color: COLORS.fgMuted,
                  marginTop: 4,
                }}
              >
                VAULT #01 · SOLVENT
              </div>
            </div>

            {[
              { label: 'AVAILABLE', value: '25.00 WETH' },
              { label: 'FIXED PRICE', value: '$3,000.00' },
              { label: 'PREMIUM', value: '15 bps' },
              { label: 'MAX LOCK', value: '10m' },
            ].map((col) => (
              <div key={col.label}>
                <div
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 12,
                    letterSpacing: '0.08em',
                    color: COLORS.fgMuted,
                    marginBottom: 6,
                  }}
                >
                  {col.label}
                </div>
                <div
                  style={{
                    fontFamily: FONTS.mono,
                    fontWeight: 600,
                    fontSize: 22,
                    color: COLORS.fgPrimary,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {col.value}
                </div>
              </div>
            ))}

            <div
              style={{
                transform: `scale(${buttonPress})`,
                backgroundColor: COLORS.accentPaper,
                color: COLORS.accentInk,
                fontFamily: FONTS.body,
                fontWeight: 600,
                fontSize: 18,
                padding: '16px 32px',
                borderRadius: 9999,
                boxShadow:
                  frame >= 72 && frame <= 88
                    ? '0 0 0 8px rgba(248, 247, 238, 0.18)'
                    : 'none',
              }}
            >
              Reserve
            </div>
          </div>
        </div>
      )}

      {/* Phase B: Hero ERC-721 ExecutionTicket */}
      {frame >= 104 && (
        <div
          style={{
            marginTop: 72,
            display: 'flex',
            alignItems: 'center',
            gap: 72,
            opacity: ticketOpacity,
            transform: `translateY(${ticketY}px) scale(${ticketScale}) rotate(${ticketRotate}deg)`,
          }}
        >
          {/* Serrated Ticket Stub Card */}
          <div
            style={{
              width: 560,
              filter: 'drop-shadow(0 36px 80px rgba(0, 0, 0, 0.85))',
            }}
          >
            {/* Top Cream Header Strip */}
            <div
              style={{
                backgroundColor: COLORS.accentPaper,
                color: COLORS.accentInk,
                borderTopLeftRadius: 22,
                borderTopRightRadius: 22,
                padding: '26px 34px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 13,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    opacity: 0.65,
                  }}
                >
                  ERC-721 EXECUTION TICKET
                </div>
                <div
                  style={{
                    fontFamily: FONTS.display,
                    fontWeight: 800,
                    fontSize: 34,
                    letterSpacing: '-0.03em',
                    marginTop: 2,
                  }}
                >
                  Ticket #042
                </div>
              </div>
              <div
                style={{
                  fontFamily: FONTS.mono,
                  fontWeight: 600,
                  fontSize: 28,
                  fontVariantNumeric: 'tabular-nums',
                  padding: '8px 16px',
                  borderRadius: 12,
                  backgroundColor: 'rgba(5,5,5,0.08)',
                }}
              >
                {countdownText}
              </div>
            </div>

            {/* Ticket Body */}
            <div
              style={{
                backgroundColor: COLORS.surface,
                borderLeft: `1px solid ${COLORS.borderStrong}`,
                borderRight: `1px solid ${COLORS.borderStrong}`,
                padding: '32px 34px 28px',
                display: 'flex',
                flexDirection: 'column',
                gap: 24,
              }}
            >
              {/* Key Numbers */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 24,
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 13,
                      color: COLORS.fgMuted,
                      letterSpacing: '0.08em',
                    }}
                  >
                    LOCKED INVENTORY
                  </div>
                  <div
                    style={{
                      fontFamily: FONTS.mono,
                      fontWeight: 600,
                      fontSize: 36,
                      color: COLORS.fgPrimary,
                      marginTop: 6,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    10.00 WETH
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontFamily: FONTS.mono,
                      fontSize: 13,
                      color: COLORS.fgMuted,
                      letterSpacing: '0.08em',
                    }}
                  >
                    FIXED STRIKE
                  </div>
                  <div
                    style={{
                      fontFamily: FONTS.mono,
                      fontWeight: 600,
                      fontSize: 36,
                      color: COLORS.fgPrimary,
                      marginTop: 6,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    $3,000.00
                  </div>
                </div>
              </div>

              {/* Perforated Dashed Divider */}
              <div
                style={{
                  borderTop: `2px dashed ${COLORS.borderStrong}`,
                  margin: '4px 0',
                }}
              />

              {/* Exercise Progress Bar */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontFamily: FONTS.mono,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: COLORS.fgSecondary }}>
                    EXERCISE FILL
                  </span>
                  <span
                    style={{
                      color: isSettled ? COLORS.statusLive : COLORS.fgPrimary,
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {Math.round(fillPct)}% ·{' '}
                    {((fillPct / 100) * 10).toFixed(2)} WETH
                  </span>
                </div>
                <div
                  style={{
                    width: '100%',
                    height: 10,
                    backgroundColor: COLORS.elevated,
                    borderRadius: 9999,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${fillPct}%`,
                      height: '100%',
                      backgroundColor: isSettled
                        ? COLORS.statusLive
                        : COLORS.accentPaper,
                      borderRadius: 9999,
                    }}
                  />
                </div>
              </div>

              {/* Capabilities Footer */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingTop: 4,
                }}
              >
                <div style={{ display: 'flex', gap: 10 }}>
                  {['Transfer', 'Split', 'Exercise'].map((action) => (
                    <span
                      key={action}
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 13,
                        color: COLORS.fgSecondary,
                        padding: '6px 12px',
                        borderRadius: 8,
                        backgroundColor: COLORS.elevated,
                        border: `1px solid ${COLORS.borderHairline}`,
                      }}
                    >
                      {action}
                    </span>
                  ))}
                </div>

                {isSettled && (
                  <div
                    style={{
                      transform: `scale(${interpolate(
                        settledSpring,
                        [0, 1],
                        [0.8, 1]
                      )})`,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      fontFamily: FONTS.mono,
                      fontSize: 13,
                      fontWeight: 600,
                      color: COLORS.statusLive,
                      padding: '6px 14px',
                      borderRadius: 9999,
                      backgroundColor: 'rgba(74, 222, 128, 0.12)',
                      border: '1px solid rgba(74, 222, 128, 0.35)',
                    }}
                  >
                    <LiveDot color={COLORS.statusLive} size={7} pulse={false} />
                    SETTLED
                  </div>
                )}
              </div>
            </div>

            {/* Signature Serrated Bottom Edge */}
            <SerratedBottom
              width={560}
              fill={COLORS.surface}
              teeth={14}
              height={16}
            />
          </div>

          {/* Right Editorial Explanation */}
          <div
            style={{
              maxWidth: 560,
              display: 'flex',
              flexDirection: 'column',
              gap: 24,
            }}
          >
            <div
              style={{
                fontFamily: FONTS.mono,
                fontSize: 15,
                letterSpacing: '0.1em',
                color: COLORS.fgMuted,
              }}
            >
              02 / BEARER EXECUTION TICKET
            </div>
            <div
              style={{
                fontFamily: FONTS.display,
                fontWeight: 700,
                fontSize: 56,
                lineHeight: 1.06,
                letterSpacing: '-0.03em',
                color: COLORS.fgPrimary,
              }}
            >
              Reserve once.
              <br />
              Execute on your terms.
            </div>
            <div
              style={{
                fontFamily: FONTS.body,
                fontSize: 23,
                lineHeight: 1.5,
                color: COLORS.fgSecondary,
              }}
            >
              Pay a small upfront premium to mint a transferable ERC-721 ticket.
              Hold it, split it across orders, or fill partially with zero price
              impact.
            </div>
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
