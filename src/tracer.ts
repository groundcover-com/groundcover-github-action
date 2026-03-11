import * as core from "@actions/core";
import { credentials, Metadata } from "@grpc/grpc-js";
import { type Attributes, type Context, context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter as GrpcOTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as ProtoOTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter as GrpcOTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as ProtoOTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, type LogRecordExporter, LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type IdGenerator,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

const OTEL_CONSOLE_ONLY = process.env["OTEL_CONSOLE_ONLY"] === "true";
const OTEL_ID_SEED = Number.parseInt(process.env["OTEL_ID_SEED"] ?? "0", 10);

const assignmentRegex = /=(.*)/s;

function stringToRecord(s: string): Record<string, string> {
  const record: Record<string, string> = {};

  for (const pair of s.split(",")) {
    const parts = pair.split(assignmentRegex);
    const key = parts[0];
    const value = parts[1];
    if (key && value) {
      record[key.trim()] = value.trim();
    }
  }
  return record;
}

function isHttpEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("https://") || endpoint.startsWith("http://");
}

function extractParentContext(traceparent: string | undefined): Context {
  if (!traceparent) {
    return ROOT_CONTEXT;
  }

  const TRACEPARENT_REGEX = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
  if (!TRACEPARENT_REGEX.test(traceparent)) {
    core.warning(`Invalid traceparent format: "${traceparent}". Creating new root trace.`);
    return ROOT_CONTEXT;
  }

  const propagator = new W3CTraceContextPropagator();
  const carrier: Record<string, string> = { traceparent };
  return propagator.extract(ROOT_CONTEXT, carrier, {
    get: (c: Record<string, string>, key: string) => c[key],
    keys: (c: Record<string, string>) => Object.keys(c),
  });
}

function buildSignalUrl(baseEndpoint: string, signalPath: string): string {
  if (!isHttpEndpoint(baseEndpoint)) {
    return baseEndpoint;
  }
  const base = baseEndpoint.endsWith("/") ? baseEndpoint.slice(0, -1) : baseEndpoint;
  return `${base}/${signalPath}`;
}

function createLoggerProvider(endpoint: string, headers: string, attributes: Attributes): LoggerProvider {
  let exporter: LogRecordExporter | undefined;

  if (!OTEL_CONSOLE_ONLY) {
    const logsEndpoint = buildSignalUrl(endpoint, "v1/logs");
    if (isHttpEndpoint(logsEndpoint)) {
      exporter = new ProtoOTLPLogExporter({
        url: logsEndpoint,
        headers: stringToRecord(headers),
      });
    } else {
      exporter = new GrpcOTLPLogExporter({
        url: logsEndpoint,
        credentials: credentials.createSsl(),
        metadata: Metadata.fromHttp2Headers(stringToRecord(headers)),
      });
    }
  }

  // Cast through unknown to bridge the version mismatch between @opentelemetry/resources 1.x
  // (trace SDK) and 2.x (sdk-logs). The runtime shape is identical.
  const resource = Resource.default().merge(new Resource(attributes));
  const config: Record<string, unknown> = { resource };
  if (exporter) {
    config["processors"] = [new BatchLogRecordProcessor(exporter)];
  }
  const provider = new LoggerProvider(config as ConstructorParameters<typeof LoggerProvider>[0]);

  logs.setGlobalLoggerProvider(provider);
  return provider;
}

function createTracerProvider(endpoint: string, headers: string, attributes: Attributes): BasicTracerProvider {
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  let exporter: SpanExporter = new ConsoleSpanExporter();

  if (!OTEL_CONSOLE_ONLY) {
    if (isHttpEndpoint(endpoint)) {
      exporter = new ProtoOTLPTraceExporter({
        url: buildSignalUrl(endpoint, "v1/traces"),
        headers: stringToRecord(headers),
      });
    } else {
      exporter = new GrpcOTLPTraceExporter({
        url: endpoint,
        credentials: credentials.createSsl(),
        metadata: Metadata.fromHttp2Headers(stringToRecord(headers)),
      });
    }
  }

  const resource = Resource.default().merge(new Resource(attributes));

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
    ...(OTEL_ID_SEED ? { idGenerator: new DeterministicIdGenerator(OTEL_ID_SEED) } : {}),
  });

  trace.setGlobalTracerProvider(provider);
  return provider;
}

// Copied from xorshift32amx: https://github.com/bryc/code/blob/master/jshash/PRNGs.md#xorshift
function createRandomWithSeed(seed: number): (max: number) => number {
  let a = seed;
  return function getRandomInt(max: number): number {
    let t = Math.imul(a, 1_597_334_677);
    t = (t >>> 24) | ((t >>> 8) & 65_280) | ((t << 8) & 16_711_680) | (t << 24);
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    const res = ((a + t) >>> 0) / 4_294_967_296;

    return Math.floor(res * max);
  };
}

/**
 * A deterministic id generator for testing purposes.
 * Uses a seeded PRNG to produce stable trace/span IDs across test runs.
 */
class DeterministicIdGenerator implements IdGenerator {
  readonly characters = "0123456789abcdef";
  getRandomInt: (max: number) => number;

  constructor(seed: number) {
    this.getRandomInt = createRandomWithSeed(seed);
  }

  generateTraceId(): string {
    return this.generateId(32);
  }

  generateSpanId(): string {
    return this.generateId(16);
  }

  private generateId(length: number): string {
    let id = "";

    for (let i = 0; i < length; i++) {
      const idx = this.getRandomInt(this.characters.length);
      id += this.characters.charAt(idx);
    }
    return id;
  }
}

export { stringToRecord, createTracerProvider, createLoggerProvider, buildSignalUrl, extractParentContext };
