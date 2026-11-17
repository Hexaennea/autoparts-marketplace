import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRupees, paiseToInput, percentOff, plural, rupees, rupeesShort, warranty } from "./format.ts";

test("rupees formats Indian grouping and paise", () => {
  assert.equal(rupees(124900), "₹1,249");
  assert.equal(rupees(12345678900), "₹12,34,56,789");
  assert.equal(rupees(124950), "₹1,249.50");
  assert.equal(rupees(0), "₹0");
});

test("short rupees for dashboards", () => {
  assert.equal(rupeesShort(3000000), "₹30K");
  assert.equal(rupeesShort(13000000), "₹1.3L");
  assert.equal(rupeesShort(2500000000), "₹2.5Cr");
});

test("percent off never negative", () => {
  assert.equal(percentOff(124900, 165000), 24);
  assert.equal(percentOff(100, 100), 0);
  assert.equal(percentOff(200, 100), 0);
});

test("rupee input parsing", () => {
  assert.equal(parseRupees("1,249.50"), 124950);
  assert.equal(parseRupees("₹ 999"), 99900);
  assert.equal(parseRupees("12.345"), null);
  assert.equal(parseRupees("abc"), null);
  assert.equal(parseRupees("-5"), null);
  assert.equal(paiseToInput(124950), "1249.50");
  assert.equal(paiseToInput(124900), "1249");
});

test("text helpers", () => {
  assert.equal(plural(1, "part"), "1 part");
  assert.equal(plural(3, "part"), "3 parts");
  assert.equal(warranty(0), "No warranty");
  assert.equal(warranty(12), "1 year");
  assert.equal(warranty(24), "2 years");
  assert.equal(warranty(6), "6 months");
});
