/** Builds a tiled pixel-art border around a card using the terrain spritesheet. */

export function buildTiledFrame(frame: HTMLElement, card: HTMLElement) {
  const COLS = 22;
  const TILE = 16;
  const TOP_L = 4 * COLS + 12;
  const TOP_M = 4 * COLS + 13;
  const TOP_R = 4 * COLS + 14;
  const SIDE_T = 4 * COLS + 15;
  const SIDE_M = 5 * COLS + 15;
  const SIDE_B = 6 * COLS + 15;

  function makeTile(frameIdx: number, x: number, y: number): HTMLDivElement {
    const d = document.createElement("div");
    d.className = "frame-tile";
    const col = frameIdx % COLS;
    const row = Math.floor(frameIdx / COLS);
    d.style.backgroundPosition = `-${col * TILE}px -${row * TILE}px`;
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    return d;
  }

  const observer = new ResizeObserver(() => {
    frame.querySelectorAll(".frame-tile").forEach((t) => t.remove());
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;

    frame.appendChild(makeTile(TOP_L, 0, 0));
    for (let x = TILE; x < w - TILE; x += TILE) {
      frame.appendChild(makeTile(TOP_M, x, 0));
    }
    frame.appendChild(makeTile(TOP_R, w - TILE, 0));

    frame.appendChild(makeTile(TOP_L, 0, h - TILE));
    for (let x = TILE; x < w - TILE; x += TILE) {
      frame.appendChild(makeTile(TOP_M, x, h - TILE));
    }
    frame.appendChild(makeTile(TOP_R, w - TILE, h - TILE));

    frame.appendChild(makeTile(SIDE_T, 0, TILE));
    for (let y = 2 * TILE; y < h - 2 * TILE; y += TILE) {
      frame.appendChild(makeTile(SIDE_M, 0, y));
    }
    frame.appendChild(makeTile(SIDE_B, 0, h - 2 * TILE));

    const addFlipped = (idx: number, fx: number, fy: number) => {
      const tile = makeTile(idx, fx, fy);
      tile.style.transform = "scaleX(-1)";
      frame.appendChild(tile);
    };
    addFlipped(SIDE_T, w - TILE, TILE);
    for (let y = 2 * TILE; y < h - 2 * TILE; y += TILE) {
      addFlipped(SIDE_M, w - TILE, y);
    }
    addFlipped(SIDE_B, w - TILE, h - 2 * TILE);
  });
  observer.observe(card);
}
