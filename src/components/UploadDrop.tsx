"use client";

/**
 * UploadDrop — the always-available recovery path. File picker, drag-drop
 * and paste all feed the same pipeline: decode the image on a canvas with
 * smoothing off, read its raw pixels, and hand them to imageToGrid (the one
 * place in the engine allowed to use colour distance). The recovered Grid
 * goes to the page, which treats it as a piece with provenance 'recovered'.
 *
 * Errors stay local and in-palette (mono, --ink border) — a failed upload
 * never disturbs an already-loaded piece.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { GridValidationError, imageToGrid } from "@/lib/grid";
import type { Grid } from "@/lib/grid";
import MicroLabel from "@/components/ui/MicroLabel";
import Pill from "@/components/ui/Pill";

export type UploadDropProps = {
  onRecovered: (grid: Grid) => void;
  busy: boolean;
};

const MAX_DIM = 4096;

export default function UploadDrop({ onRecovered, busy }: UploadDropProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const handleBlob = useCallback(
    async (blob: Blob) => {
      setWorking(true);
      setError(null);
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () =>
            reject(new GridValidationError("could not decode that image"));
          el.src = url;
        });
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w < 24 || h < 24) {
          throw new GridValidationError("image is smaller than 24×24 pixels");
        }
        if (w > MAX_DIM || h > MAX_DIM) {
          throw new GridValidationError(
            `image is larger than ${MAX_DIM}px — export a smaller copy first`,
          );
        }
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new GridValidationError("no 2d context available");
        ctx.imageSmoothingEnabled = false; // after every resize
        ctx.drawImage(img, 0, 0);
        const { grid } = imageToGrid(ctx.getImageData(0, 0, w, h));
        onRecovered(grid);
      } catch (err) {
        setError(
          err instanceof GridValidationError
            ? `GridValidationError — ${err.reason}`
            : "RECOVERY FAILED — that image did not resolve to a pixel grid",
        );
      } finally {
        URL.revokeObjectURL(url);
        setWorking(false);
      }
    },
    [onRecovered],
  );

  // Paste anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (busy || working) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void handleBlob(file);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [busy, working, handleBlob]);

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (file && !busy && !working) void handleBlob(file);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && !busy && !working) void handleBlob(file);
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <MicroLabel tone="mute">Recover from image</MicroLabel>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex flex-wrap items-center gap-3 border-2 border-dashed p-3 ${
          dragOver ? "border-accent" : "border-line"
        }`}
      >
        <Pill
          variant="card"
          onClick={() => inputRef.current?.click()}
          disabled={busy || working}
          className="font-mono"
        >
          {working ? "READING PIXELS…" : "UPLOAD IMAGE"}
        </Pill>
        <span className="text-[13px] text-mute">
          or drop / paste a screenshot of a piece
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={onFileChange}
          className="hidden"
          aria-label="Upload an image of a piece"
        />
      </div>
      {error !== null && (
        <p className="border-2 border-ink p-3 font-mono text-[12px] leading-snug text-ink">
          {error}
        </p>
      )}
    </div>
  );
}
