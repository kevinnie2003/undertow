/**
 * Original characters for the AI seats. Each persona has a speaking voice used by
 * the template text generator and a few behavioural dials used by the heuristic
 * policy. LLM agents get the persona description in their system prompt.
 */
export interface Persona {
  name: string;
  job: string;
  voice: 'blunt' | 'warm' | 'analytical' | 'nervous' | 'dry';
  description: string;
  /** 0..1: how readily they accuse and push votes. */
  aggression: number;
  /** 0..1: as Undertow, how willing they are to fake a role claim. */
  boldness: number;
  /** 0..1: as a crew power role, how early they reveal. */
  openness: number;
}

export const PERSONAS: Persona[] = [
  { name: 'Ines Calloway', job: 'hull engineer', voice: 'blunt', description: 'Twenty years of welding pressure seams. Says what she thinks, once.', aggression: 0.8, boldness: 0.6, openness: 0.6 },
  { name: 'Bram Okafor', job: 'station cook', voice: 'warm', description: 'Knows everyone\'s coffee order. Hates conflict, but notices who skips meals.', aggression: 0.35, boldness: 0.4, openness: 0.5 },
  { name: 'Tove Lindqvist', job: 'marine biologist', voice: 'analytical', description: 'Keeps a notebook of everything. Thinks in probabilities and says so.', aggression: 0.55, boldness: 0.5, openness: 0.7 },
  { name: 'Ravi Mehta', job: 'comms officer', voice: 'nervous', description: 'Hears every crackle on the line. Talks fast when he is scared.', aggression: 0.45, boldness: 0.3, openness: 0.4 },
  { name: 'Mara Quill', job: 'dive lead', voice: 'dry', description: 'Has done three hundred dives and has a joke for each.', aggression: 0.6, boldness: 0.75, openness: 0.5 },
  { name: 'Jonah Pike', job: 'reactor tech', voice: 'blunt', description: 'Ex-navy. Wants a plan and a vote, in that order.', aggression: 0.7, boldness: 0.55, openness: 0.55 },
  { name: 'Sefa Tuilagi', job: 'medical officer', voice: 'warm', description: 'Calm voice, steady hands. Asks people how they are, and listens to the answer.', aggression: 0.4, boldness: 0.45, openness: 0.45 },
  { name: 'Odile Marchetti', job: 'geologist', voice: 'analytical', description: 'Treats every argument like a core sample: layer by layer.', aggression: 0.5, boldness: 0.6, openness: 0.65 },
  { name: 'Kasimir Wren', job: 'drone pilot', voice: 'dry', description: 'Spends his days steering a camera through the dark. Unimpressed by drama.', aggression: 0.5, boldness: 0.7, openness: 0.4 },
  { name: 'Hana Sato', job: 'data analyst', voice: 'nervous', description: 'Brilliant with numbers, less so with being stared at.', aggression: 0.4, boldness: 0.35, openness: 0.6 },
];

export function personaFor(name: string): Persona {
  return PERSONAS.find((p) => p.name === name) ?? PERSONAS[0];
}
