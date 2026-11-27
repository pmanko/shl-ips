import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import ChatMarkdown from '$lib/components/app/ChatMarkdown.svelte';
import { parseInline, parseMarkdown } from '$lib/utils/chatMarkdown';

// The shape of a real answer from the model: headings wrapping bold, bulleted bold drug names
// with citations, a rule and a numbered list.
const ANSWER = [
  'Based on your record, these are active. **Please confirm with your care team.** [29]',
  '',
  '### **Current Active Medications**',
  '*   **Lipitor 40 MG Oral Tablet** [9]',
  '*   **Ativan 1 MG Oral Tablet (lorazepam)** [11]',
  '',
  '***',
  '',
  '**Suggested follow-up questions:**',
  '1. "How should I manage my sleep?"',
  '2. "What about low blood sugar?"'
].join('\n');

describe('parseMarkdown', () => {
  it('splits an answer into paragraphs, a heading, lists and a rule', () => {
    const blocks = parseMarkdown(ANSWER);

    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'heading',
      'list',
      'rule',
      'paragraph',
      'list'
    ]);
    expect(blocks[1]).toMatchObject({
      level: 3,
      children: [
        { type: 'strong', children: [{ type: 'text', text: 'Current Active Medications' }] }
      ]
    });
    expect(blocks[2]).toMatchObject({ ordered: false });
    expect((blocks[2] as any).items[0].children).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'Lipitor 40 MG Oral Tablet' }] },
      { type: 'text', text: ' [9]' }
    ]);
    expect(blocks[5]).toMatchObject({ ordered: true, start: 1 });
    expect((blocks[5] as any).items).toHaveLength(2);
  });

  it('keeps nested list items with their depth and joins continuation lines', () => {
    const [list] = parseMarkdown('- Statins\n  - Lipitor\n    taken nightly\n- Sedatives') as any[];

    expect(list.items.map((i: any) => i.depth)).toEqual([0, 1, 0]);
    expect(list.items[1].children).toEqual([{ type: 'text', text: 'Lipitor\ntaken nightly' }]);
  });

  it('keeps the number an ordered list starts at', () => {
    const [list] = parseMarkdown('3. Third\n4. Fourth') as any[];

    expect(list).toMatchObject({ ordered: true, start: 3 });
  });

  it('reads quotes and fenced code, including a fence still open mid-stream', () => {
    expect(parseMarkdown('> Hold Glipizide\n> at night')).toEqual([
      { type: 'quote', children: [{ type: 'text', text: 'Hold Glipizide\nat night' }] }
    ]);
    expect(parseMarkdown('```\n**not bold**\n```')).toEqual([
      { type: 'code', text: '**not bold**' }
    ]);
    expect(parseMarkdown('```\nstill typing')).toEqual([{ type: 'code', text: 'still typing' }]);
  });
});

describe('parseInline', () => {
  it('reads bold, italics and code, nested where they overlap', () => {
    expect(parseInline('Take **two *small* tablets** with `water`')).toEqual([
      { type: 'text', text: 'Take ' },
      {
        type: 'strong',
        children: [
          { type: 'text', text: 'two ' },
          { type: 'em', children: [{ type: 'text', text: 'small' }] },
          { type: 'text', text: ' tablets' }
        ]
      },
      { type: 'text', text: ' with ' },
      { type: 'code', text: 'water' }
    ]);
  });

  it('leaves text alone when markers are unfinished or are not emphasis', () => {
    const untouched = [
      '**Lipitor 40 MG', // bold still streaming in
      'dose is 5 * 3 * 2 mg',
      'the medication_request_id field',
      '** spaced out **'
    ];
    for (const text of untouched) {
      expect(parseInline(text)).toEqual([{ type: 'text', text }]);
    }
  });
});

describe('ChatMarkdown', () => {
  it('draws the answer as elements with no markdown markers left in the text', () => {
    const { container } = render(ChatMarkdown, { text: ANSWER });

    // trim(): whitespace at the edges of a block element isn't displayed
    expect(container.querySelector('[role="heading"]')?.textContent?.trim()).toBe(
      'Current Active Medications'
    );
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelector('ul > li strong')?.textContent).toBe(
      'Lipitor 40 MG Oral Tablet'
    );
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.textContent).not.toMatch(/\*\*|###/);
    // Citations are part of the answer text and stay readable
    expect(container.querySelector('ul > li')?.textContent).toContain('[9]');
  });

  it('shows HTML in an answer as text instead of creating elements from it', () => {
    const { container } = render(ChatMarkdown, {
      text: 'Hello <img src=x onerror="alert(1)"> **<script>alert(2)</script>**'
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector('strong')?.textContent).toBe('<script>alert(2)</script>');
  });
});
