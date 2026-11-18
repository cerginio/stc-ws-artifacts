// YAML highlighting for the workbench editor — coloured by ROLE, not by YAML type.
//
// A plain YAML highlighter tells you `title` and `target` are both "keys". That is true and
// useless: one is copy the user will read, the other is a reference into the command registry
// that can be WRONG. Colour carries the distinction the author actually needs.
//
// Roles (see ROLE_KEYS): identity · copy · binding · flow · layout. `binding` is the one with
// teeth — its values are checked against the live registry as you type, so a bad id looks wrong
// before the compiler says so.
//
// Deliberately small: this highlights the authoring subset, not all of YAML. The authored files
// follow one shape (block mappings, block scalars, flow sequences of simple scalars), so a
// line-oriented tokenizer covers them and stays auditable.
//
// Every value token is wrapped in its own span carrying `data-tok` / `data-kind`, which is what
// makes hover documentation possible without a second parse.

const ICON_TOKEN_RX = /\{icon:(?:cmd:)?[a-z0-9_-]+\}/g;

/**
 * Key → role. Anything unlisted falls back to `identity`, the quietest role: an unknown key is
 * almost always metadata, and mis-colouring it loudly would be worse than under-selling it.
 */
const ROLE_KEYS = {
    identity: ['format', 'id', 'slug', 'version', 'status', 'category',
        'estimatedMinutes', 'kind', 'index', 'value', 'timeoutMs', 'delayMs'],
    copy: ['title', 'body', 'description', 'alt', 'media'],
    binding: ['target', 'targets', 'command', 'commands', 'event', 'state', 'query', 'match',
        'args', 'icon'],
    flow: ['complete', 'waitFor', 'advance', 'fallback', 'goto', 'routing', 'branches', 'when',
        'onFailure', 'enter', 'exit', 'setup', 'teardown', 'onComplete', 'onClose', 'onSkip',
        'steps', 'operator', 'await', 'navigation', 'launch', 'session', 'requirements',
        'defaults', 'restart', 'autoStart', 'resume', 'sources', 'onEnd', 'content'],
    layout: ['poi', 'poiOverrides', 'panel', 'panelPlacement', 'padding', 'placement',
        'preferred', 'interactionMode', 'role', 'targetPadding', 'minViewport', 'minLevel',
        'width', 'required'],
};

const KEY_ROLE = new Map();
for (const [role, keys] of Object.entries(ROLE_KEYS)) {
    for (const k of keys) KEY_ROLE.set(k, role);
}

/**
 * Which keys carry a value that must exist in the registry, and in which list.
 *
 * This is what turns colour into validation: `target: no_such_thing` renders as unresolved
 * while it is being typed, rather than becoming a compiler error a few keystrokes later.
 */
const VALUE_KIND = {
    target: 'target', id: 'target',          // `id:` under target: — resolved contextually
    command: 'command',
    event: 'event',
    state: 'query', query: 'query',
};

function esc(s) {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function markIcons(escaped) {
    return escaped.replace(ICON_TOKEN_RX, (t) => `<span class="tk-icon" data-tok="${t}" data-kind="icon">${t}</span>`);
}

/**
 * Does this value resolve against the live registry?
 *
 * `registry` is optional: without it every binding renders as merely "a binding", which is the
 * correct degradation for the unit tests and for the moment before the registry has loaded.
 */
function resolveKind(kind, value, registry) {
    if (!registry) return null;
    const lists = {
        target: [...(registry.commandIds || []), ...(registry.manualTargets || [])],
        command: [...(registry.commandIds || []), ...(registry.guideCommands || [])],
        event: registry.events || [],
        query: registry.queries || [],
    };
    const list = lists[kind];
    if (!list) return null;
    return list.includes(value) ? 'ok' : 'unresolved';
}

function valueHtml(value, key, registry, inTargetBlock) {
    const trimmed = value.trim();
    if (!trimmed) return esc(value);

    // quoted string — copy, and the usual home of icon tokens
    if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed) || /^'(?:[^']|'')*'$/.test(trimmed)) {
        return `<span class="tk-str">${markIcons(esc(value))}</span>`;
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return `<span class="tk-num">${esc(value)}</span>`;
    if (/^(true|false|null|~)$/.test(trimmed)) return `<span class="tk-bool">${esc(value)}</span>`;
    if (/^[|>][-+]?$/.test(trimmed)) return `<span class="tk-block">${esc(value)}</span>`;

    // A semantic value: mark it individually so it can be validated and hovered.
    // `id:` is only a target id INSIDE a target block — elsewhere it is a step id, and colouring
    // every step id as an unresolved command would be constant false alarm.
    const kind = key === 'id' && !inTargetBlock ? null : VALUE_KIND[key];
    if (kind && /^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(trimmed)) {
        const status = resolveKind(kind, trimmed, registry);
        const lead = value.slice(0, value.indexOf(trimmed));
        const tail = value.slice(value.indexOf(trimmed) + trimmed.length);
        return `${esc(lead)}<span class="tk-val" data-kind="${kind}" data-tok="${esc(trimmed)}"`
            + `${status ? ` data-status="${status}"` : ''}>${esc(trimmed)}</span>${esc(tail)}`;
    }

    // flow sequence of simple scalars: [a, b, c] — POI zones are the common case
    if (/^\[.*\]$/.test(trimmed)) {
        return `<span class="tk-seq">${esc(value)}</span>`;
    }

    return markIcons(esc(value));
}

