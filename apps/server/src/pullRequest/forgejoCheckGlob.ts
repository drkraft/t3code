type Match = (runes: readonly string[], positions: ReadonlySet<number>) => Set<number>;

const advance =
  (accepts: (rune: string) => boolean): Match =>
  (runes, positions) => {
    const next = new Set<number>();
    for (const position of positions) {
      const rune = runes[position];
      if (rune !== undefined && accepts(rune)) next.add(position + 1);
    }
    return next;
  };

/** Forgejo uses gobwas/glob without separators, so wildcards also consume slashes. */
export function compileForgejoCheckGlob(pattern: string): ((context: string) => boolean) | null {
  const runes = Array.from(pattern.split("\0", 1)[0] ?? "");
  if (runes.some((rune) => rune === "�" || /^[\uD800-\uDFFF]$/u.test(rune))) return null;
  let cursor = 0;

  const characterClass = (): Match | null => {
    const negate = runes[cursor] === "!";
    if (negate) cursor++;
    const low = runes[cursor];
    if (low === undefined) return null;
    if (runes[cursor + 1] === "-") {
      const high = runes[cursor + 2];
      if (high === undefined || runes[cursor + 3] !== "]") return null;
      const lowPoint = low.codePointAt(0) ?? 0;
      const highPoint = high.codePointAt(0) ?? 0;
      if (lowPoint > highPoint) return null;
      cursor += 4;
      return advance((rune) => {
        const point = rune.codePointAt(0) ?? 0;
        return (point >= lowPoint && point <= highPoint) !== negate;
      });
    }
    const chars = new Set<string>();
    while (cursor < runes.length) {
      const rune = runes[cursor++];
      if (rune === undefined) break;
      if (rune === "]") return chars.size ? advance((char) => chars.has(char) !== negate) : null;
      if (rune === "\\") {
        const escaped = runes[cursor++];
        if (escaped !== undefined) chars.add(escaped);
      } else {
        chars.add(rune);
      }
    }
    return null;
  };

  const sequence = (inAlternatives: boolean): { match: Match; separator: boolean } | null => {
    const steps: Match[] = [];
    let separator = false;
    while (cursor < runes.length) {
      const rune = runes[cursor++];
      if (inAlternatives && (rune === "," || rune === "}")) {
        separator = rune === ",";
        break;
      }
      switch (rune) {
        case undefined:
          break;
        case "\\": {
          const escaped = runes[cursor++];
          if (escaped !== undefined) steps.push(advance((char) => char === escaped));
          break;
        }
        case "*":
          steps.push((context, positions) => {
            const next = new Set<number>();
            let first = context.length + 1;
            for (const position of positions) first = Math.min(first, position);
            for (let position = first; position <= context.length; position++) next.add(position);
            return next;
          });
          break;
        case "?":
          steps.push(advance(() => true));
          break;
        case "[": {
          const chars = characterClass();
          if (chars === null) return null;
          steps.push(chars);
          break;
        }
        case "{": {
          const alternatives: Match[] = [];
          let another = true;
          while (another) {
            const alternative = sequence(true);
            if (alternative === null) return null;
            alternatives.push(alternative.match);
            another = alternative.separator;
          }
          steps.push((context, positions) => {
            const next = new Set<number>();
            for (const alternative of alternatives)
              for (const position of alternative(context, positions)) next.add(position);
            return next;
          });
          break;
        }
        default:
          steps.push(advance((char) => char === rune));
      }
    }
    return {
      separator,
      match: (context, positions) => {
        let next = new Set(positions);
        for (const step of steps) next = step(context, next);
        return next;
      },
    };
  };

  const match = sequence(false);
  if (match === null) return null;
  return (context) => {
    const chars = Array.from(context);
    return match.match(chars, new Set([0])).has(chars.length);
  };
}
