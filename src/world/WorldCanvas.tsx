"use client";

// The 3D office behind the floating UI. Mounted once (next/dynamic, no SSR) and
// never remounted: quality changes only touch reactive props (shadows, dpr) and
// components that read it from the store.

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Component, type ReactNode, useRef, useState } from "react";
import * as THREE from "three";
import { CONFIG } from "@/shared/config.ts";
import { CAMERA } from "@/shared/ui/cameraView.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { CameraController } from "./CameraController.tsx";
import { debugEnabled, publishDebugStats } from "./debugStats.ts";
import { handlePointerMissed, InteractionManager, rememberPointerDown } from "./InteractionManager.tsx";
import { Lighting } from "./Lighting.tsx";
import { OfficeEnvironment } from "./OfficeEnvironment.tsx";
import { Workstations } from "./Workstations.tsx";

let canvasesCreated = 0;

/** Tells the loading screen the office is on screen after a few rendered frames. */
function ReadySignal() {
  const frames = useRef(0);
  useFrame(() => {
    if (frames.current > CONFIG.world.readyFrames) return;
    frames.current++;
    if (frames.current === CONFIG.world.readyFrames) useWorldStore.getState().setSceneReady();
  });
  return null;
}

/** Renderer numbers for the ?debug=1 overlay. gl.info at frame start holds the previous frame. */
function DebugProbe() {
  const gl = useThree((s) => s.gl);
  const window = useRef({ start: 0, frames: 0 });
  useFrame(({ clock }) => {
    const w = window.current;
    w.frames++;
    const now = clock.elapsedTime * 1000;
    if (now - w.start < CONFIG.world.debugRefreshMs) return;
    publishDebugStats({
      fps: Math.round((w.frames * 1000) / (now - w.start)),
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      textures: gl.info.memory.textures,
      geometries: gl.info.memory.geometries,
    });
    w.start = now;
    w.frames = 0;
  });
  return null;
}

/** Without WebGL the app still works: the office stays empty and the loading screen moves on. */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[world] the 3D office could not start", error);
    useWorldStore.getState().setSceneReady();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** The frame rate keeps dropping: switch to Performance (unless ?quality= forces a quality). */
function fallBack(): void {
  const store = useWorldStore.getState();
  if (store.qualitySource !== "url" && store.quality !== "low") store.setQuality("low", "auto");
}

export default function WorldCanvas() {
  const quality = useWorldStore((s) => s.quality);
  const high = quality === "high";
  const [debug] = useState(debugEnabled);

  return (
    <SceneBoundary>
      <Canvas
        shadows={high ? "percentage" : false}
        dpr={high ? [...CONFIG.world.dpr.high] : [...CONFIG.world.dpr.low]}
        camera={{ position: [0, 20, 30], fov: CAMERA.fov, near: 0.1, far: 220 }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.2;
          canvasesCreated++;
          if (process.env.NODE_ENV !== "production") console.info(`[world] canvas created (${canvasesCreated})`);
        }}
        onPointerDown={rememberPointerDown}
        onPointerMissed={handlePointerMissed}
        onPointerLeave={() => useWorldStore.getState().setHovered(null)}
      >
        <color attach="background" args={["#080b10"]} />
        <fog attach="fog" args={["#0a0e15", 48, 130]} />
        <PerformanceMonitor flipflops={2} onFallback={fallBack}>
          <Lighting />
          <OfficeEnvironment />
          <Workstations />
          <InteractionManager />
          <CameraController />
        </PerformanceMonitor>
        <ReadySignal />
        {debug && <DebugProbe />}
      </Canvas>
    </SceneBoundary>
  );
}
