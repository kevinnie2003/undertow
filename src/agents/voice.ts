import type { Claim, PlayerId } from '../engine/types.js';
import type { Rng } from '../engine/rng.js';
import type { Lang } from '../i18n/lang.js';
import { roleName } from '../i18n/roles.js';
import { spaceMixed } from '../i18n/spacing.js';
import type { Persona } from './personas.js';

/**
 * Turns structured claims into table talk in a persona's voice. Used by the
 * heuristic agents (and as a fallback when an LLM fails), so the transcript
 * reads like people talking rather than a log.
 *
 * Every language pack draws from the random stream in exactly the same places,
 * so a seeded game plays out identically whichever language it is spoken in.
 */

type NameOf = (id: PlayerId) => string;
type Voice = Persona['voice'];

export interface Scene {
  /** Crew dragged under last night. */
  lost: PlayerId[];
  /** Nobody was taken last night (not counting the calm first night). */
  calm: boolean;
}

interface Pack {
  openers: Record<Voice, string[]>;
  loss: Record<Voice, ((who: string) => string)[]>;
  calm: Record<Voice, string[]>;
  quiet: Record<Voice, string[]>;
  last: string[];
  defend: string[];
  /** Joins sentences into one speech. */
  join: string;
  sentence: (c: Claim, voice: Voice, name: NameOf, rng: Rng) => string;
}

const EN: Pack = {
  openers: {
    blunt: ['Right.', 'Listen.', 'No time for this.', 'Here it is.', ''],
    warm: ['Okay, everyone.', 'Hey, all.', 'I know this is hard.', 'Deep breath, team.', ''],
    analytical: ['Let me lay this out.', 'Looking at what we know:', 'Data first.', 'A few observations.', ''],
    nervous: ['Um, okay.', 'I, uh, have to say this.', 'Sorry, this is a lot.', 'Okay okay okay.', ''],
    dry: ['Well.', 'So.', 'Right then.', ''],
  },
  loss: {
    blunt: [(w) => `${w} is gone. Let's make it count.`, (w) => `They took ${w}. Enough.`],
    warm: [(w) => `I can't believe ${w} is gone.`, (w) => `Poor ${w}. Let's do right by them.`],
    analytical: [(w) => `We lost ${w} overnight, which tells us something.`, (w) => `${w} was taken, so ${w} was crew. Let's use that.`],
    nervous: [(w) => `${w} is... gone. Okay. Okay.`, (w) => `They got ${w}. I could be next.`],
    dry: [(w) => `So ${w} didn't make it to breakfast.`, (w) => `One fewer for coffee. Goodbye, ${w}.`],
  },
  calm: {
    blunt: ['Nobody taken. Someone got sealed in, or someone got lucky.'],
    warm: ['Everyone made it through the night. Thank goodness.'],
    analytical: ['A quiet night. Either the med bay worked, or they held back.'],
    nervous: ["Everyone's still here? Good. Good."],
    dry: ['Lovely night. Nobody drowned.', 'Another fine morning on the sea floor.'],
  },
  quiet: {
    blunt: ['I have nothing solid yet. Watching.', 'Nothing to report. Someone give me a reason.', 'Talk is cheap. I want to see votes.'],
    warm: ["I don't have much yet, I'm listening to everyone.", "Nothing concrete from me. Let's keep talking.", 'I trust most of you right now, honestly.'],
    analytical: ['Too little data to move the needle yet.', "My priors haven't shifted much.", "Nothing conclusive. I'm tracking who claims what."],
    nervous: ["I don't know anything, I swear.", "I've got nothing, sorry.", 'Can someone else go first next time?'],
    dry: ['Nothing to add. Shocking, I know.', "I'll save my brilliance for later.", 'No news from my corner of the station.'],
  },
  last: ['Before I go:', 'Last thing from me:', 'For the record:'],
  defend: ['I am not Undertow.', 'You have the wrong person.', "Stop looking at me, I'm crew."],
  join: ' ',
  sentence(c, voice, name, rng) {
    const role = (r: Parameters<typeof roleName>[0]) => roleName(r, 'en');
    switch (c.type) {
      case 'role':
        return rng.pick([`I'm the ${role(c.role)}.`, `I'll say it: I'm the ${role(c.role)}.`, `Cards on the table: I'm the ${role(c.role)}.`]);
      case 'scan':
        return c.result === 'undertow'
          ? rng.pick([`Night ${c.round} I pinged ${name(c.target)}. The echo came back wrong. Undertow.`, `${name(c.target)} pinged Undertow on night ${c.round}.`])
          : rng.pick([`Night ${c.round}: ${name(c.target)} echoed clean, crew.`, `${name(c.target)} is clean, I pinged them night ${c.round}.`]);
      case 'protect':
        return `I sealed ${name(c.target)} in the med bay on night ${c.round}.`;
      case 'read':
        return `I pulled ${name(c.target)}'s file on night ${c.round}: ${role(c.role)}.`;
      case 'clue':
        return rng.pick([
          `The station log gave me a list on night ${c.round}: ${list(c.suspects, name, ', ', ' and ')}. At least one of them is Undertow.`,
          `My log clue from night ${c.round} says one of ${list(c.suspects, name, ', ', ' and ')} is Undertow.`,
        ]);
      case 'accuse': {
        const t = name(c.target);
        const lines: Record<Voice, string[]> = {
          blunt: [`${t} is Undertow. I'd bet my air on it.`, `${t} doesn't add up.`],
          warm: [`I'm sorry, ${t}, but you worry me.`, `Something about ${t} feels off to me.`],
          analytical: [`${t} is my top suspect on the evidence.`, `The numbers keep pointing at ${t}.`],
          nervous: [`I think it might be ${t}? Maybe?`, `${t} is scaring me a little.`],
          dry: [`My money's on ${t}. Nothing personal.`, `${t}, you're doing a great impression of Undertow.`],
        };
        return rng.pick(lines[voice]);
      }
      case 'vouch':
        return rng.pick([`I trust ${name(c.target)}.`, `${name(c.target)} is fine by me.`, `Leave ${name(c.target)} alone, they're with us.`]);
      case 'intend_vote':
        return c.target === 'skip'
          ? rng.pick(["I'm holding my vote this time.", "I'll skip unless something changes."])
          : rng.pick([`My vote goes to ${name(c.target)}.`, `I'm voting ${name(c.target)}.`, `${name(c.target)} gets my vote.`]);
    }
  },
};

