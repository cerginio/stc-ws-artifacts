// Completion for the authoring editor — 09-tour-authoring.md §10.2.
//
// The schema (§10.1) gives structural completion to any yaml-language-server; this gives the
// SEMANTIC half inside the workbench: command ids, targets, queries, events, and — the case
// JSON Schema cannot express at all — icon tokens, which live INSIDE a string value.
//
// Everything offered here comes from the generated registry. Nothing is hardcoded, so the
// completion list cannot drift from the application the way a hand-maintained list would.

/**
 * Contexts we can complete in, most specific first.
 *
 * Icon tokens are checked BEFORE the key-based contexts because they occur inside a `title:` or
 * `body:` value — a line whose key context would otherwise say "this is prose, offer nothing".
 */
const KEY_CONTEXTS = [
    { key: 'target', source: (r) => [...r.commandIds, ...r.manualTargets] },
    { key: 'id', source: (r) => [...r.commandIds, ...r.manualTargets], onlyUnder: 'target' },
    { key: 'command', source: (r) => [...r.commandIds, ...r.guideCommands] },
    { key: 'event', source: (r) => r.events },
    { key: 'state', source: (r) => r.queries },
    { key: 'kind', source: () => ['info', 'interaction', 'transition'] },
    { key: 'interactionMode', source: () => ['NONE', 'TARGET_ONLY', 'EDITOR_LOCKED'] },
    { key: 'advance', source: () => ['manual', 'automatic'] },
    { key: 'operator', source: () => ['truthy', 'falsy', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'] },
    { key: 'status', source: () => ['draft', 'published', 'deprecated'] },
    { key: 'fallback', source: () => ['skip-step', 'fail-tour'] },
    { key: 'onEnd', source: () => ['ask', 'keep'] },
    { key: 'content', source: () => ['user', 'demo'] },
    { key: 'autoStart', source: () => ['once', 'never'] },
    { key: 'restart', source: () => ['restart', 'resume', 'ask'] },
];

/**
 * An icon token being typed: `{icon:` or `{icon:cmd:` with an optional partial id, and NO
 * closing brace yet between the cursor and the opening one.
 */
const ICON_PREFIX_RX = /\{icon:(cmd:)?([a-z0-9_-]*)$/;

/**
 * What should be offered at `caret`, and what range an accepted item replaces.
 *
 * @returns {{items: Array<{id: string, doc?: string, insert?: string}>, range: {from: number, to: number}} | null}
 */
export function completionsFor(text, caret, registry, force = false) {
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const line = text.slice(lineStart, caret);

    // never complete inside a comment
    if (/(^|\s)#/.test(line)) return null;

    const icon = iconCompletion(line, lineStart, caret, registry);
    if (icon) return icon;

    const prop = propertyCompletion(text, line, lineStart, caret, registry, force);
    if (prop) return prop;

    return keyCompletion(text, line, lineStart, caret, registry, force);
}

/**
 * Icon tokens — the completion §10.2 singles out, and the one JSON Schema cannot provide
 * because the token sits inside a string.
 *
 * `{icon:cmd:` offers only commands whose icon RESOLVES: a command with neither `icon` nor
 * `iconProvider` renders nothing at runtime (10-content-icons.md §5 is silent by design), so
 * offering it would be offering a silent failure. `{icon:` offers sprite ids — the one source
 * that is not the command registry.
 */
function iconCompletion(line, lineStart, caret, registry) {
    const m = ICON_PREFIX_RX.exec(line);
    if (!m) return null;

    const [matched, isCmd, partial] = m;
    const from = lineStart + line.length - matched.length;
    const range = { from, to: caret };

    if (isCmd) {
        const docs = registry.commandDocs ?? {};
        const items = registry.iconCommandIds
            .filter((id) => id.startsWith(partial))
            .map((id) => ({ id, doc: docs[id] ?? '', insert: `{icon:cmd:${id}}` }));
        return { items: rank(items, partial), range };
    }

    // A bare `{icon:` could still become `{icon:cmd:…`, so offer that route first.
    const items = [];
    if ('cmd:'.startsWith(partial) || partial === '') {
        items.push({ id: 'cmd:…', doc: 'reference a command — survives an icon redraw', insert: '{icon:cmd:' });
    }
    items.push(...registry.sprites
        .filter((id) => id.startsWith(partial))
        .map((id) => ({ id, doc: 'sprite', insert: `{icon:${id}}` })));

    return { items, range };
}

/** `key: <partial>` — the ordinary structural case. */
function keyCompletion(text, line, lineStart, caret, registry, force) {
    const m = /(^|\s|-\s)([a-zA-Z]+):\s*("?)([a-zA-Z0-9_.\-]*)$/.exec(line);
    if (!m) return null;

    const [, , key, quote, partial] = m;
    if (!partial && !force) return null;   // don't pop up the instant a colon is typed

    const context = KEY_CONTEXTS.find((c) => c.key === key);
    if (!context) return null;

    // `id:` is ambiguous — a step id, or a target id inside `target:`. Only complete it when it
    // is indented under a `target:`/`targets:` block, otherwise every step id line would pop up
    // a list of 200 commands.
    if (context.onlyUnder && !isUnderKey(text, lineStart, context.onlyUnder)) return null;

    const docs = registry.commandDocs ?? {};
    const items = context.source(registry)
        .filter((id) => id.startsWith(partial))
        .map((id) => ({ id, doc: docs[id] ?? '' }));

    const from = caret - partial.length;
    return { items: rank(items, partial), range: { from, to: caret }, quote };
}

/** Is this line nested under `<key>:` (or `<key>s:` list item) above it? */
function isUnderKey(text, lineStart, key) {
    const before = text.slice(0, lineStart).split('\n').reverse();
    const myIndent = indentOf(text.slice(lineStart));
    for (const line of before) {
        if (!line.trim()) continue;
        const indent = indentOf(line);
        if (indent >= myIndent) continue;
        return new RegExp(`^\\s*-?\\s*${key}s?:`).test(line);
    }
    return false;
}

function indentOf(line) {
    return /^[ \t]*/.exec(line)[0].length;
}

/**
 * Exact prefix first, then shortest — so typing `editor_move` puts
 * `editor_move_mode_toggle` above `editor_move_mode_toggle_something_longer`, and a fully typed
 * id is always the first row rather than being buried under its own extensions.
 */
function rank(items, partial) {
    return items.sort((a, b) => {
        if (a.id === partial) return -1;
        if (b.id === partial) return 1;
        return a.id.length - b.id.length || a.id.localeCompare(b.id);
    });
}

/** Exported for tests: pick the row an accepted completion inserts. */
export function pick(items, index = 0) {
    const chosen = items[index];
    return chosen ? (chosen.insert ?? chosen.id) : null;
}


/**
 * PROPERTY NAMES, from the JSON Schema — the other half of §10.2.
 *
 * Until now only VALUES completed: keyCompletion requires `<key>:` to already be typed, so an
 * author had to know every property name by heart. The schema (§10.1) does describe them, but
 * it only helps an editor with a yaml-language-server attached; the workbench is a plain
 * textarea, so nothing was offering them here.
 *
 * Which set to offer is decided by INDENTATION, the only structure a line-based completer can
 * read without parsing the document: walk up to the nearest line indented less than this one
 * and see which block it opens. That is the same technique isUnderKey() already uses.
 */
function propertyCompletion(text, line, lineStart, caret, registry, force) {
    // a bare word being typed at the start of a line (optionally after a list dash), with no
    // colon yet — that is a property name in progress
    const m = /^(\s*)(-\s+)?([a-zA-Z][a-zA-Z0-9_]*)?$/.exec(line);
    if (!m) return null;

    const partial = m[3] ?? '';
    if (!partial && !force) return null;   // typing whitespace should not pop the list

    const schema = registry.schema;
    if (!schema) return null;              // older registry payload: offer nothing rather than guess

    const names = propertyNamesFor(text, lineStart, schema);
    if (!names.length) return null;

    const items = names
        .filter((id) => id.startsWith(partial))
        .map((id) => ({ id, doc: schemaDoc(schema, id), insert: id + ':' }));
    if (!items.length) return null;

    return { items: rank(items, partial), range: { from: caret - partial.length, to: caret } };
}

/**
 * Which properties are legal at this line, resolved by WALKING THE SCHEMA down the block path
 * the indentation describes.
 *
 * The first version special-cased three blocks and fell back to "step properties" for
 * everything else, which was wrong wherever the author actually was. Measured: under `launch:`,
 * `session:`, `targets:` and `navigation:` it offered `advance` — a step key — because those
 * blocks were not among the three it knew.
 *
 * Now nothing is hardcoded. Read the enclosing keys by indentation, then follow them through
 * the schema, stepping through $ref and array `items` on the way. The schema already describes
 * every one of these blocks, so the completion cannot drift from the format.
 */
function propertyNamesFor(text, lineStart, schema) {
    const path = enclosingKeys(text, lineStart);
    let node = schema;
    for (const key of path) {
        node = deref(schema, node);
        // a list item's keys are the keys of the item TYPE, not of the array
        if (node?.type === 'array') node = deref(schema, node.items);
        node = deref(schema, node?.properties?.[key]);
        if (!node) return [];
    }
    node = deref(schema, node);
    if (node?.type === 'array') node = deref(schema, node.items);
    return Object.keys(node?.properties ?? {});
}

/**
 * The chain of keys enclosing this line, outermost first.
 *
 * A `- key: value` line is a LIST ITEM, and its key does not open a block: the lines under it
 * are that key's SIBLINGS inside the item, not its children. Measured — treating `- id: s` as
 * an enclosing key produced the path [steps, id] for a step's own properties, which resolves
 * to nothing. The dash contributes the item, the key on it does not.
 */
function enclosingKeys(text, lineStart) {
    const before = text.slice(0, lineStart).split('\n').reverse();
    let indent = indentOf(text.slice(lineStart));
    const keys = [];
    for (const l of before) {
        if (!l.trim() || /^\s*#/.test(l)) continue;
        const li = indentOf(l);
        if (li >= indent) continue;
        const m = /^\s*(-\s+)?([a-zA-Z][a-zA-Z0-9_]*):/.exec(l);
        // m[1] is the dash: a list item, whose key is a sibling of what follows, not a parent
        if (m && !m[1]) keys.push(m[2]);
        indent = li;
        if (indent === 0) break;
    }
    return keys.reverse();
}

/** Follow a $ref, and collapse the single-branch composites the schema uses. */
function deref(schema, node) {
    let n = node;
    for (let i = 0; i < 8 && n; i++) {
        if (n.$ref) {
            const parts = String(n.$ref).replace(/^#\//, '').split('/');
            n = parts.reduce((acc, k) => acc?.[k], schema);
            continue;
        }
        // `allOf` is how the step definition adds its conditional halves, and `oneOf` is how a
        // target is spelled either as a bare id string or as an object. In both cases the keys
        // an author can type live on the branch that HAS properties — the string branch of a
        // target has none, and offering nothing there was the bug.
        const branches = n.allOf || n.oneOf || n.anyOf;
        if (!n.properties && Array.isArray(branches)) {
            n = branches.find((b) => b.properties || b.$ref);
            continue;
        }
        break;
    }
    return n;
}

/** The schema's own one-line description, so the popup explains rather than just lists. */
function schemaDoc(schema, name) {
    for (const block of [schema.$defs?.step, schema.$defs?.condition, schema]) {
        const d = block?.properties?.[name]?.description;
        if (d) return String(d).split('\n')[0];
    }
    return '';
}
