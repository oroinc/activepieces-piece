import type {
  JsonApiDocument,
  JsonApiResource,
  JsonApiResourceDocument,
  Linkage,
  FlatResource,
  DeserializeResult,
} from './types';

function buildIndex(included: JsonApiResource[]): Map<string, JsonApiResource> {
  const m = new Map<string, JsonApiResource>();
  for (const r of included) m.set(`${r.type}:${r.id}`, r);
  return m;
}

function resolveRef(
  ref: Linkage,
  index: Map<string, JsonApiResource>,
  visited: Set<string>,
): FlatResource {
  const key = `${ref.type}:${ref.id}`;
  if (visited.has(key)) return { _type: ref.type, id: ref.id };
  const resource = index.get(key);
  if (resource) return flattenResource(resource, index, new Set(visited));
  return { _type: ref.type, id: ref.id };
}

function flattenResource(
  r: JsonApiResource,
  index: Map<string, JsonApiResource>,
  visited: Set<string>,
): FlatResource {
  visited.add(`${r.type}:${r.id}`);
  const out: FlatResource = { ...r.attributes, _type: r.type, id: r.id };
  for (const [name, rel] of Object.entries(r.relationships ?? {})) {
    const lnk = rel.data;
    if (lnk === null || lnk === undefined) {
      out[name] = NULL_RELATIONSHIP;
      continue;
    }
    if (Array.isArray(lnk)) {
      out[name] =
        lnk.length === 0
          ? EMPTY_TO_MANY
          : lnk.map((ref) => resolveRef(ref, index, new Set(visited)));
      continue;
    }
    out[name] = resolveRef(lnk, index, new Set(visited));
  }
  return out;
}

export function deserialize(doc: JsonApiResourceDocument): FlatResource;
export function deserialize(doc: JsonApiDocument): DeserializeResult | JsonApiDocument;
export function deserialize(doc: JsonApiDocument): DeserializeResult | JsonApiDocument {
  if (!doc?.data) return doc;
  const index = buildIndex(doc.included ?? []);
  if (Array.isArray(doc.data)) {
    return doc.data.map((r) => flattenResource(r, index, new Set()));
  }
  return flattenResource(doc.data, index, new Set());
}

// Sentinels: the flat shape crosses flow steps as plain JSON, where a null/empty relationship would
// otherwise be indistinguishable from a null/empty attribute and serialize back as one.
export const NULL_RELATIONSHIP: FlatResource = Object.freeze({ _type: null, id: null });

export const EMPTY_TO_MANY: FlatResource = Object.freeze({ _emptyToMany: true });