const ZH: Pack = {
  openers: {
    blunt: ['好。', '听着。', '没时间磨蹭了。', '我直说。', ''],
    warm: ['好了，各位。', '各位，听我说。', '我知道这很难。', '大家深呼吸。', ''],
    analytical: ['我来梳理一下。', '看看我们知道些什么。', '先看数据。', '我有几点观察。', ''],
    nervous: ['呃，好吧。', '我、我得说一句。', '抱歉，信息有点多。', '好好好。', ''],
    dry: ['嗯。', '那么。', '行吧。', ''],
  },
  loss: {
    blunt: [(w) => `${w}没了。别让这白白牺牲。`, (w) => `他们带走了${w}。够了。`],
    warm: [(w) => `真不敢相信${w}就这么走了。`, (w) => `可怜的${w}。我们得对得起${w}。`],
    analytical: [(w) => `昨晚我们失去了${w}，这本身就是信息。`, (w) => `${w}被拖走了，说明${w}是船员。我们要用好这一点。`],
    nervous: [(w) => `${w}……没了。好吧。好吧。`, (w) => `他们抓走了${w}。下一个可能就是我。`],
    dry: [(w) => `看来${w}没赶上早饭。`, (w) => `少了一个人喝咖啡。再见，${w}。`],
  },
  calm: {
    blunt: ['没人被带走。要么有人被封进了医疗舱，要么有人走运。'],
    warm: ['大家都熬过了这一夜。谢天谢地。'],
    analytical: ['平静的一夜。要么医疗舱起了作用，要么他们按兵不动。'],
    nervous: ['大家都还在？好。好。'],
    dry: ['美好的一夜，没人淹死。', '海底又一个美好的早晨。'],
  },
  quiet: {
    blunt: ['我还没有确凿的东西。先看着。', '没什么可报告的。谁给我个理由。', '光说不算，我要看大家怎么投。'],
    warm: ['我还没什么头绪，在听大家说。', '我手上还没有实锤，再聊聊看。', '说实话，现在我信任你们大多数人。'],
    analytical: ['信息还太少，下不了判断。', '我之前的判断基本没变。', '还没有定论。我在记谁声称了什么。'],
    nervous: ['我什么都不知道，我发誓。', '我这边什么都没有，抱歉。', '下次能不能让别人先说？'],
    dry: ['没什么可补充的。很意外吧。', '我的高见留着以后再说。', '我这边风平浪静。'],
  },
  last: ['走之前我说一句。', '最后说一件事。', '我留个记录。'],
  defend: ['我不是暗流。', '你们找错人了。', '别盯着我，我是船员。'],
  join: '',
  sentence(c, voice, name, rng) {
    const role = (r: Parameters<typeof roleName>[0]) => roleName(r, 'zh');
    switch (c.type) {
      case 'role':
        return rng.pick([`我是${role(c.role)}。`, `我直说了，我是${role(c.role)}。`, `摊牌吧，我是${role(c.role)}。`]);
      case 'scan':
        return c.result === 'undertow'
          ? rng.pick([`第${c.round}夜我探测了${name(c.target)}，回声不对劲。是暗流。`, `第${c.round}夜${name(c.target)}的回声是暗流。`])
          : rng.pick([`第${c.round}夜：${name(c.target)}的回声干净，是船员。`, `${name(c.target)}是清白的，我第${c.round}夜探测过。`]);
      case 'protect':
        return `第${c.round}夜我把${name(c.target)}封进了医疗舱。`;
      case 'read':
        return `第${c.round}夜我调出了${name(c.target)}的档案：${role(c.role)}。`;
      case 'clue':
        return rng.pick([
          `第${c.round}夜站务日志给了我一份名单：${list(c.suspects, name, '、', '和')}。其中至少有一个暗流。`,
          `我第${c.round}夜的日志线索说，${list(c.suspects, name, '、', '和')}里有暗流。`,
        ]);
      case 'accuse': {
        const t = name(c.target);
        const lines: Record<Voice, string[]> = {
          blunt: [`${t}是暗流。我拿我的氧气打赌。`, `${t}的说法前后对不上。`],
          warm: [`对不起，${t}，但你让我担心。`, `${t}有点不对劲，我说不上来。`],
          analytical: [`按证据看，${t}是我的头号嫌疑人。`, `数字一直指向${t}。`],
          nervous: [`我觉得可能是${t}？大概？`, `${t}让我有点害怕。`],
          dry: [`我押${t}。不针对谁。`, `${t}，你演暗流演得挺像。`],
        };
        return rng.pick(lines[voice]);
      }
      case 'vouch':
        return rng.pick([`我信任${name(c.target)}。`, `${name(c.target)}我觉得没问题。`, `别动${name(c.target)}，是自己人。`]);
      case 'intend_vote':
        return c.target === 'skip'
          ? rng.pick(['这次我先不投。', '除非有新情况，我弃票。'])
          : rng.pick([`我投${name(c.target)}。`, `我的票给${name(c.target)}。`, `这一票给${name(c.target)}。`]);
    }
  },
};

