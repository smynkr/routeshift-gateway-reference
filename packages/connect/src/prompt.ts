import { createInterface } from 'node:readline';

export interface ConfirmOptions {
  /** Skip the interactive prompt and answer yes (the --yes flag). */
  assumeYes?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Yes/No confirmation. Defaults to No on empty input or non-TTY without --yes. */
export async function confirm(question: string, opts: ConfirmOptions = {}): Promise<boolean> {
  if (opts.assumeYes) return true;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  // Non-interactive stdin with no --yes: fail safe to "no" rather than hang.
  if (input === process.stdin && !process.stdin.isTTY) return false;

  const rl = createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
