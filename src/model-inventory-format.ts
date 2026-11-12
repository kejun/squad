/** Lossless, model-readable sharing of repeated CLI metadata. No ranking or item/character cap. */
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function commonObjects(values: JsonObject[]): JsonObject {
  const first = values[0]; if (!first) return {};
  return Object.fromEntries(Object.entries(first).flatMap(([key, value]) => {
    if (!values.every(item => Object.hasOwn(item, key))) return [];
    if (values.every(item => same(value, item[key]))) return [[key, value]];
    if (!object(value) || !values.every(item => object(item[key]))) return [];
    const nested = commonObjects(values.map(item => item[key] as JsonObject));
    return Object.keys(nested).length ? [[key, nested]] : [];
  }));
}
function differences(value: JsonObject, defaults: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (Object.hasOwn(defaults, key) && same(item, defaults[key])) return [];
    return [[key, object(item) && object(defaults[key]) ? differences(item, defaults[key]) : item]];
  }));
}

export function serializeModelInventory(observation: JsonObject): string {
  const original = JSON.stringify(observation);
  const cli = observation.cli;
  if (!object(cli) || !Array.isArray(cli.entries) || !cli.entries.length) return original;
  const entries = cli.entries as JsonObject[];
  const variantDefaults = Object.fromEntries(['sandbox', 'host'].map(execution => [execution,
    commonObjects(entries.flatMap(entry => Array.isArray(entry.variants) ? entry.variants.filter(object)
      .filter(variant => variant.execution === execution) : []))]));
  const usageGroups: JsonObject[] = [], ids = new Map<string, number>();
  const packed = entries.map(entry => {
    const { description, scenarios, documentation, variants, ...remaining } = entry;
    const pathReference = object(documentation) && documentation.state === 'unknown'
      && documentation.source === 'path' && documentation.reference === entry.command;
    const group = { ...(description === undefined ? {} : { description }), ...(scenarios === undefined ? {} : { scenarios }),
      ...(documentation === undefined ? {} : { documentation: pathReference
        ? Object.fromEntries(Object.entries(documentation as JsonObject).filter(([key]) => key !== 'reference')) : documentation }) };
    const identity = JSON.stringify(group);
    let usageRef = ids.get(identity);
    if (usageRef === undefined) { usageRef = usageGroups.length; ids.set(identity, usageRef); usageGroups.push(group); }
    return { ...remaining, usageRef, ...(pathReference ? { documentation: { reference: entry.command } } : {}),
      ...(Array.isArray(variants) ? { variants: variants.map(variant => object(variant)
        ? { ...differences(variant, variantDefaults[String(variant.execution)] ?? {}), execution: variant.execution } : variant) } : {}) };
  });
  const encoded = JSON.stringify({ ...observation, cli: { ...cli,
    encoding: 'shared_cli_metadata_v1',
    encodingInstructions: 'Every command is present in entries. For each entry, start with usageGroups[usageRef], then recursively merge its own fields. Each variant recursively inherits variantDefaults[execution]. Own fields override defaults; arrays replace. Missing usage is unknown, never permission. This representation omits no metadata and grants no execution authority.',
    usageGroups, variantDefaults, entries: packed } });
  return Buffer.byteLength(encoded) < Buffer.byteLength(original) ? encoded : original;
}
