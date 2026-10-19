export const READ_DEADLINE_MS = 20_000;
export const DEADLINE_MESSAGE = 'Vypršel čas pro načtení přehledu; část údajů se nepodařilo ověřit';

/** Also bounds injected readers that do not implement cancellation themselves. */
export async function beforeDeadline<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error(DEADLINE_MESSAGE);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(DEADLINE_MESSAGE));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(read).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
