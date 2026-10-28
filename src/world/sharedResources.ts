// Pooled geometries and materials and the canvas textures of the office. Built
// lazily on the client, once, and kept for the page's life (they are the same
// for every project). Per instance things (name plates, the wall screen) build
// their own textures and dispose them on unmount.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

const geometries = new Map<string, THREE.BufferGeometry>();
const materials = new Map<string, THREE.Material>();
const textures = new Map<string, THREE.Texture>();

export function sharedGeometry<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let geometry = geometries.get(key);
  if (geometry === undefined) {
    geometry = make();
    geometries.set(key, geometry);
  }
  return geometry as T;
}

export function sharedMaterial<T extends THREE.Material>(key: string, make: () => T): T {
  let material = materials.get(key);
  if (material === undefined) {
    material = make();
    materials.set(key, material);
  }
  return material as T;
}

function sharedTexture<T extends THREE.Texture>(key: string, make: () => T): T {
  let texture = textures.get(key);
  if (texture === undefined) {
    texture = make();
    textures.set(key, texture);
  }
  return texture as T;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Small deterministic random numbers, so the office looks the same on every load. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2D canvas is not available");
  return [canvas, context];
}

export function canvasTexture(canvas: HTMLCanvasElement, colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** The app's UI font (next/font gives it a generated family name), for text drawn on canvases. */
export function uiFontFamily(): string {
  return getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
}

/** A geometry from parts placed with their own transforms (same attributes on every part). */
export function mergedParts(parts: { geometry: THREE.BufferGeometry; position?: [number, number, number]; rotation?: [number, number, number] }[]): THREE.BufferGeometry {
  const placed = parts.map(({ geometry, position = [0, 0, 0], rotation = [0, 0, 0] }) => {
    const copy = geometry.index === null ? geometry.clone() : geometry.toNonIndexed();
    copy.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1)));
    return copy;
  });
  const merged = mergeGeometries(placed);
  for (const part of placed) part.dispose();
  for (const part of parts) part.geometry.dispose();
  if (merged === null) throw new Error("mergeGeometries failed");
  return merged;
}

export function roundedBox(width: number, height: number, depth: number, radius: number): THREE.BufferGeometry {
  return new RoundedBoxGeometry(width, height, depth, 3, radius);
}

// ── Geometries ──────────────────────────────────────────────────────────────

export const geometry = {
  box: () => sharedGeometry("box", () => new THREE.BoxGeometry(1, 1, 1)),
  plane: () => sharedGeometry("plane", () => new THREE.PlaneGeometry(1, 1)),
  sphere: () => sharedGeometry("sphere", () => new THREE.IcosahedronGeometry(1, 1)),
  /** A unit cylinder standing on y = 0. */
  cylinder: () => sharedGeometry("cylinder", () => new THREE.CylinderGeometry(1, 1, 1, 24).translate(0, 0.5, 0)),
  /** A flat ring on the floor (inner 0.92, outer 1), facing up. */
  ring: () => sharedGeometry("ring", () => new THREE.RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2)),
};

// ── Materials ───────────────────────────────────────────────────────────────

const standard = (key: string, params: THREE.MeshStandardMaterialParameters) => () => sharedMaterial(key, () => new THREE.MeshStandardMaterial(params));

