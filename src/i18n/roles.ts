import { ROLES } from '../engine/roles.js';
import type { Faction, RoleId } from '../engine/types.js';
import type { Lang } from './lang.js';

const ZH: Record<RoleId, { name: string; blurb: string }> = {
  diver: { name: '潜水员', blurb: '船员。夜里没有行动，但站务日志偶尔会给你一条线索：一份短名单，其中至少有一个暗流。' },
  sonar: { name: '声呐员', blurb: '船员。每晚探测一名玩家，听回声判断对方是船员还是暗流。塞壬的回声听起来像船员。' },
  medic: { name: '医生', blurb: '船员。每晚把一名玩家封进医疗舱。暗流来拖人时，被封的人能活下来。不能连续两晚封同一个人。' },
  archivist: { name: '档案员', blurb: '船员。除了你，没人知道遇难者的真实身份。每晚可以查阅一名遇难者的人事档案，得知其真实角色。' },
  drowned: { name: '溺亡者', blurb: '暗流。你认识其他暗流。每晚你们一起选一个人拖下水。人数与船员持平，或船壳撑不住时，你们获胜。' },
  siren: { name: '塞壬', blurb: '暗流。和溺亡者一样，但声呐员听到的你的回声是船员。' },
};

export function roleName(role: RoleId, lang: Lang): string {
  return lang === 'zh' ? ZH[role].name : ROLES[role].name;
}

export function roleBlurb(role: RoleId, lang: Lang): string {
  return lang === 'zh' ? ZH[role].blurb : ROLES[role].blurb;
}

export function factionName(f: Faction, lang: Lang): string {
  if (lang === 'zh') return f === 'crew' ? '船员' : '暗流';
  return f === 'crew' ? 'crew' : 'Undertow';
}
