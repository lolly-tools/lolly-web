// SPDX-License-Identifier: MPL-2.0
// Ambient declarations for export vendor libraries that ship no type
// definitions. Only the surface the export bridge actually uses is declared —
// narrow, honest contracts rather than `any`.

declare module 'dom-to-image-more' {
  interface DomToImageOptions {
    width?: number;
    height?: number;
    bgcolor?: string;
    quality?: number;
    scale?: number;
    cacheBust?: boolean;
    imagePlaceholder?: string;
    style?: Record<string, string>;
    filter?: (node: Node) => boolean;
    [k: string]: unknown;
  }
  interface DomToImage {
    toPng(node: Node, options?: DomToImageOptions): Promise<string>;
    toJpeg(node: Node, options?: DomToImageOptions): Promise<string>;
    toSvg(node: Node, options?: DomToImageOptions): Promise<string>;
    toBlob(node: Node, options?: DomToImageOptions): Promise<Blob>;
    toCanvas(node: Node, options?: DomToImageOptions): Promise<HTMLCanvasElement>;
    toPixelData(node: Node, options?: DomToImageOptions): Promise<Uint8ClampedArray>;
  }
  export const toPng: DomToImage['toPng'];
  export const toJpeg: DomToImage['toJpeg'];
  export const toSvg: DomToImage['toSvg'];
  export const toBlob: DomToImage['toBlob'];
  export const toCanvas: DomToImage['toCanvas'];
  export const toPixelData: DomToImage['toPixelData'];
  const lib: DomToImage;
  export default lib;
}

declare module 'gifenc' {
  /** A palette is an array of [r,g,b] (or [r,g,b,a]) tuples. */
  export type GifPalette = number[][];
  export interface GifWriteFrameOpts {
    palette?: GifPalette;
    delay?: number;
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
  }
  export interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: GifWriteFrameOpts): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  }
  export function GIFEncoder(): GifEncoderInstance;
  export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number): GifPalette;
  export function applyPalette(rgba: Uint8ClampedArray | Uint8Array, palette: GifPalette): Uint8Array;
}