const PACKS: Record<Lang, Pack> = { en: EN, zh: ZH };

export function renderSpeech(
  claims: Claim[],
  persona: Persona,
  name: NameOf,
  rng: Rng,
  mood?: 'defend' | 'last',
  scene?: Scene,
  lang: Lang = 'en',
): string {
  const pack = PACKS[lang];
  const parts: string[] = [];
  const opener = scene?.lost.length
    ? rng.pick(pack.loss[persona.voice])(name(scene.lost[0]))
    : scene?.calm
      ? rng.pick(pack.calm[persona.voice])
      : rng.pick(pack.openers[persona.voice]);
  if (opener) parts.push(opener);
  if (mood === 'last') parts.push(rng.pick(pack.last));
  if (mood === 'defend') parts.push(rng.pick(pack.defend));
  for (const c of claims) {
    const s = pack.sentence(c, persona.voice, name, rng);
    if (s) parts.push(s);
  }
  if (claims.length === 0 && mood !== 'defend') parts.push(rng.pick(pack.quiet[persona.voice]));
  const text = parts.join(pack.join);
  return lang === 'zh' ? spaceMixed(text) : text;
}

function list(ids: PlayerId[], name: NameOf, sep: string, and: string): string {
  const names = ids.map(name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(sep)}${and}${names[names.length - 1]}`;
}
