import { createRequire } from 'node:module';
import type { CanonicalContentPart, CanonicalMessage, CanonicalRequest } from '@routeshift/shared';
import {
  FileFetchFailedError,
  FileFetchTimeoutError,
  FileTooLargeError,
  FileUrlBlockedError,
  safeFetch,
  type SafeFetchInit,
  type SafeFetchResult,
} from './safe-fetch.js';

type PdfParse = (data: Uint8Array, options?: { max?: number }) => Promise<{ text: string; numpages: number }>;

// pdf-parse's package entry runs a sample-file side effect whenever it is
// loaded from an ESM parent. Load its parser module directly to keep Railway
// and Vitest free of that side effect.
const require = createRequire(import.meta.url);
const PDF_PARSE_MODULE = require.resolve('pdf-parse/lib/pdf-parse.js');
const PDF_JS_MODULE = require.resolve('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILE_PAGES = 100;
const DEFAULT_MAX_EXTRACTED_TEXT_CHARS = 1_000_000;
const DEFAULT_MAX_TOTAL_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_EXTRACTED_TEXT_CHARS = 1_000_000;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

export type FileParserWarningCode =
  | 'file_url_blocked'
  | 'file_too_large'
  | 'unsupported_file_type'
  | 'empty_file'
  | 'file_parse_failed'
  | 'file_fetch_failed'
  | 'file_fetch_timeout';

export interface FileParserWarning {
  code: FileParserWarningCode;
}

export interface FileParserResult {
  canonical: CanonicalRequest;
  warnings: FileParserWarning[];
}

export type FileFetcher = (url: string, init: SafeFetchInit) => Promise<SafeFetchResult>;

export interface FileParserOptions {
  /** Test seam only; production defaults to the SSRF-safe fetch path. */
  fetchFile?: FileFetcher;
  maxBytes?: number;
  maxPages?: number;
  maxTextChars?: number;
  maxTotalBytes?: number;
  maxTotalTextChars?: number;
  maxFiles?: number;
  /** Share one request-scoped budget across user and system content. */
  budget?: FileParserBudget;
  timeoutMs?: number;
  /** Native PDF output is enabled only by the runtime's provider/fallback gate. */
  nativePdf?: boolean;
}

interface FileParserContext {
  fetchFile: FileFetcher;
  maxBytes: number;
  maxPages: number;
  maxTextChars: number;
  maxTotalBytes: number;
  maxTotalTextChars: number;
  maxFiles: number;
  timeoutMs: number;
  nativePdf: boolean;
  budget: FileParserBudget;
}

export interface FileParserBudget {
  /** File parts attempted in this request, including invalid URL/base64 inputs. */
  files: number;
  /** Bytes acquired or decoded from file content, even if later validation fails. */
  decodedBytes: number;
  extractedTextChars: number;
}

interface ExtractedPdf {
  filename: string;
  text?: string;
  /** Normalized bytes keep URL inputs out of provider adapters. */
  data: string;
}

/**
 * Replaces OpenAI-style base64 PDF parts with their extracted text. The proxy
 * intentionally does not retain raw file content after this stage: providers
 * that do not have a proven native PDF adapter must only receive text context.
 */
export async function augmentWithFileParser(
  canonical: CanonicalRequest,
  options: FileParserOptions = {},
): Promise<FileParserResult> {
  const context = parserContext(options);
  const warnings: FileParserWarning[] = [];
  const messages: CanonicalMessage[] = [];

  for (const message of canonical.messages) {
    if (!Array.isArray(message.content)) {
      messages.push(message);
      continue;
    }

    const parts: CanonicalContentPart[] = [];
    for (const rawPart of message.content as unknown[]) {
      if (!isFilePart(rawPart)) {
        parts.push(rawPart as CanonicalContentPart);
        continue;
      }

      const nativePdf = context.nativePdf && message.role === 'user';
      const result = await extractPdf(rawPart, context, nativePdf);
      if ('code' in result) {
        warnings.push(result);
        continue;
      }
      parts.push(fileReplacement(result, nativePdf));
    }
    messages.push({ ...message, content: parts });
  }

  let systemPrompt = canonical.system_prompt;
  if (Array.isArray(systemPrompt)) {
    const parts: Array<Record<string, unknown>> = [];
    for (const rawPart of systemPrompt as unknown[]) {
      if (isFilePart(rawPart)) {
        const result = await extractPdf(rawPart, context, false);
        if ('code' in result) {
          warnings.push(result);
          continue;
        }
        // System documents deliberately stay text-only in v1, but unrelated
        // blocks (including cache_control metadata) remain verbatim below.
        parts.push(fileReplacement(result, false) as unknown as Record<string, unknown>);
        continue;
      }
      if (typeof rawPart === 'string') {
        parts.push({ type: 'text', text: rawPart });
        continue;
      }
      if (rawPart && typeof rawPart === 'object' && !Array.isArray(rawPart)) {
        parts.push(rawPart as Record<string, unknown>);
      }
    }
    systemPrompt = parts;
  }

  return { canonical: { ...canonical, messages, system_prompt: systemPrompt }, warnings };
}

export function createFileParserBudget(): FileParserBudget {
  return { files: 0, decodedBytes: 0, extractedTextChars: 0 };
}

function parserContext(options: FileParserOptions): FileParserContext {
  return {
    fetchFile: options.fetchFile ?? ((url, init) => safeFetch(url, init)),
    maxBytes: positiveInt(options.maxBytes ?? process.env.PLUGIN_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxPages: positiveInt(options.maxPages ?? process.env.PLUGIN_MAX_FILE_PAGES, DEFAULT_MAX_FILE_PAGES),
    maxTextChars: positiveInt(
      options.maxTextChars ?? process.env.PLUGIN_MAX_EXTRACTED_TEXT_CHARS,
      DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
    ),
    maxTotalBytes: positiveInt(
      options.maxTotalBytes ?? process.env.PLUGIN_MAX_TOTAL_FILE_BYTES,
      DEFAULT_MAX_TOTAL_FILE_BYTES,
    ),
    maxTotalTextChars: positiveInt(
      options.maxTotalTextChars ?? process.env.PLUGIN_MAX_TOTAL_EXTRACTED_TEXT_CHARS,
      DEFAULT_MAX_TOTAL_EXTRACTED_TEXT_CHARS,
    ),
    maxFiles: positiveInt(options.maxFiles ?? process.env.PLUGIN_MAX_FILES, DEFAULT_MAX_FILES),
    timeoutMs: positiveInt(options.timeoutMs ?? process.env.PLUGIN_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS),
    nativePdf: options.nativePdf === true,
    budget: options.budget ?? createFileParserBudget(),
  };
}

async function extractPdf(
  part: Record<string, unknown>,
  context: FileParserContext,
  nativePdf: boolean,
): Promise<ExtractedPdf | FileParserWarning> {
  // Reserve an attempt before doing any attacker-controlled work. Otherwise a
  // request with many malformed URL files can evade maxFiles and repeatedly
  // consume outbound connections just because each later fails validation.
  if (!reserveFileAttempt(context)) return { code: 'file_too_large' };

  const filename = sanitizedFilename(filenameFrom(part));
  const data = fileDataFrom(part);
  if (data !== undefined) return extractBase64Pdf(data, filename, context, nativePdf);

  const url = fileUrlFrom(part);
  if (url !== undefined) return extractUrlPdf(url, filename, context, nativePdf);

  return { code: 'unsupported_file_type' };
}

async function extractBase64Pdf(
  data: string,
  filename: string,
  context: FileParserContext,
  nativePdf: boolean,
): Promise<ExtractedPdf | FileParserWarning> {
  const base64 = base64Payload(data);
  if (!base64) return { code: 'unsupported_file_type' };
  // Guard the encoded form before allocating a decoded Buffer. The body-limit
  // below is the second guard for permissive or oddly padded base64 inputs.
  const estimatedBytes = estimatedBase64Bytes(base64);
  if (estimatedBytes > context.maxBytes || estimatedBytes > remainingDecodedBytes(context)) {
    return { code: 'file_too_large' };
  }

  let pdf: Buffer;
  try {
    pdf = Buffer.from(base64, 'base64');
  } catch {
    return { code: 'file_parse_failed' };
  }
  if (!reserveDecodedBytes(context, pdf.byteLength)) return { code: 'file_too_large' };
  return extractPdfBuffer(pdf, filename, context, nativePdf);
}

async function extractUrlPdf(
  url: string,
  filename: string,
  context: FileParserContext,
  nativePdf: boolean,
): Promise<ExtractedPdf | FileParserWarning> {
  const maxBytes = Math.min(context.maxBytes, remainingDecodedBytes(context));
  if (maxBytes <= 0) return { code: 'file_too_large' };

  let response: SafeFetchResult;
  try {
    response = await context.fetchFile(url, {
      method: 'GET',
      followRedirects: true,
      maxRedirects: MAX_REDIRECTS,
      // The request-wide remaining budget is also the transport cap, so a
      // later URL can never download another full per-file allowance.
      maxBytes,
      timeoutMs: context.timeoutMs,
    });
  } catch (error) {
    // safeFetch can fail after it has read bytes (a chunked over-cap response,
    // a body that stalls until timeout, or a redirect chain whose next hop is
    // blocked). It does not expose a partial-byte count, so fail closed and
    // exhaust this request's remaining decoded budget for every fetch error.
    exhaustDecodedBytes(context);
    return warningForFetchError(error);
  }
  // A fetched response consumes request budget even if its status, MIME type,
  // or PDF magic is invalid. Otherwise malformed responses sidestep the
  // aggregate cap while still consuming memory and network bandwidth.
  if (!reserveDecodedBytes(context, response.body.byteLength)) return { code: 'file_too_large' };
  if (response.statusCode < 200 || response.statusCode >= 300) return { code: 'file_fetch_failed' };
  if (!isPdfContentType(response.headers)) return { code: 'unsupported_file_type' };
  return extractPdfBuffer(response.body, filename, context, nativePdf);
}

async function extractPdfBuffer(
  pdf: Buffer,
  filename: string,
  context: FileParserContext,
  nativePdf: boolean,
): Promise<ExtractedPdf | FileParserWarning> {
  if (pdf.byteLength > context.maxBytes) return { code: 'file_too_large' };
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { code: 'unsupported_file_type' };

  try {
    // Even native capable providers receive only validated, bounded payloads.
    // Inspect one page to learn the full document's declared page count without
    // converting a scanned PDF's empty first page into an extraction failure.
    if (nativePdf) {
      const inspected = await parsePdf(pdf, 1);
      if (inspected.numpages > context.maxPages) return { code: 'file_too_large' };
      return { filename, data: pdf.toString('base64') };
    }

    const parsed = await parsePdf(pdf, context.maxPages);
    if (parsed.numpages > context.maxPages) return { code: 'file_too_large' };
    const text = parsed.text.trim();
    if (!text) return { code: 'empty_file' };
    if (text.length > context.maxTextChars) return { code: 'file_too_large' };
    if (!reserveExtractedTextBudget(context, text.length)) return { code: 'file_too_large' };
    return { filename, text, data: pdf.toString('base64') };
  } catch {
    return { code: 'file_parse_failed' };
  }
}

function reserveFileAttempt(context: FileParserContext): boolean {
  if (context.budget.files + 1 > context.maxFiles) return false;
  context.budget.files += 1;
  return true;
}

function remainingDecodedBytes(context: FileParserContext): number {
  return Math.max(0, context.maxTotalBytes - context.budget.decodedBytes);
}

function reserveDecodedBytes(context: FileParserContext, decodedBytes: number): boolean {
  if (decodedBytes > remainingDecodedBytes(context)) return false;
  context.budget.decodedBytes += decodedBytes;
  return true;
}

function exhaustDecodedBytes(context: FileParserContext): void {
  context.budget.decodedBytes = context.maxTotalBytes;
}

function reserveExtractedTextBudget(context: FileParserContext, textChars: number): boolean {
  if (context.budget.extractedTextChars + textChars > context.maxTotalTextChars) return false;
  context.budget.extractedTextChars += textChars;
  return true;
}

const PDF_PARSE_LOCK = Symbol.for('routeshift.file-parser.pdf-parse-lock');

interface PdfParseLockState {
  tail: Promise<void>;
}

function pdfParseLock(): PdfParseLockState {
  // Keep the lock on `process`, rather than this ESM module instance. Vitest
  // (and some runtime loaders) can evaluate this module in separate contexts
  // while still sharing the CommonJS require cache that pdf-parse mutates.
  const sharedProcess = process as typeof process & { [PDF_PARSE_LOCK]?: PdfParseLockState };
  if (!sharedProcess[PDF_PARSE_LOCK]) {
    sharedProcess[PDF_PARSE_LOCK] = { tail: Promise.resolve() };
  }
  return sharedProcess[PDF_PARSE_LOCK];
}

async function parsePdf(pdf: Buffer, maxPages: number): Promise<{ text: string; numpages: number }> {
  // pdf-parse 1.x/pdf.js keeps document state in CommonJS module scope. A
  // fresh module pair is required for sequential documents, but deleting that
  // cache concurrently corrupts a live parse. Serialize the load/parse/cleanup
  // critical section across requests instead of racing module invalidation.
  let release!: () => void;
  const currentParse = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = pdfParseLock();
  const previousParse = lock.tail;
  lock.tail = currentParse;
  await previousParse;

  // pdf-parse 1.x keeps its pdf.js document state in module scope and calls
  // `destroy()` without waiting for cleanup. A fresh module pair per bounded
  // file keeps one request's cleanup from corrupting the next request's text.
  try {
    delete require.cache[PDF_PARSE_MODULE];
    delete require.cache[PDF_JS_MODULE];
    const parser = require(PDF_PARSE_MODULE) as PdfParse;
    // Node 26 may decode Buffers into a larger backing ArrayBuffer. Legacy
    // pdf.js can inspect bytes outside the Buffer view and then reject a valid
    // document with a bad XRef entry, so give it an exact, owned byte array.
    return await parser(new Uint8Array(pdf), { max: maxPages });
  } finally {
    release();
  }
}

function fileReplacement(result: ExtractedPdf, nativePdf: boolean): CanonicalContentPart {
  if (nativePdf) {
    return {
      type: 'pdf',
      pdf: {
        media_type: 'application/pdf',
        data: result.data,
        filename: result.filename,
      },
    };
  }
  return {
    type: 'text',
    text: `[Extracted from ${result.filename}]\n${result.text ?? ''}`,
  };
}

function isFilePart(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'file' || type === 'input_file';
}

function base64Payload(data: string): string | null {
  if (!data.startsWith('data:')) return data;
  const match = /^data:application\/pdf(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/i.exec(data);
  return match?.[1] ?? null;
}

function estimatedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function fileDataFrom(part: Record<string, unknown>): string | undefined {
  return stringField(part, 'file_data') ?? stringField(nestedFile(part), 'file_data');
}

function fileUrlFrom(part: Record<string, unknown>): string | undefined {
  return stringField(part, 'file_url')
    ?? stringField(part, 'url')
    ?? stringField(nestedFile(part), 'file_url')
    ?? stringField(nestedFile(part), 'url');
}

function filenameFrom(part: Record<string, unknown>): unknown {
  return part.filename ?? part.name ?? nestedFile(part)?.filename ?? nestedFile(part)?.name;
}

function nestedFile(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const file = part.file;
  return file && typeof file === 'object' && !Array.isArray(file) ? file as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const candidate = value?.[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function isPdfContentType(headers: SafeFetchResult['headers']): boolean {
  const raw = headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && /^application\/pdf(?:\s*;|$)/i.test(value);
}

function warningForFetchError(error: unknown): FileParserWarning {
  if (error instanceof FileUrlBlockedError) return { code: 'file_url_blocked' };
  if (error instanceof FileTooLargeError) return { code: 'file_too_large' };
  if (error instanceof FileFetchTimeoutError) return { code: 'file_fetch_timeout' };
  if (error instanceof FileFetchFailedError) return { code: 'file_fetch_failed' };
  return { code: 'file_fetch_failed' };
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizedFilename(value: unknown): string {
  if (typeof value !== 'string') return 'document.pdf';
  const filename = value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .trim()
    .slice(0, 120);
  return filename || 'document.pdf';
}
