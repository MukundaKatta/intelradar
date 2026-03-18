import { describe, it, expect } from "vitest";
import { Intelradar } from "../src/core.js";
describe("Intelradar", () => {
  it("init", () => { expect(new Intelradar().getStats().ops).toBe(0); });
  it("op", async () => { const c = new Intelradar(); await c.process(); expect(c.getStats().ops).toBe(1); });
  it("reset", async () => { const c = new Intelradar(); await c.process(); c.reset(); expect(c.getStats().ops).toBe(0); });
});
