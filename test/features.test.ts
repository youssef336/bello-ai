import { describe, expect, it } from 'vitest';
import { parseAttachments, toApiMessages, turnSize } from '../src/attachments';
import { sourcesOf, stripCitations, wantsWeb } from '../src/search';
import { cleanTitle } from '../src/titles';

const pic = (n: number) => ({ type: 'image', name: `p${n}.jpg`, data: `data:image/jpeg;base64,AAA${n}` });

describe('parseAttachments', () => {
  it('accepts pictures and files', () => {
    const out = parseAttachments([pic(1), { type: 'file', name: 'a.txt', text: 'hi' }]);
    expect(Array.isArray(out) && out.length).toBe(2);
  });
  it('refuses anything that is not a picture data URL', () => {
    expect(typeof parseAttachments([{ type: 'image', name: 'x', data: 'https://evil.example/x.png' }])).toBe('string');
    expect(typeof parseAttachments([{ type: 'image', name: 'x', data: 'data:image/svg+xml;base64,AAAA' }])).toBe('string');
  });
  it('limits how many pictures one message carries', () => {
    expect(typeof parseAttachments([1, 2, 3, 4, 5].map(pic))).toBe('string');
  });
});

describe('toApiMessages', () => {
  const turns = [
    { role: 'user' as const, content: 'what is this', attachments: parseAttachments([pic(1)]) as never },
    { role: 'assistant' as const, content: 'a cat' },
    { role: 'user' as const, content: 'summarise', attachments: [{ type: 'file' as const, name: 'n.txt', text: 'notes' }] },
  ];
  it('sends pictures to a model that reads them', () => {
    const out = toApiMessages(turns, true);
    expect(Array.isArray(out[0]!.content)).toBe(true);
  });
  it('leaves a note in their place for one that does not', () => {
    expect(toApiMessages(turns, false)[0]!.content).toBe('what is this\n[picture: p1.jpg]');
  });
  it('puts a file text after the message', () => {
    expect(toApiMessages(turns, false)[2]!.content).toBe('summarise\n\n--- n.txt ---\nnotes');
  });
  it('counts files and pictures against the history budget', () => {
    expect(turnSize(turns[0]!)).toBeGreaterThan(1000);
  });
});

describe('wantsWeb', () => {
  it('news, prices, weather', () => {
    expect(wantsWeb('ايه أخبار الدوري')).toBe(true);
    expect(wantsWeb('سعر الدولار كام')).toBe(true);
    expect(wantsWeb('what is the weather in Cairo')).toBe(true);
  });
  it('not everyday questions', () => {
    expect(wantsWeb('اكتبلي رسالة عيد ميلاد')).toBe(false);
    expect(wantsWeb('fix this bug')).toBe(false);
  });
});

describe('cleanTitle', () => {
  it('strips quotes, labels and thinking', () => {
    expect(cleanTitle('<think>hmm</think>\n"خطة مذاكرة TypeScript"')).toBe('خطة مذاكرة TypeScript');
    expect(cleanTitle('Title: Deploying a Worker.')).toBe('Deploying a Worker');
  });
  it('nothing usable', () => expect(cleanTitle('  \n ')).toBeNull());
});

describe('search results', () => {
  it('opened pages first, titles from the search, no duplicates', () => {
    const out = sourcesOf([
      { type: 'browser_search', search_results: { results: [
        { title: 'Gold today', url: 'https://a.example/gold' },
        { title: 'Other', url: 'https://b.example/x' },
      ] } },
      { type: 'browser.open', search_results: { results: [{ title: 'b.example - viewing lines', url: 'https://b.example/x' }] } },
    ]);
    expect(out).toEqual([
      { url: 'https://b.example/x', title: 'Other' },
      { url: 'https://a.example/gold', title: 'Gold today' },
    ]);
  });
  it('drops citation markers', () => expect(stripCitations('6,983 EGP 【1†L4-L8】【1†L17】.')).toBe('6,983 EGP.'));
});
