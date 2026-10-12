/**
 * The parts of gifenc (https://github.com/mattdesl/gifenc, no types of its own) that `pnpm demo:gif` uses. Its Node
 * build is CommonJS whose named exports Node can't see, so it's imported whole: `import gifenc from "gifenc"`.
 */
declare module "gifenc" {
  export type Palette = number[][];
  export type Format = "rgb565" | "rgb444" | "rgba4444";
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: Format },
  ): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: Format): Uint8Array;
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: Palette;
        first?: boolean;
        transparent?: boolean;
        transparentIndex?: number;
        delay?: number;
        repeat?: number;
        dispose?: number;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  const gifenc: { quantize: typeof quantize; applyPalette: typeof applyPalette; GIFEncoder: typeof GIFEncoder };
  export default gifenc;
}
