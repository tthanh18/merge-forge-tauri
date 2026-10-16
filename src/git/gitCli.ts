import { execFile } from 'node:child_process';

/** A git invocation that exited non-zero. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Runs git and returns stdout as a Buffer.
 *
 * Output stays binary: file contents must survive byte-for-byte through the merge, and
 * decoding here would destroy CRLF, BOMs, and any non-UTF-8 content. Arguments are passed
 * as an array (never a shell string), so paths with spaces or quotes need no escaping.
 */
export function git(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args as string[],
      { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number }).code;
          const text = stderr.toString().trim();
          reject(
            new GitError(
              `git ${args.join(' ')} failed: ${text || error.message}`,
              typeof code === 'number' ? code : undefined,
              text,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Runs git and returns stdout decoded as UTF-8 with trailing whitespace removed. */
export async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await git(cwd, args)).toString('utf8').trimEnd();
}
