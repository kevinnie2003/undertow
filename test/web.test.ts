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
});
