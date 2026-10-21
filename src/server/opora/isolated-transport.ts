/** Bound both network and body waits even when an injected transport ignores abort. */
export function isolatedTransport(transport: typeof fetch, timeoutMs = 8000): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController(), signal = init?.signal;
    const abort = () => controller.abort();
    if (signal?.aborted) throw new Error('Isolated transport unavailable');
    signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Isolated transport unavailable')); }, timeoutMs);
      controller.signal.addEventListener('abort', () => reject(new Error('Isolated transport unavailable')), { once: true });
    });
    try {
      const request = async () => {
        const response = await transport(input, { ...init, redirect: 'error', signal: controller.signal });
        if (response.redirected || (response.url && new URL(response.url).origin !== new URL(String(input)).origin)) throw new Error();
        if (!response.body) return new Response(null, { status: response.status, headers: response.headers });
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 4 * 1024 * 1024) { void reader.cancel(); throw new Error(); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
      };
      return await Promise.race([request(), limit]);
    } catch { throw new Error('Isolated transport unavailable'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
}
