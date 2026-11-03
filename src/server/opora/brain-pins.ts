// Brain pins of an OPORA ticket (Canvas PR 7b): each pin is a Claude Code plugin the heart pinned for the work,
// served by OPORA as a zip (`GET /api/brain-registry/pins/<plugin>@<sha12>.zip`) under the ticket's gate session.
// The office keeps each zip once in `<data dir>/brain-pins/` (the version in the name means the content never
// changes) and starts the ticket's Claude worker with `--plugin-dir <zip>` per pin, for that session only.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A pin as the ticket's `machine.pins` carries it. */
export interface BrainPin { pin: string; plugin: string; version: string; zip: string }

const FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}@[0-9a-fA-F]{7,40}\.zip$/;
const PREFIX = '/api/brain-registry/pins/';

/** The pin's `plugin@sha12` (its zip's name without `.zip`), or why the pin isn't one the office fetches. */
export function pinFile(pin: BrainPin): { file: string } | { error: string } {
  const file = pin.zip.startsWith(PREFIX) ? pin.zip.slice(PREFIX.length) : '';
  if (!FILE.test(file) || !file.startsWith(`${pin.plugin}@`)) return { error: `Brain pin “${pin.pin || pin.plugin}” has no zip the office can fetch (${pin.zip.slice(0, 120)})` };
  return { file };
}

/** The short name a person sees: `plugin@sha12`. */
export const pinLabel = (pin: BrainPin) => { const out = pinFile(pin); return 'file' in out ? out.file.slice(0, -4) : pin.plugin; };

/** Claude's arguments for the pins' zips: `--plugin-dir <zip>` for each. */
export const pluginDirArgs = (dirs: readonly string[] | undefined) => (dirs ?? []).flatMap(dir => ['--plugin-dir', dir]);

/**
 * Each pin's zip in `<dataDir>/brain-pins/`, downloaded only when it isn't there yet. Throws on the first pin it
 * can't have (a bad zip path or a failed download): a ticket doesn't start without the rules the heart pinned.
 */
export async function fetchPins(pins: readonly BrainPin[], dataDir: string, download: (zip: string) => Promise<Uint8Array>): Promise<string[]> {
  const dir = path.join(dataDir, 'brain-pins'), out: string[] = [];
  for (const pin of pins) {
    const named = pinFile(pin);
    if ('error' in named) throw new Error(named.error);
    const target = path.join(dir, named.file);
    if (!existsSync(target)) {
      let bytes: Uint8Array;
      try { bytes = await download(pin.zip); } catch (error) { throw new Error(`Brain pin ${named.file.slice(0, -4)} couldn't be fetched: ${(error as Error).message}`); }
      mkdirSync(dir, { recursive: true });
      // Written aside and renamed, so a half-written zip is never taken for the pin.
      const part = `${target}.${process.pid}.part`;
      writeFileSync(part, bytes);
      renameSync(part, target);
    }
    out.push(target);
  }
  return out;
}
