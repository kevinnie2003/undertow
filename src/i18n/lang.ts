/** The languages the game speaks. Agents read the current one each time they talk. */
export type Lang = 'en' | 'zh';

export const LANGS: Lang[] = ['en', 'zh'];

export function asLang(x: unknown): Lang {
  return x === 'zh' ? 'zh' : 'en';
}

/** A mutable holder shared by every agent in a game, so a switch applies to the next line spoken. */
export interface LangRef {
  current: Lang;
}

export function langRef(lang: Lang = 'en'): LangRef {
  return { current: lang };
}
