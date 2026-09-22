/** A command line as words, the way a shell would split it: quotes keep
 *  spaces in, a backslash keeps the next character as it is. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started || word) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started || word) words.push(word);
  return words;
}
