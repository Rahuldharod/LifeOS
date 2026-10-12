/**
 * Skill pack versions (ADR 0020). Every Inbox Draft and Patch Draft says which skill pack wrote it, so LifeOS can
 * tell the user when their installed Claude skills lag behind the app. Adoption accepts the current pack and the
 * one before it; a draft without `skill_pack` was written before versioning and counts as pack 0.
 */

export const currentSkillPack = 1;
export const oldestAcceptedSkillPack = currentSkillPack - 1;

/** The draft's skill pack, or why it cannot be adopted. */
export function readSkillPack(value: unknown): { skillPack: number; issue?: string } {
  if (value === undefined) return { skillPack: 0, ...(oldestAcceptedSkillPack > 0 ? { issue: outdated(0) } : {}) };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return { skillPack: 0, issue: `skill_pack: must be a whole number, e.g. skill_pack: ${currentSkillPack}` };
  if (value > currentSkillPack) return { skillPack: value, issue: `skill_pack: ${value} is newer than this LifeOS (it reads up to ${currentSkillPack}); update LifeOS` };
  if (value < oldestAcceptedSkillPack) return { skillPack: value, issue: outdated(value) };
  return { skillPack: value };
}

/** The line a result adds when the draft was adopted but its skills are one pack behind. */
export function outdatedSkillPackNote(skillPack: number) {
  return skillPack < currentSkillPack ? `Your LifeOS skills are out of date (skill pack ${skillPack}; this LifeOS expects ${currentSkillPack}). Reinstall them from LifeOS Settings → Claude skills.` : undefined;
}

const outdated = (skillPack: number) => `skill_pack: ${skillPack} is too old for this LifeOS (it reads ${oldestAcceptedSkillPack} to ${currentSkillPack}); reinstall your LifeOS skills from Settings → Claude skills`;