export const material = {
  wall: standard("wall", { color: "#1c2533", roughness: 0.9, metalness: 0.05 }),
  mullion: standard("mullion", { color: "#0b0f15", roughness: 0.5, metalness: 0.6 }),
  metal: standard("metal", { color: "#5d6878", roughness: 0.35, metalness: 0.8 }),
  darkMetal: standard("darkMetal", { color: "#252d39", roughness: 0.45, metalness: 0.7 }),
  desk: standard("desk", { color: "#1a2230", roughness: 0.55, metalness: 0.15 }),
  chair: standard("chair", { color: "#232c3a", roughness: 0.8, metalness: 0.05 }),
  monitor: standard("monitor", { color: "#0b0f15", roughness: 0.4, metalness: 0.5 }),
  pot: standard("pot", { color: "#2c323c", roughness: 0.7, metalness: 0.1 }),
  leaf: standard("leaf", { color: "#ffffff", roughness: 0.75, metalness: 0, flatShading: true }),
  sofa: standard("sofa", { color: "#2b3548", roughness: 0.9, metalness: 0 }),
  wood: standard("wood", { color: "#3b2f27", roughness: 0.6, metalness: 0.05 }),
  hub: standard("hub", { color: "#151b25", roughness: 0.35, metalness: 0.6 }),
  board: standard("board", { color: "#d6dce4", roughness: 0.35, metalness: 0.05 }),
  lightStrip: () => sharedMaterial("lightStrip", () => new THREE.MeshBasicMaterial({ color: new THREE.Color("#7cc4d6").multiplyScalar(0.55) })),
  glass: () =>
    sharedMaterial(
      "glass",
      () =>
        new THREE.MeshPhysicalMaterial({
          color: "#6f93c9",
          roughness: 0.1,
          metalness: 0,
          transmission: 0,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
          envMapIntensity: 0.15,
          specularIntensity: 0.3,
        }),
    ),
  windowGlass: () =>
    sharedMaterial("windowGlass", () => new THREE.MeshPhysicalMaterial({ color: "#9cb8e8", roughness: 0.05, metalness: 0, transparent: true, opacity: 0.07, depthWrite: false })),
  /** Invisible but still hit by the raycaster. */
  hit: () => sharedMaterial("hit", () => new THREE.MeshBasicMaterial({ visible: false })),
};

// ── Canvas textures ─────────────────────────────────────────────────────────

/** Tiles per texture side (the texture repeats across the floor). */
export const FLOOR_TILES_PER_TEXTURE = 4;
export const FLOOR_TILE_METRES = 1.5;

