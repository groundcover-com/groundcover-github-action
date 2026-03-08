import { trace as traceApi } from "@opentelemetry/api";
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

describe("tracer", () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env["OTEL_CONSOLE_ONLY"];
    delete process.env["OTEL_ID_SEED"];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    traceApi.disable();
  });

  it("parses empty headers into an empty record", async () => {
    const { stringToRecord } = await import("./tracer.js");

    expect(stringToRecord("")).toEqual({});
  });

  it("parses a single key value pair", async () => {
    const { stringToRecord } = await import("./tracer.js");

    expect(stringToRecord("authorization=Bearer token")).toEqual({
      authorization: "Bearer token",
    });
  });

  it("parses multiple key value pairs", async () => {
    const { stringToRecord } = await import("./tracer.js");

    expect(stringToRecord("a=1,b=2,c=3")).toEqual({
      a: "1",
      b: "2",
      c: "3",
    });
  });

  it("keeps base64 values that include equals characters", async () => {
    const { stringToRecord } = await import("./tracer.js");

    expect(stringToRecord("authorization=Basic dGVzdD0=,x-token=abc==")).toEqual({
      authorization: "Basic dGVzdD0=",
      "x-token": "abc==",
    });
  });

  it("trims whitespace around keys and values", async () => {
    const { stringToRecord } = await import("./tracer.js");

    expect(stringToRecord("  key-1  =  value-1  , key-2=value-2   ")).toEqual({
      "key-1": "value-1",
      "key-2": "value-2",
    });
  });

  it("uses OTLP HTTP exporter for HTTP endpoints", async () => {
    const warning = jest.fn<(message: string) => void>();
    const fakeExporter = {
      export: jest.fn(),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      forceFlush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    const protoConstructor = jest.fn(() => fakeExporter);
    const grpcConstructor = jest.fn(() => fakeExporter);

    process.env["OTEL_CONSOLE_ONLY"] = "false";

    jest.unstable_mockModule("@actions/core", () => ({ warning }));
    jest.unstable_mockModule("@opentelemetry/exporter-trace-otlp-proto", () => ({
      OTLPTraceExporter: protoConstructor,
    }));
    jest.unstable_mockModule("@opentelemetry/exporter-trace-otlp-grpc", () => ({
      OTLPTraceExporter: grpcConstructor,
    }));
    jest.unstable_mockModule("@grpc/grpc-js", () => ({
      credentials: { createSsl: jest.fn(() => "ssl") },
      Metadata: { fromHttp2Headers: jest.fn(() => "metadata") },
    }));

    const { createTracerProvider } = await import("./tracer.js");
    const provider = createTracerProvider("https://otel.example/v1/traces", "a=1, b=2", {
      "service.name": "svc-http",
    });

    expect(protoConstructor).toHaveBeenCalledWith({
      url: "https://otel.example/v1/traces",
      headers: { a: "1", b: "2" },
    });
    expect(grpcConstructor).not.toHaveBeenCalled();

    const providerWithResource = provider as unknown as {
      resource: { attributes: Record<string, unknown> };
    };
    expect(providerWithResource.resource.attributes["service.name"]).toBe("svc-http");
  });

  it("uses OTLP gRPC exporter for non HTTP endpoints", async () => {
    const warning = jest.fn<(message: string) => void>();
    const fakeExporter = {
      export: jest.fn(),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      forceFlush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    const protoConstructor = jest.fn(() => fakeExporter);
    const grpcConstructor = jest.fn(() => fakeExporter);
    const createSsl = jest.fn(() => "ssl");
    const fromHttp2Headers = jest.fn((headers: Record<string, string>) => ({ headers }));

    process.env["OTEL_CONSOLE_ONLY"] = "false";

    jest.unstable_mockModule("@actions/core", () => ({ warning }));
    jest.unstable_mockModule("@opentelemetry/exporter-trace-otlp-proto", () => ({
      OTLPTraceExporter: protoConstructor,
    }));
    jest.unstable_mockModule("@opentelemetry/exporter-trace-otlp-grpc", () => ({
      OTLPTraceExporter: grpcConstructor,
    }));
    jest.unstable_mockModule("@grpc/grpc-js", () => ({
      credentials: { createSsl },
      Metadata: { fromHttp2Headers },
    }));

    const { createTracerProvider } = await import("./tracer.js");
    createTracerProvider("localhost:4317", "authorization=Bearer token", {
      "service.name": "svc-grpc",
    });

    expect(protoConstructor).not.toHaveBeenCalled();
    expect(createSsl).toHaveBeenCalledTimes(1);
    expect(fromHttp2Headers).toHaveBeenCalledWith({ authorization: "Bearer token" });
    expect(grpcConstructor).toHaveBeenCalledWith({
      url: "localhost:4317",
      credentials: "ssl",
      metadata: { headers: { authorization: "Bearer token" } },
    });
  });

  it("extracts a valid traceparent into a span context", async () => {
    const warning = jest.fn<(message: string) => void>();
    jest.unstable_mockModule("@actions/core", () => ({ warning }));

    const { extractParentContext } = await import("./tracer.js");
    const ctx = extractParentContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    const spanContext = traceApi.getSpanContext(ctx);

    expect(spanContext?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(spanContext?.spanId).toBe("b7ad6b7169203331");
    expect(spanContext?.traceFlags).toBe(1);
  });

  it("returns ROOT_CONTEXT when traceparent is empty or undefined", async () => {
    const warning = jest.fn<(message: string) => void>();
    jest.unstable_mockModule("@actions/core", () => ({ warning }));

    const { extractParentContext } = await import("./tracer.js");

    expect(traceApi.getSpanContext(extractParentContext(""))).toBeUndefined();
    expect(traceApi.getSpanContext(extractParentContext(undefined))).toBeUndefined();
    expect(warning).not.toHaveBeenCalled();
  });

  it("falls back to ROOT_CONTEXT and warns on malformed traceparent", async () => {
    const warning = jest.fn<(message: string) => void>();
    jest.unstable_mockModule("@actions/core", () => ({ warning }));

    const { extractParentContext } = await import("./tracer.js");
    const ctx = extractParentContext("bad-traceparent");

    expect(traceApi.getSpanContext(ctx)).toBeUndefined();
    expect(warning).toHaveBeenCalledWith('Invalid traceparent format: "bad-traceparent". Creating new root trace.');
  });

  it("keeps trace flags from traceparent for 00 and 01", async () => {
    const warning = jest.fn<(message: string) => void>();
    jest.unstable_mockModule("@actions/core", () => ({ warning }));

    const { extractParentContext } = await import("./tracer.js");

    const unsampledCtx = extractParentContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00");
    const sampledCtx = extractParentContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");

    expect(traceApi.getSpanContext(unsampledCtx)?.traceFlags).toBe(0);
    expect(traceApi.getSpanContext(sampledCtx)?.traceFlags).toBe(1);
  });
});
