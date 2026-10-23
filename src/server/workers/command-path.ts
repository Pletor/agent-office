/** Keep the Office command directory visible when Git Bash restores its login PATH. */
export function prependOfficeCommandPath(env: Record<string, string>, bin: string, windows = process.platform === 'win32'): void {
  const keys = Object.keys(env).filter(k => windows ? k.toUpperCase() === 'PATH' : k === 'PATH');
  const key = keys[0] ?? 'PATH';
  const inherited = env[key];
  for (const duplicate of keys.slice(1)) delete env[duplicate];
  env[key] = [bin, inherited].filter(Boolean).join(windows ? ';' : ':');
  if (!windows) return;

  // Git's /etc/profile uses an already-exported ORIGINAL_PATH instead of the new
  // native PATH. Preserve that snapshot; prepend only our generated command dir.
  // ORIGINAL_PATH is an MSYS colon-separated list, not a Windows PATH string.
  const originalKey = Object.keys(env).find(k => k.toUpperCase() === 'ORIGINAL_PATH');
  if (!originalKey || !env[originalKey]) return;
  const msysBin = bin.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);
  env[originalKey] = `${msysBin}:${env[originalKey]}`;
}
