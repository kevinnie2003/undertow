import { ROLES } from '../engine/roles.js';
import type { Claim, PlayerId } from '../engine/types.js';
import type { Rng } from '../engine/rng.js';
import type { Persona } from './personas.js';

/**
 * Turns structured claims into table talk in a persona's voice. Used by the
 * heuristic agents (and as a fallback when an LLM fails), so the transcript
 * reads like people talking rather than a log.
 */

type NameOf = (id: PlayerId) => string;

const OPENERS: Record<Persona['voice'], string[]> = {
  blunt: ['Right.', 'Listen.', 'No time for this.', 'Here it is.', ''],
  warm: ['Okay, everyone.', 'Hey, all.', 'I know this is hard.', 'Deep breath, team.', ''],
  analytical: ['Let me lay this out.', 'Looking at what we know:', 'Data first.', 'A few observations.', ''],
  nervous: ['Um, okay.', 'I, uh, have to say this.', 'Sorry, this is a lot.', 'Okay okay okay.', ''],
  dry: ['Well.', 'Lovely night.', 'So.', 'Another fine morning on the sea floor.', ''],
};

const QUIET: Record<Persona['voice'], string[]> = {
  blunt: ['I have nothing solid yet. Watching.', 'Nothing to report. Someone give me a reason.', 'Talk is cheap. I want to see votes.'],
  warm: ['I don\'t have much yet, I\'m listening to everyone.', 'Nothing concrete from me. Let\'s keep talking.', 'I trust most of you right now, honestly.'],
  analytical: ['Too little data to move the needle yet.', 'My priors haven\'t shifted much.', 'Nothing conclusive. I\'m tracking who claims what.'],
  nervous: ['I don\'t know anything, I swear.', 'I\'ve got nothing, sorry.', 'Can someone else go first next time?'],
  dry: ['Nothing to add. Shocking, I know.', 'I\'ll save my brilliance for later.', 'No news from my corner of the station.'],
};

export function renderSpeech(claims: Claim[], persona: Persona, name: NameOf, rng: Rng, mood?: 'defend' | 'last'): string {
  const parts: string[] = [];
  const opener = rng.pick(OPENERS[persona.voice]);
  if (opener) parts.push(opener);
  if (mood === 'last') parts.push(rng.pick(['Before I go:', 'Last thing from me:', 'For the record:']));
  if (mood === 'defend') parts.push(rng.pick(['I am not Undertow.', 'You have the wrong person.', 'Stop looking at me, I\'m crew.']));
  for (const c of claims) {
    const s = sentence(c, persona, name, rng);
    if (s) parts.push(s);
  }
  if (claims.length === 0 && mood !== 'defend') parts.push(rng.pick(QUIET[persona.voice]));
  return parts.join(' ');
}

function sentence(c: Claim, persona: Persona, name: NameOf, rng: Rng): string {
  switch (c.type) {
    case 'role':
      return rng.pick([`I'm the ${ROLES[c.role].name}.`, `I'll say it: I'm the ${ROLES[c.role].name}.`, `Cards on the table, ${ROLES[c.role].name}.`]);
    case 'scan':
      return c.result === 'undertow'
        ? rng.pick([`Night ${c.round} I pinged ${name(c.target)}. The echo came back wrong. Undertow.`, `${name(c.target)} pinged Undertow on night ${c.round}.`])
        : rng.pick([`Night ${c.round}: ${name(c.target)} echoed clean, crew.`, `${name(c.target)} is clean, I pinged them night ${c.round}.`]);
    case 'protect':
      return `I sealed ${name(c.target)} in the med bay on night ${c.round}.`;
    case 'read':
      return `I pulled ${name(c.target)}'s file on night ${c.round}: ${ROLES[c.role].name}.`;
    case 'clue':
      return rng.pick([
        `The station log gave me a list on night ${c.round}: ${list(c.suspects, name)}. At least one of them is Undertow.`,
        `My log clue from night ${c.round} says one of ${list(c.suspects, name)} is Undertow.`,
      ]);
    case 'accuse':
      switch (persona.voice) {
        case 'blunt':
          return rng.pick([`${name(c.target)} is Undertow. I'd bet my air on it.`, `${name(c.target)} doesn't add up.`]);
        case 'warm':
          return rng.pick([`I'm sorry, ${name(c.target)}, but you worry me.`, `Something about ${name(c.target)} feels off to me.`]);
        case 'analytical':
          return rng.pick([`${name(c.target)} is my top suspect on the evidence.`, `The numbers keep pointing at ${name(c.target)}.`]);
        case 'nervous':
          return rng.pick([`I think it might be ${name(c.target)}? Maybe?`, `${name(c.target)} is scaring me a little.`]);
        case 'dry':
          return rng.pick([`My money's on ${name(c.target)}. Nothing personal.`, `${name(c.target)}, you're doing a great impression of Undertow.`]);
      }
      return '';
    case 'vouch':
      return rng.pick([`I trust ${name(c.target)}.`, `${name(c.target)} is fine by me.`, `Leave ${name(c.target)} alone, they're with us.`]);
    case 'intend_vote':
      return c.target === 'skip'
        ? rng.pick(['I\'m holding my vote this time.', 'I\'ll skip unless something changes.'])
        : rng.pick([`My vote goes to ${name(c.target)}.`, `I'm voting ${name(c.target)}.`, `${name(c.target)} gets my vote.`]);
  }
}

function list(ids: PlayerId[], name: NameOf): string {
  const names = ids.map(name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
