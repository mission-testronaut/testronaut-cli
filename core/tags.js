export const TAG_PATTERN = /^[a-z0-9_-]+$/;
export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_MISSION = 50;
export const UNTAGGED_FILTER = 'untagged';

export function normalizeTag(value) {
  const tag = String(value ?? '').trim().toLowerCase();
  if (!tag) throw new Error('Tags cannot be empty.');
  if (tag.length > MAX_TAG_LENGTH) {
    throw new Error(`Tag "${tag}" exceeds the ${MAX_TAG_LENGTH}-character limit.`);
  }
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid tag "${tag}". Use only letters, numbers, hyphens, and underscores.`);
  }
  return tag;
}

export function normalizeTags(values, { allowUntagged = false } = {}) {
  const input = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? (values.trim() ? values.split(',') : [])
      : values == null
        ? []
        : [values];
  const tags = [...new Set(input.map(normalizeTag))].sort();
  if (!allowUntagged && tags.includes(UNTAGGED_FILTER)) {
    throw new Error(`"${UNTAGGED_FILTER}" is reserved for filtering and cannot be saved as a tag.`);
  }
  if (tags.length > MAX_TAGS_PER_MISSION) {
    throw new Error(`A mission can have at most ${MAX_TAGS_PER_MISSION} tags.`);
  }
  return tags;
}

export function matchesTagFilter(missionTags, requestedTags, match = 'any') {
  const actual = normalizeTags(missionTags);
  const requested = normalizeTags(requestedTags, { allowUntagged: true });
  if (!requested.length) return true;
  const has = (tag) => tag === UNTAGGED_FILTER ? actual.length === 0 : actual.includes(tag);
  return match === 'all' ? requested.every(has) : requested.some(has);
}

export function normalizeTagMatch(value) {
  const match = String(value ?? 'any').trim().toLowerCase();
  if (match !== 'any' && match !== 'all') {
    throw new Error('tagMatch must be "any" or "all".');
  }
  return match;
}
