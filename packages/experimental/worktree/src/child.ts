/** Static child programs for checkout allocation and inspection inside the process sandbox. */

/**
 * The child receives its mode and literal arguments as argv after a `--` separator, so no argument
 * can be read as a Node command. `allocate` claims the pool and the destination directory and
 * reports the destination's device and inode; `report` reports the destination's identity, the Git
 * administration directory its `.git` pointer names, and the administration directory Git
 * registered for that checkout. The report is one JSON object on stdout; the caller reads it
 * before it materializes any file.
 */
export const WORKTREE_CHILD = `
import fs from 'node:fs/promises';
import path from 'node:path';

const comparisonKey = value => {
  const unified = value.replaceAll('\\\\', '/').replace(/\\/+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
};

const identity = async destination => {
  const report = { dev: null, ino: null, directory: false };
  try {
    const info = await fs.lstat(destination, { bigint: true });
    report.dev = info.dev.toString();
    report.ino = info.ino.toString();
    report.directory = info.isDirectory();
  } catch (error) {
    // A checkout path that cannot be read has no identity to compare.
  }
  return report;
};

const allocate = async (root, destination) => {
  await fs.mkdir(path.dirname(root), { recursive: true });
  let created = false;
  try {
    await fs.mkdir(root);
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST' || !(await fs.stat(root)).isDirectory()) throw error;
  }
  if (created) await fs.writeFile(path.join(root, '.gitignore'), '*\\n', { flag: 'wx' });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(destination);
};

const administration = async (destination, commonDirectory) => {
  const report = { pointer: null, pointerKey: null, registered: null, registeredKey: null, registeredCount: 0 };
  const pointerFile = path.join(destination, '.git');
  try {
    const text = (await fs.readFile(pointerFile, 'utf8')).trim();
    const match = /^gitdir:\\s*(.+)$/u.exec(text);
    if (match !== null) {
      report.pointer = match[1].trim();
      report.pointerKey = comparisonKey(report.pointer);
    }
  } catch (error) {
    // A missing or unreadable pointer names no administration directory.
  }
  const worktrees = path.join(commonDirectory, 'worktrees');
  const registered = [];
  try {
    for (const entry of await fs.readdir(worktrees, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(worktrees, entry.name);
      let recorded;
      try {
        recorded = (await fs.readFile(path.join(candidate, 'gitdir'), 'utf8')).trim();
      } catch (error) {
        continue;
      }
      if (comparisonKey(recorded) === comparisonKey(pointerFile)) registered.push(candidate);
    }
  } catch (error) {
    // A repository without registered worktrees names no administration directory.
  }
  report.registeredCount = registered.length;
  if (registered.length === 1) {
    report.registered = registered[0];
    report.registeredKey = comparisonKey(registered[0]);
  }
  return report;
};

const main = async () => {
  const [mode, first, second] = process.argv.slice(1);
  if (mode === 'allocate') {
    await allocate(first, second);
    const report = await identity(second);
    process.stdout.write(JSON.stringify({ ...report, pointer: null, pointerKey: null, registered: null, registeredKey: null, registeredCount: 0 }));
    return;
  }
  if (mode === 'report') {
    process.stdout.write(JSON.stringify({ ...await identity(first), ...await administration(first, second) }));
    return;
  }
  throw new Error('unknown worktree child mode: ' + mode);
};

main().catch(error => { console.error(error.message); process.exitCode = 1; });
`

/** Device and inode identity of the allocated checkout directory. */
export interface DirectoryIdentity {
  /** Device number of the checkout directory entry. */
  dev: string
  /** Inode number of the checkout directory entry. */
  ino: string
}

/** Checkout identity and Git administration facts reported by the inspection child. */
export interface CheckoutInspection {
  /** Device number of the checkout directory entry; null when the entry cannot be read. */
  dev: string | null
  /** Inode number of the checkout directory entry; null when the entry cannot be read. */
  ino: string | null
  /** Whether the checkout path is still a directory rather than a link or another entry. */
  directory: boolean
  /** Git administration directory the checkout's `.git` pointer names; null when it names none. */
  pointer: string | null
  /** Comparison key of {@link CheckoutInspection.pointer}; equal keys name the same directory. */
  pointerKey: string | null
  /** Git administration directory Git registered for this checkout; null when none names it. */
  registered: string | null
  /** Comparison key of {@link CheckoutInspection.registered}. */
  registeredKey: string | null
  /** How many registered administration directories name this checkout. */
  registeredCount: number
}

/**
 * Read one report field as text.
 * @param record - the parsed report object.
 * @param key - field name.
 * @returns the field text, or null when the field is absent or is not text.
 */
function reportText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

/**
 * Parse the JSON object a child program printed.
 * @param stdout - complete child stdout.
 * @returns the report fields.
 * @throws when the child printed output this service cannot interpret.
 */
function reportRecord(stdout: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error: unknown) {
    throw new Error(`worktree: the checkout child reported unreadable output: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('worktree: the checkout child reported an unreadable result')
  }
  return parsed as Record<string, unknown>
}

/**
 * Parse the identity the allocation child reported.
 * @param stdout - complete child stdout.
 * @returns the allocated directory's device and inode.
 * @throws when the child reported no usable identity.
 */
export function parseAllocation(stdout: string): DirectoryIdentity {
  const record = reportRecord(stdout)
  const dev = reportText(record, 'dev')
  const ino = reportText(record, 'ino')
  if (dev === null || ino === null) throw new Error('worktree: the directory allocation child reported no identity')
  return { dev, ino }
}

/**
 * Parse the inspection the child reported.
 * @param stdout - complete child stdout.
 * @returns the checkout's identity and Git administration facts.
 */
export function parseInspection(stdout: string): CheckoutInspection {
  const record = reportRecord(stdout)
  const count = record['registeredCount']
  return {
    dev: reportText(record, 'dev'),
    ino: reportText(record, 'ino'),
    directory: record['directory'] === true,
    pointer: reportText(record, 'pointer'),
    pointerKey: reportText(record, 'pointerKey'),
    registered: reportText(record, 'registered'),
    registeredKey: reportText(record, 'registeredKey'),
    registeredCount: typeof count === 'number' ? count : 0,
  }
}
