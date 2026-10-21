import { test } from "node:test";
import assert from "node:assert/strict";
import { meetingGrid, galleryCell } from "../lib/meeting-layout";
test("gallery dimensions stay bounded across counts, panels and orientation changes", () => {
  for (const [width, height] of [
    [1500, 700],
    [936, 500],
    [680, 300],
    [320, 540],
    [320, 190],
    [140, 100],
  ])
    for (const count of [1, 2, 3, 7, 12, 24, 100]) {
      const grid = meetingGrid(width, height, count),
        shown = Math.min(count, grid.capacity);
      assert.ok(grid.capacity >= 1 && grid.capacity <= 12);
      assert.ok(grid.columns * grid.rows >= shown);
      assert.ok((width - (grid.columns - 1) * 8) / grid.columns > 0);
      assert.ok((height - (grid.rows - 1) * 8) / grid.rows > 0);
      if (width >= 176)
        assert.ok((width - (grid.columns - 1) * 8) / grid.columns >= 176);
      if (height >= 124)
        assert.ok((height - (grid.rows - 1) * 8) / grid.rows >= 124);
    }
});
test("small stages reduce capacity, allowing explicit pages instead of shrinking an unbounded group", () => {
  const full = meetingGrid(1200, 700, 50),
    panel = meetingGrid(600, 300, 50),
    mobile = meetingGrid(320, 190, 50);
  assert.equal(full.capacity, 12);
  assert.ok(panel.capacity < full.capacity);
  assert.equal(mobile.capacity, 1);
  const ids = Array.from({ length: 50 }, (_, i) => String(i));
  const pages = Array.from(
    { length: Math.ceil(ids.length / panel.capacity) },
    (_, i) => ids.slice(i * panel.capacity, (i + 1) * panel.capacity),
  );
  assert.deepEqual(pages.flat(), ids);
});

test("partial rows are centered while keeping each participant in a unique bounded cell", () => {
  assert.deepEqual(galleryCell(2, 3, 2), { column: 2, row: 2 });
  for (let count = 1; count <= 12; count++) {
    const grid = meetingGrid(1200, 700, count),
      cells = Array.from({ length: count }, (_, i) =>
        galleryCell(i, count, grid.columns),
      );
    assert.equal(new Set(cells.map((c) => `${c.column}:${c.row}`)).size, count);
    for (const cell of cells) {
      assert.ok(cell.column >= 1 && cell.column + 1 <= grid.columns * 2);
      assert.ok(cell.row >= 1 && cell.row <= grid.rows);
    }
  }
});
