import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { BackgroundGrid } from './components/Primitives';
import { COLORS } from './theme';
import { Scene1Intro } from './scenes/Scene1Intro';
import { Scene2Contrast } from './scenes/Scene2Contrast';
import { Scene3Ticket } from './scenes/Scene3Ticket';
import { Scene4Flow } from './scenes/Scene4Flow';
import { Scene5Outro } from './scenes/Scene5Outro';

export const TrancheIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const progressWidth = interpolate(frame, [0, durationInFrames], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.canvas }}>
      <BackgroundGrid />

      {/* Scene 1: Brand Stamp & Thesis (0.0s - 4.0s) */}
      <Sequence from={0} durationInFrames={240}>
        <Scene1Intro />
      </Sequence>

      {/* Scene 2: AMM Slippage vs Tranche Commitment (4.0s - 9.0s) */}
      <Sequence from={240} durationInFrames={300}>
        <Scene2Contrast />
      </Sequence>

      {/* Scene 3: Live Offer -> Reserve -> ERC-721 ExecutionTicket (9.0s - 15.5s) */}
      <Sequence from={540} durationInFrames={390}>
        <Scene3Ticket />
      </Sequence>

      {/* Scene 4: 3-Step Lifecycle + Verification Proof Strip (15.5s - 20.0s) */}
      <Sequence from={930} durationInFrames={270}>
        <Scene4Flow />
      </Sequence>

      {/* Scene 5: Closing Lockup (20.0s - 24.0s) */}
      <Sequence from={1200} durationInFrames={240}>
        <Scene5Outro />
      </Sequence>

      {/* Subtle architectural timeline hairline along bottom edge */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 3,
          backgroundColor: 'rgba(248, 247, 238, 0.06)',
        }}
      >
        <div
          style={{
            width: `${progressWidth}%`,
            height: '100%',
            backgroundColor: 'rgba(248, 247, 238, 0.35)',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
