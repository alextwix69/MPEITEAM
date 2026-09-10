export const MODERATION_VIOLATION_CODES = [
  'terrorism',
  'extremism',
  'hate_or_hostility',
  'prohibited_symbols',
  'child_sexual_exploitation',
  'pornography',
  'pedophilia_propaganda',
  'prohibited_sexuality_propaganda',
  'illegal_drugs',
  'suicide_encouragement',
  'dangerous_minor_involvement',
  'explosives_or_illegal_weapons',
  'mass_disorder_calls',
  'territorial_integrity_calls',
  'dangerous_disinformation',
  'prohibited_state_or_military_materials',
  'enemy_financing',
  'sanctions_calls',
  'undesirable_organization_materials',
  'blocking_bypass',
  'illegal_gambling',
  'illegal_alcohol_sales',
  'illegal_tobacco_sales',
  'illegal_medicine_sales',
  'personal_data_or_private_life',
  'minor_victim_identity',
  'defamation',
  'threats_or_illegal_violence',
  'illegal_shock_content',
  'protected_secret',
  'malware',
  'copyright_violation',
  'obscene_disrespect',
  'profanity',
  'other_illegal_content',
] as const;

const knownCodes = new Set<string>(MODERATION_VIOLATION_CODES);

export function normalizeViolationCodes(codes: string[]): string[] {
  const normalized = codes.map((code) => (knownCodes.has(code) ? code : 'other_illegal_content'));
  return [...new Set(normalized)].sort();
}