/**
 * Highlight a YAML document.
 *
 * @param {string} source
 * @param {object} [registry] the semantic registry, so binding values can be validated inline
 */
export function highlight(source, registry = null) {
    const out = [];
    let blockIndent = null;    // indentation that block-scalar content must exceed
    let targetIndent = null;   // indentation of an open `target:`/`targets:` block

    for (const line of source.split('\n')) {
        const indent = /^[ \t]*/.exec(line)[0].length;

        if (blockIndent !== null) {
            if (line.trim() === '' || indent > blockIndent) {
                out.push(`<span class="tk-str">${markIcons(esc(line))}</span>`);
                continue;
            }
            blockIndent = null;
        }
        if (targetIndent !== null && line.trim() && indent <= targetIndent) targetIndent = null;

        const commentAt = commentIndex(line);
        if (commentAt === 0 || (commentAt > 0 && !line.slice(0, commentAt).trim())) {
            out.push(`<span class="tk-comment">${esc(line)}</span>`);
            continue;
        }

        const code = commentAt === -1 ? line : line.slice(0, commentAt);
        const comment = commentAt === -1 ? '' : `<span class="tk-comment">${esc(line.slice(commentAt))}</span>`;

        out.push(codeHtml(code, indent, registry, targetIndent !== null, {
            openBlock: (i) => { blockIndent = i; },
            openTarget: (i) => { targetIndent = i; },
        }) + comment);
    }

    return out.join('\n');
}

function codeHtml(code, indent, registry, inTargetBlock, hooks) {
    const dash = /^(\s*)(-\s+)/.exec(code);
    let prefix = '';
    let rest = code;
    if (dash) {
        prefix = `${dash[1]}<span class="tk-dash">${dash[2].trimEnd()}</span> `;
        rest = code.slice(dash[0].length);
    }

    // The leading whitespace must be captured, not required-absent: without a `- ` dash, `rest`
    // is still the whole indented line, so anchoring the key at position 0 matched ONLY
    // top-level keys. Every nested key — target, complete, poi, event, body — silently fell
    // through to plain text, which is most of the file and the whole point of role colouring.
    const kv = /^(\s*)([A-Za-z_][\w.-]*)(\s*:\s*)(.*)$/.exec(rest);
    if (!kv) return prefix + valueHtml(rest, null, registry, inTargetBlock);

    const [, lead, key, colon, value] = kv;
    prefix += lead;
    if (/^[|>][-+]?\s*$/.test(value.trim())) hooks.openBlock(indent);
    if ((key === 'target' || key === 'targets') && !value.trim()) hooks.openTarget(indent);

    const role = KEY_ROLE.get(key) ?? 'identity';
    return `${prefix}<span class="tk-key" data-role="${role}" data-tok="${esc(key)}" data-kind="key">${esc(key)}</span>`
        + `${esc(colon)}${valueHtml(value, key, registry, inTargetBlock)}`;
}

/**
 * Index of a `#` that actually starts a comment.
 *
 * A `#` inside a quoted string is not one, and a body line legitimately contains one ("step #2");
 * colouring the rest of that sentence as a comment is the kind of small wrongness that makes a
 * highlighter feel broken. YAML requires whitespace before an inline comment — that is the rule.
 */
function commentIndex(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return i;
    }
    return -1;
}
