// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(__dirname, '../src/web/index.html'), 'utf8');

async function boot() {
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '');
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  Element.prototype.scrollIntoView = () => {};
  vi.resetModules();
  await import('../src/web/main.js');
  await new Promise((r) => setTimeout(r, 0));
}

const until = async (cond: () => boolean, ms = 20000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('web client (in-browser, offline)', () => {
  it('runs a spectated game to the end and shows agent minds', async () => {
    await boot();
    (document.querySelector('input[value=watch]') as HTMLInputElement).checked = true;
    (document.getElementById('pace') as HTMLInputElement).value = '0';
    (document.getElementById('players') as HTMLSelectElement).value = '6';
    document.getElementById('start')!.click();
    await until(() => !!document.querySelector('.log .end'));
    expect(document.getElementById('game')!.hidden).toBe(false);
    expect(document.querySelectorAll('#roster .card')).toHaveLength(6);
    expect(document.querySelectorAll('.log .speech').length).toBeGreaterThan(3);
    (document.querySelector('#roster .card') as HTMLElement).click();
    await until(() => !!document.querySelector('#side .beliefs .brow'));
  }, 30000);

  it('lets a human play through every decision with the UI', async () => {
    await boot();
    (document.querySelector('input[value=play]') as HTMLInputElement).checked = true;
    (document.getElementById('pace') as HTMLInputElement).value = '0';
    document.getElementById('start')!.click();
    let clicks = 0;
    await until(() => {
      if (document.querySelector('.log .end')) return true;
      const actions = document.getElementById('actions')!;
      const area = actions.querySelector('textarea') as HTMLTextAreaElement | null;
      if (area) {
        area.value = 'I am a diver and I trust nobody yet.';
        area.dispatchEvent(new Event('input'));
        const btn = [...actions.querySelectorAll('button.primary')].pop() as HTMLButtonElement | undefined;
        if (btn && !btn.disabled) {
          btn.click();
          clicks++;
        }
        return false;
      }
      const target = actions.querySelector('.targets button:not([disabled])') as HTMLButtonElement | null;
      if (target) {
        target.click();
        clicks++;
      }
      return false;
    }, 25000);
    expect(clicks).toBeGreaterThan(1);
    expect(document.querySelector('.speech.mine')).not.toBeNull();
    expect(document.querySelector('#roster .badge.role')).not.toBeNull();
  }, 30000);

  it('copies a replay at the end and plays it back from the start screen', async () => {
    await boot();
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (copied = t) }, configurable: true });
    (document.querySelector('input[value=watch]') as HTMLInputElement).checked = true;
    (document.getElementById('pace') as HTMLInputElement).value = '0';
    (document.getElementById('players') as HTMLSelectElement).value = '5';
    document.getElementById('start')!.click();
    await until(() => !!document.querySelector('.log .end'));
    const copy = [...document.querySelectorAll('#actions button')].find((b) => b.textContent === 'Copy replay') as HTMLButtonElement;
    copy.click();
    await until(() => copied.length > 0);
    const totalLines = document.querySelectorAll('.log > *').length;

    await boot();
    (document.getElementById('replay-paste') as HTMLTextAreaElement).value = copied;
    document.getElementById('replay-paste-go')!.click();
    await until(() => !!document.querySelector('#actions .replay'));
    expect(document.querySelector('.log .end')).toBeNull();
    const button = (label: string) => document.querySelector(`#actions button[aria-label="${label}"]`) as HTMLButtonElement;
    button('next phase').click();
    button('step forward').click();
    const scrub = document.querySelector('#actions .scrub') as HTMLInputElement;
    scrub.value = scrub.max;
    scrub.dispatchEvent(new Event('input'));
    await until(() => !!document.querySelector('.log .end'));
    expect(document.querySelectorAll('.log > *').length).toBe(totalLines);
    expect(document.querySelector('#actions .pos')!.textContent).toMatch(/^(\d+) \/ \1$/);
  }, 30000);
});

describe('web client in Chinese', () => {
  it('switches the interface and the AI crew to Chinese', async () => {
    await boot();
    (document.querySelector('.lang button[data-lang=zh]') as HTMLButtonElement).click();
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.getElementById('start')!.textContent).toBe('下潜');
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('你');
    (document.querySelector('input[value=watch]') as HTMLInputElement).checked = true;
    (document.getElementById('pace') as HTMLInputElement).value = '0';
    document.getElementById('start')!.click();
    await until(() => !!document.querySelector('.log .end'));
    const speeches = [...document.querySelectorAll('.log .speech .text')].map((e) => e.textContent ?? '');
    expect(speeches.length).toBeGreaterThan(3);
    for (const t of speeches) expect(t).toMatch(/[一-鿿]/);
    expect(document.querySelector('.log .end .big')!.textContent).toMatch(/船员|暗流/);
    // Switching back changes the interface at once.
    (document.querySelector('.lang button[data-lang=en]') as HTMLButtonElement).click();
    expect(document.querySelector('.log .end .big')!.textContent).toMatch(/crew|Undertow/);
    localStorage.clear();
  }, 30000);
});
