import type { FlatResource, JsonApiResource, Linkage, SerializeOptions, SerializeResult } from './types';

export function serialize(options: SerializeOptions): SerializeResult {
  const { type, id, data: flat, relationships: explicitRels = {}, included } = options;

  const {
    attributes: detectedAttrs,
    relationships: detectedRels,
    hoisted,
  } = splitFlat({ flat });

  const explicitRelNames = new Set(Object.keys(explicitRels));

  const attributes = Object.fromEntries(
    Object.entries(detectedAttrs).filter(([name]) => !explicitRelNames.has(name))
  );

  const mergedRels: Record<string, RelationshipBlock> = {
    ...detectedRels,
    ...Object.fromEntries(
      Object.entries(explicitRels).map(([name, linkage]) => [name, { data: linkage }])
    ),
  };

  const idFromFlat =
    flat['id'] != null && String(flat['id']).trim() !== ''
      ? String(flat['id']).trim()
      : undefined;
  const resolvedId = (id && id.trim() !== '' ? id.trim() : undefined) ?? idFromFlat;

  const dataBlock: Record<string, unknown> = {
    type,
    ...(resolvedId ? { id: resolvedId } : {}),
    attributes,
    ...(Object.keys(mergedRels).length > 0 ? { relationships: mergedRels } : {}),
  };

  const result: SerializeResult = { data: dataBlock };

  const explicitIncluded = included ?? [];
  const explicitKeys = new Set(explicitIncluded.map((r) => `${r.type}::${r.id}`));
  const mergedIncluded = [
    ...hoisted.filter((r) => !explicitKeys.has(`${r.type}::${r.id}`)),
    ...explicitIncluded,
  ];
  if (mergedIncluded.length > 0) result.included = mergedIncluded;

  return result;
}

function hasTypeMarker(value: unknown): value is MarkedResource {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '_type' in value &&
    typeof value['_type'] === 'string'
  );
}

function isNullRelationship(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '_type' in value &&
    value['_type'] === null
  );
}

function isEmptyToMany(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '_emptyToMany' in value &&
    value['_emptyToMany'] === true
  );
}

function isRawLinkage(value: unknown): value is RawLinkage {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'type' in value &&
    typeof value['type'] === 'string' &&
    'id' in value &&
    value['id'] != null
  );
}

function isLinkageLike(value: unknown): value is MarkedResource | RawLinkage {
  return hasTypeMarker(value) || isRawLinkage(value);
}

function isFullResource(resource: MarkedResource): boolean {
  return Object.keys(resource).some((k) => k !== '_type' && k !== 'id');
}

function toLinkage(resource: MarkedResource): Linkage {
  return { type: resource['_type'], id: String(resource['id'] ?? '') };
}

function linkOrHoist({
  value,
  collected,
}: {
  value: MarkedResource | RawLinkage;
  collected: Map<string, JsonApiResource>;
}): Linkage {
  if (hasTypeMarker(value)) {
    return isFullResource(value) ? hoistResource({ resource: value, collected }) : toLinkage(value);
  }
  return { type: value.type, id: String(value.id) };
}

function hoistResource({
  resource,
  collected,
}: {
  resource: MarkedResource;
  collected: Map<string, JsonApiResource>;
}): Linkage {
  const linkage = toLinkage(resource);
  const key = `${linkage.type}::${linkage.id}`;

  if (!collected.has(key)) {
    const hoisted: JsonApiResource = { type: linkage.type, id: linkage.id };
    collected.set(key, hoisted);

    const { attributes, relationships } = splitEntries({ flat: resource, collected });
    if (Object.keys(attributes).length > 0) hoisted.attributes = attributes;
    if (Object.keys(relationships).length > 0) hoisted.relationships = relationships;
  }

  return linkage;
}

function toManyBlock({
  name,
  items,
  collected,
}: {
  name: string;
  items: unknown[];
  collected: Map<string, JsonApiResource>;
}): RelationshipBlock | undefined {
  const linkageLike = items.filter(isLinkageLike);
  if (linkageLike.length === 0) return undefined;

  if (linkageLike.length !== items.length) {
    const index = items.findIndex((item) => !isLinkageLike(item));
    throw new Error(
      `Property "${name}" mixes relationship linkages with plain values (offending element at index ${index}). ` +
        'A to-many relationship must contain only linkage objects — either {"type":"…","id":"…"} ' +
        'or values carrying a _type marker. Move plain values to a separate attribute.'
    );
  }

  return { data: linkageLike.map((value) => linkOrHoist({ value, collected })) };
}

function splitEntries({
  flat,
  collected,
}: {
  flat: FlatResource;
  collected: Map<string, JsonApiResource>;
}): { attributes: FlatResource; relationships: Record<string, RelationshipBlock> } {
  const attributes: FlatResource = {};
  const relationships: Record<string, RelationshipBlock> = {};

  for (const [key, value] of Object.entries(flat)) {
    if (key === '_type' || key === 'id') continue;

    if (isNullRelationship(value)) {
      relationships[key] = { data: null };
    } else if (isEmptyToMany(value)) {
      relationships[key] = { data: [] };
    } else if (Array.isArray(value)) {
      const block = toManyBlock({ name: key, items: value, collected });
      if (block) {
        relationships[key] = block;
      } else {
        attributes[key] = value;
      }
    } else if (isLinkageLike(value)) {
      relationships[key] = { data: linkOrHoist({ value, collected }) };
    } else {
      attributes[key] = value;
    }
  }

  return { attributes, relationships };
}

function splitFlat({ flat }: { flat: FlatResource }): {
  attributes: FlatResource;
  relationships: Record<string, RelationshipBlock>;
  hoisted: JsonApiResource[];
} {
  const collected = new Map<string, JsonApiResource>();
  const { attributes, relationships } = splitEntries({ flat, collected });
  return { attributes, relationships, hoisted: Array.from(collected.values()) };
}

type MarkedResource = FlatResource & { _type: string };

type RawLinkage = { type: string; id: unknown };

type RelationshipBlock = { data: Linkage | Linkage[] | null };
