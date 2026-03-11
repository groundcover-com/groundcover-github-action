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
    const provider = createTracerProvider("https://otel.example", "a=1, b=2", {
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
    expect(providerWithResource.resource.attributes["telemetry.sdk.language"]).toBe("nodejs");
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

  it("builds signal URL for HTTP endpoints", async () => {
    const { buildSignalUrl } = await import("./tracer.js");

    expect(buildSignalUrl("https://otel.example", "v1/traces")).toBe("https://otel.example/v1/traces");
    expect(buildSignalUrl("https://otel.example/", "v1/traces")).toBe("https://otel.example/v1/traces");
    expect(buildSignalUrl("https://otel.example", "v1/logs")).toBe("https://otel.example/v1/logs");
    expect(buildSignalUrl("http://localhost:4318", "v1/traces")).toBe("http://localhost:4318/v1/traces");
  });

  it("keeps gRPC endpoint unchanged when building signal URL", async () => {
    const { buildSignalUrl } = await import("./tracer.js");

    expect(buildSignalUrl("localhost:4317", "v1/traces")).toBe("localhost:4317");
    expect(buildSignalUrl("localhost:4317", "v1/logs")).toBe("localhost:4317");
  });

  it("normalizes legacy full-path endpoints to avoid double signal paths", async () => {
    const { buildSignalUrl } = await import("./tracer.js");

    // Legacy endpoint already containing /v1/traces
    expect(buildSignalUrl("https://otel.example/v1/traces", "v1/traces")).toBe("https://otel.example/v1/traces");
    expect(buildSignalUrl("https://otel.example/v1/traces/", "v1/traces")).toBe("https://otel.example/v1/traces");
    expect(buildSignalUrl("https://otel.example/v1/traces", "v1/logs")).toBe("https://otel.example/v1/logs");
    expect(buildSignalUrl("https://otel.example/v1/logs", "v1/traces")).toBe("https://otel.example/v1/traces");
  });

  it("uses OTLP HTTP log exporter for HTTP endpoints", async () => {
    const warning = jest.fn<(message: string) => void>();
    const fakeExporter = {
      export: jest.fn(),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      forceFlush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    const fakeBatchProcessor = { process: jest.fn() };
    const fakeLoggerProvider = {
      forceFlush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const protoConstructor = jest.fn(() => fakeExporter);
    const grpcConstructor = jest.fn(() => fakeExporter);
    const batchLogRecordProcessorConstructor = jest.fn(() => fakeBatchProcessor);
    const loggerProviderConstructor = jest.fn(() => fakeLoggerProvider);
    const setGlobalLoggerProvider = jest.fn();

    process.env["OTEL_CONSOLE_ONLY"] = "false";

    jest.unstable_mockModule("@actions/core", () => ({ warning }));
    jest.unstable_mockModule("@opentelemetry/exporter-logs-otlp-proto", () => ({
      OTLPLogExporter: protoConstructor,
    }));
    jest.unstable_mockModule("@opentelemetry/exporter-logs-otlp-grpc", () => ({
      OTLPLogExporter: grpcConstructor,
    }));
    jest.unstable_mockModule("@opentelemetry/api-logs", () => ({
      logs: { setGlobalLoggerProvider },
      SeverityNumber: {},
    }));
    jest.unstable_mockModule("@opentelemetry/sdk-logs", () => ({
      LoggerProvider: loggerProviderConstructor,
      BatchLogRecordProcessor: batchLogRecordProcessorConstructor,
    }));
    jest.unstable_mockModule("@grpc/grpc-js", () => ({
      credentials: { createSsl: jest.fn(() => "ssl") },
      Metadata: { fromHttp2Headers: jest.fn(() => "metadata") },
    }));

    const { createLoggerProvider } = await import("./tracer.js");
    const provider = createLoggerProvider("https://otel.example", "a=1,b=2", {
      "service.name": "svc-http",
    });

    expect(protoConstructor).toHaveBeenCalledWith({
      url: "https://otel.example/v1/logs",
      headers: { a: "1", b: "2" },
    });
    expect(grpcConstructor).not.toHaveBeenCalled();
    expect(batchLogRecordProcessorConstructor).toHaveBeenCalledWith(fakeExporter);
    expect(loggerProviderConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ processors: [fakeBatchProcessor] }),
    );
    expect(setGlobalLoggerProvider).toHaveBeenCalledWith(fakeLoggerProvider);
    expect(provider).toBe(fakeLoggerProvider);
  });

  it("uses OTLP gRPC log exporter for non HTTP endpoints", async () => {
    const warning = jest.fn<(message: string) => void>();
    const fakeExporter = {
      export: jest.fn(),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      forceFlush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    const fakeBatchProcessor = { process: jest.fn() };
    const fakeLoggerProvider = {
      forceFlush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const protoConstructor = jest.fn(() => fakeExporter);
    const grpcConstructor = jest.fn(() => fakeExporter);
    const createSsl = jest.fn(() => "ssl");
    const fromHttp2Headers = jest.fn((headers: Record<string, string>) => ({ headers }));
    const batchLogRecordProcessorConstructor = jest.fn(() => fakeBatchProcessor);
    const loggerProviderConstructor = jest.fn(() => fakeLoggerProvider);
    const setGlobalLoggerProvider = jest.fn();

    process.env["OTEL_CONSOLE_ONLY"] = "false";

    jest.unstable_mockModule("@actions/core", () => ({ warning }));
    jest.unstable_mockModule("@opentelemetry/exporter-logs-otlp-proto", () => ({
      OTLPLogExporter: protoConstructor,
    }));
    jest.unstable_mockModule("@opentelemetry/exporter-logs-otlp-grpc", () => ({
      OTLPLogExporter: grpcConstructor,
    }));
    jest.unstable_mockModule("@opentelemetry/api-logs", () => ({
      logs: { setGlobalLoggerProvider },
      SeverityNumber: {},
    }));
    jest.unstable_mockModule("@opentelemetry/sdk-logs", () => ({
      LoggerProvider: loggerProviderConstructor,
      BatchLogRecordProcessor: batchLogRecordProcessorConstructor,
    }));
    jest.unstable_mockModule("@grpc/grpc-js", () => ({
      credentials: { createSsl },
      Metadata: { fromHttp2Headers },
    }));

    const { createLoggerProvider } = await import("./tracer.js");
    createLoggerProvider("localhost:4317", "authorization=Bearer token", {
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
    expect(batchLogRecordProcessorConstructor).toHaveBeenCalledWith(fakeExporter);
    expect(loggerProviderConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ processors: [fakeBatchProcessor] }),
    );
    expect(setGlobalLoggerProvider).toHaveBeenCalledWith(fakeLoggerProvider);
  });

  it("creates logger provider without exporter when OTEL_CONSOLE_ONLY is enabled", async () => {
    const warning = jest.fn<(message: string) => void>();
    const protoConstructor = jest.fn();
    const grpcConstructor = jest.fn();
    const batchLogRecordProcessorConstructor = jest.fn();
    const fakeLoggerProvider = {
      forceFlush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    const loggerProviderConstructor = jest.fn(() => fakeLoggerProvider);
    const setGlobalLoggerProvider = jest.fn();

    process.env["OTEL_CONSOLE_ONLY"] = "true";

    jest.unstable_mockModule("@actions/core", () => ({ warning }));
    jest.unstable_mockModule("@opentelemetry/exporter-logs-otlp-proto", () => ({
      OTLPLogExporter: protoConstructor,
    }));
    jest.unstable_mockModule("@opentelemetry/exporter-logs-otlp-grpc", () => ({
      OTLPLogExporter: grpcConstructor,
    }));
    jest.unstable_mockModule("@opentelemetry/api-logs", () => ({
      logs: { setGlobalLoggerProvider },
      SeverityNumber: {},
    }));
    jest.unstable_mockModule("@opentelemetry/sdk-logs", () => ({
      LoggerProvider: loggerProviderConstructor,
      BatchLogRecordProcessor: batchLogRecordProcessorConstructor,
    }));

    const { createLoggerProvider } = await import("./tracer.js");
    createLoggerProvider("https://otel.example", "a=1", {
      "service.name": "svc-console-only",
    });

    expect(protoConstructor).not.toHaveBeenCalled();
    expect(grpcConstructor).not.toHaveBeenCalled();
    expect(batchLogRecordProcessorConstructor).not.toHaveBeenCalled();
    expect(loggerProviderConstructor).toHaveBeenCalledWith(
      expect.not.objectContaining({ processors: expect.anything() }),
    );
    expect(setGlobalLoggerProvider).toHaveBeenCalledWith(fakeLoggerProvider);
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