function drawFloor(rough: boolean): HTMLCanvasElement {
  const size = 1024;
  const tile = size / FLOOR_TILES_PER_TEXTURE;
  const [canvas, ctx] = makeCanvas(size, size);
  const random = seeded(rough ? 11 : 7);
  for (let row = 0; row < FLOOR_TILES_PER_TEXTURE; row++) {
    for (let col = 0; col < FLOOR_TILES_PER_TEXTURE; col++) {
      const shade = random();
      if (rough) {
        const value = Math.round(130 + shade * 45);
        ctx.fillStyle = `rgb(${value}, ${value}, ${value})`;
      } else {
        // Base #0f141b with a subtle brightness step per tile.
        const k = 0.94 + shade * 0.14;
        ctx.fillStyle = `rgb(${Math.round(15 * k)}, ${Math.round(20 * k)}, ${Math.round(27 * k)})`;
      }
      ctx.fillRect(col * tile, row * tile, tile, tile);
      // Faint mottling inside the tile.
      for (let i = 0; i < 24; i++) {
        const alpha = rough ? 0.04 : 0.01;
        ctx.fillStyle = random() > 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha * 2})`;
        const r = 10 + random() * 40;
        ctx.beginPath();
        ctx.arc(col * tile + random() * tile, row * tile + random() * tile, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // Thin seams.
  ctx.fillStyle = rough ? "rgb(90, 90, 90)" : "#1a2230";
  for (let i = 0; i <= FLOOR_TILES_PER_TEXTURE; i++) {
    ctx.fillRect(i * tile - 1.5, 0, 3, size);
    ctx.fillRect(0, i * tile - 1.5, size, 3);
  }
  return canvas;
}

function repeating(texture: THREE.Texture, x: number, y: number): THREE.Texture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(x, y);
  texture.anisotropy = 8;
  return texture;
}

export const texture = {
  floor: (repeatX: number, repeatY: number) => sharedTexture("floor", () => repeating(canvasTexture(drawFloor(false)), repeatX, repeatY)),
  floorRoughness: (repeatX: number, repeatY: number) => sharedTexture("floorRough", () => repeating(canvasTexture(drawFloor(true), THREE.NoColorSpace), repeatX, repeatY)),

  /** Dusk: deep blue at the top, a warm band at the horizon (the bottom of the texture). */
  sky: () =>
    sharedTexture("sky", () => {
      const [canvas, ctx] = makeCanvas(4, 512);
      const gradient = ctx.createLinearGradient(0, 0, 0, 512);
      gradient.addColorStop(0, "#0a1022");
      gradient.addColorStop(0.5, "#1b2a52");
      gradient.addColorStop(0.8, "#c9774f");
      gradient.addColorStop(0.9, "#e4a26b");
      gradient.addColorStop(1, "#e4a26b");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 4, 512);
      return canvasTexture(canvas);
    }),

  /** Tower windows: mostly dark, some warm and some cool. The edges stay dark (roofs sample uv 0). */
  skylineWindows: () =>
    sharedTexture("skylineWindows", () => {
      const cols = 16;
      const rows = 32;
      const [canvas, ctx] = makeCanvas(256, 512);
      const random = seeded(3);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 256, 512);
      const cw = 256 / cols;
      const ch = 512 / rows;
      for (let row = 0; row < rows; row++) {
        // Whole floors lit or dark read better than noise.
        const floorLit = random() < 0.45;
        for (let col = 0; col < cols; col++) {
          if (!floorLit || random() > 0.5) continue;
          const warm = random() < 0.7;
          const level = 0.35 + random() * 0.65;
          ctx.fillStyle = warm ? `rgba(255, 196, 128, ${level})` : `rgba(150, 190, 255, ${level})`;
          ctx.fillRect(col * cw + 3, row * ch + 4, cw - 6, ch - 8);
        }
      }
      const result = canvasTexture(canvas);
      result.wrapS = THREE.RepeatWrapping;
      result.wrapT = THREE.RepeatWrapping;
      return result;
    }),

  /** Monitor "code": rows of coloured syntax bars on a dark screen. Repeats vertically to scroll. */
  codeScreen: () =>
    sharedTexture("codeScreen", () => {
      const [canvas, ctx] = makeCanvas(256, 512);
      const random = seeded(5);
      ctx.fillStyle = "#0a111c";
      ctx.fillRect(0, 0, 256, 512);
      const colors = ["#6C9EFF", "#A78BFA", "#5FD39A", "#E8B04A", "#F08A7E", "#7cc4d6", "#b7c1cf", "#b7c1cf"];
      const lineH = 12;
      let indent = 0;
      for (let y = 6; y < 512 - lineH; y += lineH) {
        ctx.fillStyle = "rgba(124, 135, 151, 0.35)";
        ctx.fillRect(6, y + 3, 10, 4);
        if (random() < 0.12) continue; // blank line
        indent = Math.max(0, Math.min(4, indent + (random() < 0.3 ? 1 : random() < 0.3 ? -1 : 0)));
        let x = 26 + indent * 14;
        const tokens = 1 + Math.floor(random() * 5);
        for (let t = 0; t < tokens && x < 240; t++) {
          const w = 8 + random() * 38;
          ctx.fillStyle = colors[Math.floor(random() * colors.length)] as string;
          ctx.globalAlpha = 0.75;
          ctx.fillRect(x, y + 2, Math.min(w, 246 - x), 6);
          x += w + 5;
        }
        ctx.globalAlpha = 1;
      }
      const result = canvasTexture(canvas);
      result.wrapT = THREE.RepeatWrapping;
      result.repeat.set(1, 0.45);
      return result;
    }),

  /** A soft round dot (dust motes). */
  dot: () =>
    sharedTexture("dot", () => {
      const [canvas, ctx] = makeCanvas(64, 64);
      const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.4, "rgba(255,255,255,0.35)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
      return canvasTexture(canvas);
    }),

  /** A soft glowing ring (selection outline on the floor). */
  glowRing: () =>
    sharedTexture("glowRing", () => {
      const [canvas, ctx] = makeCanvas(256, 256);
      const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      gradient.addColorStop(0, "rgba(255,255,255,0)");
      gradient.addColorStop(0.78, "rgba(255,255,255,0)");
      gradient.addColorStop(0.86, "rgba(255,255,255,0.35)");
      gradient.addColorStop(0.9, "rgba(255,255,255,1)");
      gradient.addColorStop(0.94, "rgba(255,255,255,0.35)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 256, 256);
      return canvasTexture(canvas);
    }),
};
