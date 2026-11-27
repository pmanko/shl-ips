// Parses the markdown that chat models commonly write (headings, bold, italics, inline code,
// lists, quotes, rules, fenced code) into a small tree that ChatMarkdown.svelte renders as
// elements. Nothing is ever turned into HTML: every piece of model output ends up in a text
// node, so there is no HTML injection surface. Anything that isn't recognised, including
// markers left open while an answer is still streaming, stays as plain text.

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'em'; children: MarkdownInline[] };

export interface MarkdownListItem {
  /** Nesting level, 0 for the list's outermost items */
  depth: number;
  children: MarkdownInline[];
}

export type MarkdownBlock =
  | { type: 'heading'; level: number; children: MarkdownInline[] }
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { type: 'quote'; children: MarkdownInline[] }
  | { type: 'code'; text: string }
  | { type: 'rule' };

// Alternatives, in order: `code`, **strong**, __strong__, *em*, _em_. The underscore forms need
// a word boundary on both sides so snake_case names are left alone.
const INLINE =
  /(`[^`\n]+`)|(\*\*(?=\S)(?:[^*]|\*(?!\*))+?\*\*)|(\b__(?=\S)[^_]+?__\b)|(\*(?=[^\s*])[^*\n]+?\*)|(\b_(?=[^\s_])[^_\n]+?_\b)/;

function pushText(out: MarkdownInline[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

export function parseInline(source: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let rest = source;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) {
      pushText(out, rest);
      break;
    }
    const token = match[0];
    const marker = match[1] ? 1 : match[2] || match[3] ? 2 : 1;
    const inner = token.slice(marker, -marker);
    pushText(out, rest.slice(0, match.index));
    if (match[1]) {
      out.push({ type: 'code', text: inner });
    } else if (/\s$/.test(inner)) {
      // "** not bold **": a closing marker after a space isn't emphasis
      pushText(out, token);
    } else {
      out.push({ type: marker === 2 ? 'strong' : 'em', children: parseInline(inner) });
    }
    rest = rest.slice(match.index + token.length);
  }
  return out;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
const NUMBERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;

function indentWidth(indent: string) {
  return indent.replace(/\t/g, '    ').length;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i++;
      // An unclosed fence (still streaming) takes the rest of the text
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2])
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ type: 'quote', children: parseInline(body.join('\n')) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      const baseIndent = indentWidth((bullet ?? numbered)![1]);
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length) {
        const current = lines[i];
        const b = BULLET.exec(current);
        const n = b ? null : NUMBERED.exec(current);
        if (b || n) {
          const indent = indentWidth((b ?? n)![1]);
          // A marker of the other kind at the list's own level starts a new list
          if (indent <= baseIndent && !!n !== ordered) break;
          items.push({
            depth: Math.max(0, Math.round((indent - baseIndent) / 2)),
            text: b ? b[2] : n![3]
          });
        } else if (current.trim() && /^[ \t]/.test(current) && !RULE.test(current)) {
          // An indented line continues the item above it
          items[items.length - 1].text += '\n' + current.trim();
        } else {
          break;
        }
        i++;
      }
      blocks.push({
        type: 'list',
        ordered,
        start: numbered ? Number(numbered[2]) : 1,
        items: items.map(({ depth, text }) => ({ depth, children: parseInline(text) }))
      });
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
}
