import { afterEach, describe, expect, it, vi } from "vitest";

/** Stands in for the browser's EventSource, so a test can play out an outage. */
class FakeSource {
  static last: FakeSource | null = null;
  onerror: (() => void) | null = null;
  private readonly handlers = new Map<string, () => void>();
  constructor() {
    FakeSource.last = this;
  }
  addEventListener(kind: string, handler: () => void): void {
    this.handlers.set(kind, handler);
  }
  emit(kind: string): void {
    this.handlers.get(kind)?.();
  }
}

describe("live connection status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("tells listeners once per outage, not on every failed retry", async () => {
    vi.stubGlobal("EventSource", FakeSource);
    const { liveStatus, subscribeLiveStatus } = await import("../../web/src/lib/liveStream.js");
    const seen: string[] = [];
    subscribeLiveStatus(() => seen.push(liveStatus()));
    const source = FakeSource.last!;

    source.emit("ready");
    source.onerror?.();
    source.onerror?.();
    source.onerror?.();
    source.emit("ready");

    expect(seen).toEqual(["live", "offline", "live"]);
  });
});
