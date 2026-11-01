/**
 * Upload data plane (ADR-010: PUT /v1/uploads/{upload_id}, raw body). Uses XHR so progress
 * reflects bytes actually sent. The body goes only to a same-origin /v1/uploads/ path from the
 * ticket; any other put_url is refused so CSRF headers never reach another host.
 */
import { ApiError, toApiError } from './transport';

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeUploadPath(putUrl: string): string {
  const u = new URL(putUrl, window.location.origin);
  if (u.origin !== window.location.origin || !/^\/v1\/uploads\/[0-9a-f-]{36}$/i.test(u.pathname)) {
    throw new ApiError('invalid', null, null, `Отклонён адрес загрузки вне /v1/uploads/: ${putUrl}`);
  }
  return u.pathname;
}

export interface PutUploadOptions {
  csrfToken: string;
  idempotencyKey: string;
  contentType: string;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Stall timeout: abort if no progress event for this long. */
  stallMs?: number;
}

export function putUpload(putUrl: string, body: Blob, opts: PutUploadOptions): Promise<void> {
  const path = safeUploadPath(putUrl);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall: number | undefined;
    const arm = () => {
      window.clearTimeout(stall);
      stall = window.setTimeout(() => xhr.abort(), opts.stallMs ?? 60_000);
    };
    xhr.open('PUT', path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', opts.contentType);
    xhr.setRequestHeader('X-CSRF-Token', opts.csrfToken);
    xhr.setRequestHeader('Idempotency-Key', opts.idempotencyKey);
    xhr.upload.onprogress = (e) => {
      arm();
      opts.onProgress?.(e.loaded, e.lengthComputable ? e.total : body.size);
    };
    xhr.onload = () => {
      window.clearTimeout(stall);
      if (xhr.status === 204 || (xhr.status >= 200 && xhr.status < 300)) return resolve();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error body */
      }
      reject(toApiError(xhr.status, parsed));
    };
    xhr.onerror = () => {
      window.clearTimeout(stall);
      reject(new ApiError('network', null, null));
    };
    xhr.onabort = () => {
      window.clearTimeout(stall);
      reject(new ApiError(opts.signal?.aborted ? 'aborted' : 'timeout', null, null));
    };
    opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    arm();
    xhr.send(body);
  });
}
