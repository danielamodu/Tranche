import React from 'react';
import { Composition } from 'remotion';
import { TrancheIntro } from './TrancheIntro';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TrancheIntro"
        component={TrancheIntro}
        durationInFrames={1440}
        fps={60}
        width={1920}
        height={1080}
      />
    </>
  );
};
