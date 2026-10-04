import { describe, expect, it, vi } from "vitest";
import { reviewInFlight } from "./reviewInFlight.js";

// #62: a double-click on Accept sends one request. React's `busy` state only disables the button on the
// next render, so a second click in the same frame is dropped here, synchronously, per Review Item.

describe("reviewInFlight", () => {
  it("GIVEN a request for a Review Item in flight WHEN Accept is clicked again THEN no second request is sent", async () => {
    const guard = reviewInFlight();
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = guard.run("r1", send);
    const second = guard.run("r1", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(guard.busy("r1")).toBe(true);
    expect(await second).toBe(false);
    finish();
    await first;
    expect(guard.busy("r1")).toBe(false);
  });

  it("GIVEN an accept in flight WHEN Reject is clicked on the same item THEN it is dropped too", async () => {
    const guard = reviewInFlight();
    const accept = guard.run("r1", () => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    const reject = vi.fn(async () => undefined);
    expect(await guard.run("r1", reject)).toBe(false);
    expect(reject).not.toHaveBeenCalled();
    await accept;
  });

  it("GIVEN the request failed THEN the item can be tried again", async () => {
    const guard = reviewInFlight();
    await expect(guard.run("r1", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    const retry = vi.fn(async () => undefined);
    await guard.run("r1", retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not block other Review Items", async () => {
    const guard = reviewInFlight();
    const slow = guard.run("r1", () => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    const other = vi.fn(async () => undefined);
    await guard.run("r2", other);
    expect(other).toHaveBeenCalledTimes(1);
    await slow;
  });
});
