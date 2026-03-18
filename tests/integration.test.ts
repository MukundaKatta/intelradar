import { describe, it, expect } from "vitest";
import { Intelradar } from "../src/core.js";

describe("Intelradar integration", () => {
  it("handles concurrent ops", async () => {
    const c = new Intelradar();
    await Promise.all([c.process({a:1}), c.process({b:2}), c.process({c:3})]);
    expect(c.getStats().ops).toBe(3);
  });
  it("returns service name", async () => {
    const c = new Intelradar();
    const r = await c.process();
    expect(r.service).toBe("intelradar");
  });
  it("handles 100 ops", async () => {
    const c = new Intelradar();
    for (let i = 0; i < 100; i++) await c.process({i});
    expect(c.getStats().ops).toBe(100);
  });
});
