import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Starting Opora Canvas from its repository, for the whole office: `uv run opora --no-open` in the
 * folder AGENT_OFFICE_OPORA_DIR names (its repository's root, with opora.toml in it). Only when
 * Opora isn't answering already: the office never starts a second one on the same data. It runs
 * until the office stops, or until it stops by itself.
 */
class OporaProcess {
  private child: ChildProcess | null = null;
  starting = false;

  /** Where Opora's repository is, when the office was told and it looks like one. */
  dir(): string | undefined {
    const dir = process.env.AGENT_OFFICE_OPORA_DIR?.trim();
    return dir && existsSync(path.join(dir, 'opora.toml')) ? dir : undefined;
  }

  canStart(): boolean {
    return !!this.dir();
  }

  /** Starts it; resolves to why it couldn't, if it couldn't. `ready` says whether it answers yet. */
  async start(ready: () => Promise<boolean>): Promise<string | undefined> {
    const dir = this.dir();
    if (!dir) return 'The office doesn’t know where Opora is: start it with AGENT_OFFICE_OPORA_DIR set to Opora’s repository';
    if (await ready()) return 'Opora is already running';
    if (this.child || this.starting) return 'Opora is already starting';
    this.starting = true;
    try {
      const child = spawn('uv', ['run', 'opora', '--no-open'], { cwd: dir, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' });
      this.child = child;
      child.on('exit', () => {
        if (this.child === child) this.child = null;
      });
      child.on('error', () => {
        if (this.child === child) this.child = null;
      });
      // The first start builds its frontend when it's out of date: half a minute or so.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (await ready()) return undefined;
        if (!this.child) return 'Opora stopped while it was starting: run `uv run opora` in its folder to see why';
      }
      return 'Opora didn’t answer within a minute and a half';
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.child?.kill();
    this.child = null;
  }
}

export const oporaProcess = new OporaProcess();
