import { ROOT_CONTEXT } from "@opentelemetry/api";
import { describe, expect, it, jest } from "@jest/globals";

const warning = jest.fn<(message: string) => void>();
const extract = jest.fn(
  (
    ctx: typeof ROOT_CONTEXT,
    carrier: Record<string, string>,
    getter: {
      get: (input: Record<string, string>, key: string) => string | undefined;
      keys: (input: Record<string, string>) => string[];
    },
  ) => {
    expect(getter.get(carrier, "traceparent")).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(getter.keys(carrier)).toEqual(["traceparent"]);
    return ctx;
  },
);

jest.unstable_mockModule("@actions/core", () => ({ warning }));
jest.unstable_mockModule("@opentelemetry/core", () => ({
  W3CTraceContextPropagator: jest.fn(() => ({ extract })),
}));

const { extractParentContext } = await import("./tracer.js");

describe("extractParentContext branch coverage", () => {
  it("provides carrier keys to the trace propagator", () => {
    const ctx = extractParentContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");

    expect(ctx).toBe(ROOT_CONTEXT);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
