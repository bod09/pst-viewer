/**
 * An mboxrd reader for the tests, written from the format's own rules and
 * apart from the code that writes .mbox files, so a mistake there is not
 * copied here:
 * - a message starts at a line beginning `From ` that opens the file or
 *   follows a blank line, and that line is not part of the message;
 * - the blank line before the next such line belongs to the format, not to
 *   the message, and so does the one at the end of the file;
 * - one `>` comes off every line that is `From ` after one or more `>`.
 *
 * Throws if the file is not mboxrd as this export writes it: lines must end
 * in LF alone, and the file must start with a `From ` line.
 */
export function readMboxrd(file: string): { separator: string; message: string }[] {
  if (file === '') return []
  if (file.includes('\r\n')) throw new Error('a line ends in CRLF')
  if (!file.endsWith('\n\n')) throw new Error('the file does not end with a blank line')
  if (!file.startsWith('From ')) throw new Error('the file does not start with a From line')
  const lines = file.split('\n')
  lines.pop()
  const out: { separator: string; lines: string[] }[] = []
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('From ') && (i === 0 || lines[i - 1] === '')) {
      out.at(-1)?.lines.pop()
      out.push({ separator: line, lines: [] })
    } else {
      out.at(-1)!.lines.push(line.replace(/^>(>*From )/, '$1'))
    }
  }
  out.at(-1)?.lines.pop()
  return out.map((m) => ({ separator: m.separator, message: `${m.lines.join('\n')}\n` }))
}
