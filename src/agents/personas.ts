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

/** Chinese job titles and descriptions, keyed by persona name. Names stay as they are. */
const ZH: Record<string, { job: string; description: string }> = {
  'Ines Calloway': { job: '船壳工程师', description: '焊了二十年耐压焊缝。心里怎么想就怎么说，只说一遍。' },
  'Bram Okafor': { job: '站上厨师', description: '记得每个人喝什么咖啡。讨厌争执，但会留意谁没来吃饭。' },
  'Tove Lindqvist': { job: '海洋生物学家', description: '什么都记在本子上。用概率思考，也用概率说话。' },
  'Ravi Mehta': { job: '通讯官', description: '线路上每一声杂音都听得见。一害怕说话就快。' },
  'Mara Quill': { job: '潜水队长', description: '潜过三百次水，每次都能讲个笑话。' },
  'Jonah Pike': { job: '反应堆技师', description: '海军出身。先要计划，再要投票。' },
  'Sefa Tuilagi': { job: '医务官', description: '声音平稳，手也稳。会问别人过得怎么样，并且认真听回答。' },
  'Odile Marchetti': { job: '地质学家', description: '对待每个论点都像对待岩芯样本：一层一层看。' },
  'Kasimir Wren': { job: '无人机驾驶员', description: '整天操纵摄像机在黑暗里穿行。对戏剧性的场面无动于衷。' },
  'Hana Sato': { job: '数据分析师', description: '数字上很出色，被人盯着看就不太行了。' },
};

export function personaJob(p: { name: string; job: string }, lang: 'en' | 'zh'): string {
  return lang === 'zh' ? (ZH[p.name]?.job ?? p.job) : p.job;
}

export function personaDescription(p: Persona, lang: 'en' | 'zh'): string {
  return lang === 'zh' ? (ZH[p.name]?.description ?? p.description) : p.description;
}
