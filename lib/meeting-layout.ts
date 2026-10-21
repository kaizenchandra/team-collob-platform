/** Application layout policy, independent of LiveKit and participant speaking state. */
export function meetingGrid(width: number, height: number, count: number) {
  const w = Math.max(1, width),
    h = Math.max(1, height),
    gap = 8;
  const maxColumns = Math.max(1, Math.floor((w + gap) / 184)),
    maxRows = Math.max(1, Math.floor((h + gap) / 132));
  const capacity = Math.max(1, Math.min(12, maxColumns * maxRows)),
    visible = Math.min(Math.max(1, count), capacity);
  let columns = 1,
    rows = visible,
    best = -Infinity;
  for (let c = 1; c <= Math.min(maxColumns, visible); c++) {
    const r = Math.ceil(visible / c);
    if (r > maxRows) continue;
    const tileWidth = (w - gap * (c - 1)) / c,
      tileHeight = (h - gap * (r - 1)) / r;
    const videoWidth = Math.max(
      1,
      Math.min(tileWidth, ((tileHeight - 36) * 16) / 9),
    );
    const score = videoWidth * videoWidth - (c * r - visible) * 100;
    if (score > best) {
      best = score;
      columns = c;
      rows = r;
    }
  }
  return { capacity, columns, rows };
}

/** Half-width tracks center the incomplete last row without reordering participants. */
export function galleryCell(index: number, count: number, columns: number) {
  const row = Math.floor(index / columns),
    lastRow = Math.ceil(count / columns) - 1,
    remainder = count % columns;
  const start = row === lastRow && remainder ? columns - remainder + 1 : 1;
  return { column: start + 2 * (index % columns), row: row + 1 };
}
