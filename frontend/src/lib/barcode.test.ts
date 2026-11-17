import assert from "node:assert/strict";
import { test } from "node:test";
import { barcodeWidth, code128 } from "./barcode.ts";

test("code128 has start, data, checksum and stop symbols", () => {
  const modules = code128("PP26-001");
  // 11 modules per symbol x (start + 8 chars + checksum) + 13-module stop
  assert.equal(barcodeWidth(modules), 11 * 10 + 13);
  assert.equal(modules.length % 2, 1); // starts and ends with a bar
});

test("known checksum: 'PJJ123C' (Wikipedia example) ends with checksum 54", () => {
  const modules = code128("PJJ123C");
  const checksumPattern = "311321"; // symbol 54
  const symbols = modules.slice(0, -7);
  const last = symbols.slice(-6).join("");
  assert.equal(last, checksumPattern);
});

test("non-printable characters are dropped", () => {
  assert.deepEqual(code128("AB\u0007C"), code128("ABC"));
});
