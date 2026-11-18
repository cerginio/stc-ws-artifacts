// Tour compilation core — 09-tour-authoring.md §9, shared by the CLI and the workbench.
//
// PURE: no filesystem, no Node builtins beyond the `yaml` parser. That is what lets
// §11.1 hold — "the workbench is layered on the same YAML model, compiler and schema ...
// it does not invent another saved format". A second implementation in the browser would
// be exactly that second format, drifting one diagnostic at a time.
//
// scripts/guide-compile.mjs adds the filesystem: reading sources, merging artifacts,
// --check/--watch. guide/editor/workbench.js adds the UI. Neither re-implements any rule here.

// NAMED imports, not a default one. The yaml package's browser build (vendor/yaml) exports only
// named bindings — it has no `export default` at all — so `import YAML from 'yaml'` resolved
// under Node's CJS interop and threw in the browser:
//   "The requested module 'yaml' does not provide an export named 'default'"
// which killed the whole module graph: no editor content, no tour list, nothing.
// Named imports are the form that works in both.
import { parse as yamlParse, parseDocument, visit as yamlVisit } from 'yaml';

/** Kept identical to GUIDE_ICON_RX in guide/runtime.js (10-content-icons.md §3). */
const ICON_TOKEN_RX = /\{icon:(cmd:)?([a-z0-9_-]+)\}/g;

/* ── diagnostics ─────────────────────────────────────────────────────────────────────────── */

/**
 * §9.3: a diagnostic names a file, a line and a cause. `steps[2].completion.event: unknown` is
 * a path into a structure the author never typed; they typed YAML, and that is where the
 * message has to point.
 */
export class Diagnostics {
    constructor(file) { this.file = file; this.items = []; }

    add(level, message, node) {
        this.items.push({ level, message, line: node?.line ?? null, col: node?.col ?? null });
    }

    error(message, node) { this.add('error', message, node); }
    warn(message, node) { this.add('warn', message, node); }

    get errors() { return this.items.filter((i) => i.level === 'error'); }
    get warnings() { return this.items.filter((i) => i.level === 'warn'); }

    format() {
        return this.items.map((i) => {
            const where = i.line ? `${this.file}:${i.line}:${i.col}` : this.file;
            return `${where}\n  ${i.level === 'error' ? 'error' : 'warning'}: ${i.message}`;
        }).join('\n');
    }
}

/**
 * Map a YAML node back to a line/col so diagnostics can point at source (§9.3). The `yaml`
 * package gives byte ranges; converting once per document keeps this O(n) rather than
 * re-scanning for every diagnostic.
 */
function makeLocator(source, doc) {
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);

    return (path) => {
        let node = doc.contents;
        for (const key of path) {
            if (!node) return null;
            node = typeof key === 'number'
                ? node.items?.[key]
                : node.items?.find((it) => it.key?.value === key)?.value;
        }
        const offset = node?.range?.[0];
        if (offset === undefined) return null;
        let line = 0;
        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++;
        return { line: line + 1, col: offset - lineStarts[line] + 1 };
    };
}

/* ── parsing ─────────────────────────────────────────────────────────────────────────────── */

/**
 * §3: "The compiler uses a safe YAML parser. Custom executable tags are forbidden."
 *
 * `yaml` does not evaluate tags the way js-yaml's unsafe schema does, but a document can still
 * carry unknown tags and anchors/aliases that expand exponentially. Rejecting unknown tags
 * outright keeps the authored surface exactly what the schema describes.
 */
function parseAuthoringYaml(source, file, diag) {
    const doc = parseDocument(source, { keepSourceTokens: true, merge: false });

    for (const err of doc.errors) {
        diag.error(err.message, { line: err.linePos?.[0]?.line, col: err.linePos?.[0]?.col });
    }
    if (doc.errors.length) return { doc, value: null };

    yamlVisit(doc, {
        Scalar(_key, node) { if (node.tag && !node.tag.startsWith('tag:yaml.org')) throw new Error(`unsupported YAML tag "${node.tag}"`); },
        Map(_key, node) { if (node.tag && !node.tag.startsWith('tag:yaml.org')) throw new Error(`unsupported YAML tag "${node.tag}"`); },
    });

    return { doc, value: doc.toJS() };
}

/* ── the icon-token quoting trap — 09 §8.1.1 ─────────────────────────────────────────────── */

/**
 * `title: {icon:cmd:x}` is VALID YAML that parses to a single-key mapping, so without this it
 * surfaces as "expected string, got object" — a type error the author cannot act on. Measured
 * against the `yaml` package; `title: {icon:cmd:x} Move mode` fails at parse time instead, and
 * block scalars (`body: |`) are immune.
 *
 * This is the one diagnostic that has to guess intent, and it is worth it: a leading icon is
 * most idiomatic exactly in titles, which is where the trap lives.
 */
function checkIconQuoting(value, path, diag, locate) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (keys.length !== 1) return false;
    // The parsed key KEEPS the `icon:` prefix — `{icon:cmd:x}` becomes the single key
    // "icon:cmd:x", not "cmd:x". Matching without it silently failed this check, and the step
    // then reported "`title` is required", which is exactly the unactionable message this
    // function exists to replace.
    if (!/^icon:(cmd:)?[a-z0-9_-]+$/.test(keys[0]) || value[keys[0]] !== null) return false;

    diag.error(
        `an icon token at the start of a value must be quoted — write: "{${keys[0]}} ..."`,
        locate(path),
    );
    return true;
}

/* ── compilation ─────────────────────────────────────────────────────────────────────────── */

const ZONES = new Set([
    'top-left', 'top-center', 'top-right',
    'middle-left', 'middle-center', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right',
]);

/** §7 expansion order: explicit step value → tour default → runtime-schema default. */
function pick(stepValue, tourDefault, schemaDefault) {
    if (stepValue !== undefined) return stepValue;
    if (tourDefault !== undefined) return tourDefault;
    return schemaDefault;
}

/** §6.3 — one string target, or an object, or `targets`. `target`/`targets` are exclusive. */
function compileTargets(step, defaults, path, diag, locate) {
    if (step.target !== undefined && step.targets !== undefined) {
        diag.error('`target` and `targets` are mutually exclusive', locate(path));
        return [];
    }
    // Numbers must BE numbers. YAML happily parses `targetPadding: 8tt` as the STRING "8tt",
    // which flowed all the way into the runtime JSON and would have reached the host's geometry
    // maths as a string — found because the structure graph rendered "pad 8tt" and the value
    // turned out to be real, not a rendering bug. The schema declares these as numbers; the
    // compiler has to enforce it, because nothing downstream re-checks.
    const numeric = (value, where) => {
        if (value === undefined) return undefined;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        diag.error(`${where} must be a number, got ${JSON.stringify(value)}`, locate(path));
        return undefined;
    };

    const padding = numeric(defaults.targetPadding, 'defaults.targetPadding') ?? 8;
    const one = (t, role = 'primary') => {
        if (typeof t === 'string') return { id: t, role, padding };
        const out = { id: t.id, role: t.role ?? role };
        if (t.args !== undefined) out.args = t.args;
        out.padding = numeric(t.padding, `target "${t.id}" padding`) ?? padding;
        if (t.required !== undefined) out.required = t.required;
        if (t.allowDisabled !== undefined) out.allowDisabled = t.allowDisabled;
        return out;
    };

    if (step.target !== undefined) return [one(step.target)];
    if (Array.isArray(step.targets)) return step.targets.map((t, i) => one(t, i === 0 ? 'primary' : 'allowed'));
    return [];
}

/** §6.4 — `event:`/`state:` shorthand into the runtime Condition union. */
function compileCondition(rule, path, diag, locate) {
    if (!rule) return null;
    if (rule.event) {
        const out = { type: 'event', event: rule.event };
        if (rule.match) out.match = rule.match;
        if (rule.origin) out.origin = rule.origin;
        return out;
    }
    if (rule.state) {
        const out = { type: 'state', query: rule.state, operator: rule.operator ?? 'truthy' };
        if (rule.args) out.args = rule.args;
        if (rule.value !== undefined) out.value = rule.value;
        return out;
    }
    // structural forms stay explicit — §6.4 declines to give all/any/not magic shorthand
    if (rule.all) return { type: 'all', conditions: rule.all.map((c) => compileCondition(c, path, diag, locate)) };
    if (rule.any) return { type: 'any', conditions: rule.any.map((c) => compileCondition(c, path, diag, locate)) };
    if (rule.not) return { type: 'not', condition: compileCondition(rule.not, path, diag, locate) };

    diag.error('a condition must declare one of: event, state, all, any, not', locate(path));
    return null;
}

function compileActions(actions) {
    return (actions || []).map((a) => {
        const out = { command: a.command };
        if (a.args !== undefined) out.args = a.args;
        if (a.when !== undefined) out.when = compileCondition(a.when, [], { error() {} }, () => null);
        if (a.await !== undefined) out.await = a.await;
        if (a.onFailure !== undefined) {
            out.onFailure = typeof a.onFailure === 'string' ? { type: a.onFailure } : a.onFailure;
        }
        return out;
    });
}

/**
 * `show-info` carries COPY, so it needs generated content keys like any other authored text —
 * the author writes sentences, the runtime gets ContentRefs.
 *
 * Keys derive from the step id (§8.1), so they survive reordering and copy edits:
 *   tour.<tour-id>.step.<step-id>.fallback.title / .body
 */
function compileFallback(f, { tourId, stepId, content } = {}) {
    if (f === undefined) return undefined;
    if (typeof f === 'string') return { type: f };
    if (f.type !== 'show-info' || !f.content) return f;

    const keys = {
        title: `tour.${tourId}.step.${stepId}.fallback.title`,
        body: `tour.${tourId}.step.${stepId}.fallback.body`,
    };
    if (typeof f.content.title === 'string') content[keys.title] = f.content.title;
    if (typeof f.content.body === 'string') content[keys.body] = f.content.body.trimEnd();

    return { type: 'show-info', content: keys };
}

/**
 * §8.1: keys derive from stable ids, so reordering steps does not change a key and copy edits
 * do not require a version bump.
 */
export function contentKeys(tourId, stepId) {
    return {
        title: `tour.${tourId}.step.${stepId}.title`,
        body: `tour.${tourId}.step.${stepId}.body`,
    };
}

export function compileTour(source, file, registry) {
    const diag = new Diagnostics(file);
    const { doc, value: src } = parseAuthoringYaml(source, file, diag);
    if (!src) return { diag, tour: null, content: null, entry: null };

    const locate = makeLocator(source, doc);
    const content = {};   // generated locale bundle for the default locale

    if (src.format !== 'storytilecraft-tour/1') {
        diag.error(`format must be "storytilecraft-tour/1" (got ${JSON.stringify(src.format)})`, locate(['format']));
    }
    for (const field of ['id', 'slug', 'version']) {
        if (src[field] === undefined) diag.error(`\`${field}\` is required`, locate([field]));
    }

    /**
     * An unrecognised top-level key is an error, not something to ignore.
     *
     * `defaultLocale` lived in the schema and in all ten authored tours for months while the
     * compiler read it nowhere: the base bundle is always `en` (guide-compile.mjs builds
     * `locales` with `en` seeded). Writing `defaultLocale: ua` produced a tour that compiled
     * clean, reported success and shipped in English. The field is gone now, and this is what
     * stops the next such field from lingering — including a typo like `stepss:` that silently
     * compiles a tour with no steps.
     */
    const KNOWN_TOP_LEVEL = new Set([
        'format', 'id', 'slug', 'version', 'status', 'title', 'description', 'category',
        'estimatedMinutes', 'launch', 'session', 'requirements', 'defaults', 'setup', 'steps',
    ]);
    for (const key of Object.keys(src)) {
        if (KNOWN_TOP_LEVEL.has(key)) continue;
        const hint = key === 'defaultLocale'
            ? ' — removed: the base bundle is always `en`, and a locale sidecar under '
              + '`authoring/locales/<code>/` is how a tour is translated'
            : '';
        diag.error(`unknown top-level key \`${key}\`${hint}`, locate([key]));
    }

    const defaults = src.defaults ?? {};
    const tourId = src.id;

    // metadata copy → generated ContentRefs (§5.2)
    const metaTitleKey = `tour.${tourId}.title`;
    const metaDescKey = `tour.${tourId}.description`;
    if (typeof src.title === 'string') content[metaTitleKey] = src.title;
    else if (checkIconQuoting(src.title, ['title'], diag, locate)) { /* reported */ }
    if (typeof src.description === 'string') content[metaDescKey] = src.description;
    // the author-facing reason a requirement may be unmet — prose, so it is a content key
    if (typeof src.requirements?.unavailableHint === 'string') {
        content[`tour.${tourId}.unavailableHint`] = src.requirements.unavailableHint.trimEnd();
    }

    const steps = [];
    const stepIds = new Set();

    (src.steps || []).forEach((step, i) => {
        const p = ['steps', i];
        if (!step.id) { diag.error('a step is missing `id`', locate(p)); return; }
        if (stepIds.has(step.id)) diag.error(`duplicate step id: ${step.id}`, locate([...p, 'id']));
        stepIds.add(step.id);

        if (!['info', 'interaction', 'transition', 'story'].includes(step.kind)) {
            // §6.1: kind is explicit. Inference would let a small edit silently change behaviour.
            diag.error(`step "${step.id}": \`kind\` must be info, interaction, transition or story`, locate([...p, 'kind']));
            return;
        }

        const keys = contentKeys(tourId, step.id);
        if (typeof step.title === 'string') content[keys.title] = step.title;
        else if (!checkIconQuoting(step.title, [...p, 'title'], diag, locate)) {
            diag.error(`step "${step.id}": \`title\` is required`, locate([...p, 'title']));
        }
        if (typeof step.body === 'string') content[keys.body] = step.body.trimEnd();
        else if (!checkIconQuoting(step.body, [...p, 'body'], diag, locate)) {
            diag.error(`step "${step.id}": \`body\` is required`, locate([...p, 'body']));
        }

        const out = {
            id: step.id,
            type: step.kind,
            content: { title: keys.title, body: keys.body },
            interactionMode: pick(step.interactionMode, defaults.interactionMode, 'NONE'),
        };

        const targets = compileTargets(step, defaults, p, diag, locate);
        if (targets.length) out.targets = targets;

        if (step.kind === 'interaction') {
            if (!targets.length) diag.error(`interaction step "${step.id}" has no target`, locate(p));
            const completion = compileCondition(step.complete, [...p, 'complete'], diag, locate);
            if (!completion) diag.error(`interaction step "${step.id}" has no completion rule`, locate(p));
            else out.completion = completion;
        }

        /**
         * A STORY step guides a person through their own story rather than teaching a control.
         * It has no completion — "mark each version with its own shape" has no right answer to
         * wait for — and its `tools` are the buttons the card's author chose for THIS step.
         *
         * `do` decides what pressing one does: `activate` runs the command (preparation, like
         * moving to frame 2 — hunting for a control only stands between the person and the
         * exercise), `hint` highlights where it lives and leaves the pressing to them (the work
         * itself, because doing that for someone is doing their exercise for them).
         */
        if (step.kind === 'story') {
            if (step.complete !== undefined) {
                diag.error(`story step "${step.id}": a story step has no completion rule — it is finished when the person says so`,
                    locate([...p, 'complete']));
            }
            const tools = [];
            for (const [i, tool] of (step.tools || []).entries()) {
                const tp = [...p, 'tools', i];
                if (typeof tool?.command !== 'string' || !tool.command) {
                    diag.error(`step "${step.id}": a tool has no \`command\``, locate(tp));
                    continue;
                }
                if (tool.do !== undefined && tool.do !== 'activate' && tool.do !== 'hint') {
                    diag.error(`step "${step.id}": tool "${tool.command}" has \`do: ${tool.do}\` — expected activate or hint`, locate(tp));
                    continue;
                }
                tools.push({ command: tool.command, do: tool.do || 'activate', ...(tool.args ? { args: tool.args } : {}) });
            }
            // Four is a choice; a fifth makes it a toolbar again, which is the thing a story
            // step exists to avoid. A warning rather than an error: the runtime already caps
            // it, so the tour still works — the author just gets less than they wrote.
            if (tools.length > 4) {
                diag.warn(`step "${step.id}" declares ${tools.length} tools — only the first four are shown`, locate(p));
            }
            if (tools.length) out.tools = tools;
        }

        if (step.kind === 'transition') {
            const waitFor = compileCondition(step.waitFor, [...p, 'waitFor'], diag, locate);
            if (waitFor) out.waitFor = waitFor;
            if (step.timeoutMs !== undefined) out.timeoutMs = step.timeoutMs;

            // `waitAfter` guards a condition that is ALREADY TRUE before the thing it waits for
            // happens. "Come back when you are done" waits for `gamifier.active` falsy, which
            // is true before the workspace ever opens, so it completed on its first poll and
            // the tour ran four steps together. Naming the event that must fire first makes the
            // wait mean what it says.
            if (step.waitAfter !== undefined) {
                if (typeof step.waitAfter !== 'string') {
                    diag.error('`waitAfter` must be an event name', locate([...p, 'waitAfter']));
                } else if (!waitFor) {
                    diag.error('`waitAfter` needs a `waitFor` to guard', locate([...p, 'waitAfter']));
                } else {
                    out.waitAfterEvent = step.waitAfter;
                }
            }
        }

        const advanceMode = pick(step.advance, defaults.advance, 'manual');
        out.advance = typeof advanceMode === 'string'
            ? { mode: advanceMode }
            : advanceMode;
        if (step.kind === 'transition') out.advance = { mode: 'automatic' };

        if (step.beforeStep) out.beforeStep = compileActions(step.beforeStep);
        if (step.enter) out.enter = compileActions(step.enter);
        if (step.exit) out.exit = compileActions(step.exit);
        if (step.navigation) out.navigation = step.navigation;

        // 04-tour-format.md StepRouting. `when` goes through compileCondition so a branch may
        // use the same `state:` shorthand a completion rule does — an author should not have to
        // remember that one place takes shorthand and another does not.
        if (step.routing) {
            const branches = (step.routing.branches || []).map((br, bi) => ({
                ...(br.when ? { when: compileCondition(br.when, [...p, 'routing', 'branches', bi], diag, locate) } : {}),
                goto: br.goto,
            }));
            out.routing = {
                ...(branches.length ? { branches } : {}),
                ...(step.routing.defaultNext ? { defaultNext: step.routing.defaultNext } : {}),
            };
        }

        // A tour-level `fallback` default applies only to steps that can actually FAIL — a step
        // with no target cannot report TARGET_NOT_FOUND, so giving it a fallback is noise in the
        // artifact and a lie in the structure graph. An explicit step-level fallback is always
        // honoured; only the DEFAULT is gated.
        const fallbackSource = step.fallback ?? (targets.length ? defaults.fallback : undefined);
        const fallback = compileFallback(fallbackSource, { tourId, stepId: step.id, content });
        if (fallback) out.fallback = fallback;

        if (step.poi) {
            for (const z of step.poi) {
                if (!ZONES.has(z)) diag.error(`step "${step.id}": unknown POI zone "${z}"`, locate([...p, 'poi']));
            }
            out.poi = step.poi;
        }
        if (step.poiOverrides) out.poiOverrides = step.poiOverrides;
        const panel = step.panel ?? defaults.panel;
        if (panel) {
            if (panel.anchor) {
                const targetIds = new Set(targets.map((target) => target.id));
                if (!targetIds.has(panel.anchor.target)) {
                    diag.error(`step "${step.id}": panel.anchor.target "${panel.anchor.target}" is not one of this step's targets`, locate([...p, 'panel', 'anchor', 'target']));
                }
            }
            out.panelPlacement = panel;
        }

        steps.push(out);
    });

    const tour = {
        // 1.1 exactly when the tour uses the placement fields 08 §8.2 added (`poi`,
        // `poiOverrides`, `panelPlacement`); 1.0 otherwise. Declared rather than fixed because
        // the version is a promise to the runtime about which fields may appear — stamping 1.1
        // on every tour would claim a dependency most of them do not have, and stamping 1.0 on
        // one that uses POI would understate it.
        schemaVersion: steps.some((s) => s.poi || s.poiOverrides || s.panelPlacement) ? '1.1' : '1.0',
        id: tourId,
        version: src.version,
        status: src.status ?? 'draft',
        meta: {
            title: metaTitleKey,
            ...(src.description ? { description: metaDescKey } : {}),
            ...(src.category ? { category: src.category } : {}),
            ...(src.estimatedMinutes ? { estimatedMinutes: src.estimatedMinutes } : {}),
        },
        ...(src.launch ? { launch: compileLaunch(src.launch) } : {}),
        // `unavailableHint` is PROSE, so it goes through i18n like every other string an
        // author writes: the compiled tour carries the key, the bundle carries the sentence.
        ...(src.requirements ? { requirements: compileRequirements(src.requirements, tourId) } : {}),
        ...(src.session ? { session: compileSession(src.session) } : {}),
        ...(src.setup ? { setup: compileActions(src.setup) } : {}),
        steps,
        ...(src.teardown ? { teardown: compileTeardown(src.teardown) } : {}),
    };

    const entry = {
        slug: src.slug,
        id: tourId,
        version: src.version,
        status: src.status ?? 'draft',
        definition: `${src.slug}.json`,
        meta: tour.meta,
        ...(src.launch ? { launch: tour.launch } : {}),
    };

    validateSemantics(tour, content, registry, diag, locate, src);

    return { diag, tour, content, entry };
}

/**
 * Requirements pass through unchanged except for `unavailableHint`, which is a sentence shown
 * to a reader and therefore has to be translatable.
 */
function compileRequirements(req, tourId) {
    if (!req.unavailableHint) return req;
    const { unavailableHint, ...rest } = req;
    return { ...rest, unavailableHint: `tour.${tourId}.unavailableHint` };
}
function compileLaunch(l) {
    const out = {};
    if (l.sources) out.allowedSources = l.sources;
    if (l.autoStart) out.autoStart = l.autoStart;
    if (l.resume !== undefined) out.allowResume = l.resume;
    if (l.restart) out.restartPolicy = l.restart;
    return out;
}

function compileSession(s) {
    const out = {};
    if (s.content) out.contentMode = s.content === 'user' ? 'user-content' : s.content;
    if (s.onEnd) out.onEnd = s.onEnd;
    return out;
}

function compileTeardown(t) {
    const out = {};
    for (const branch of ['onComplete', 'onClose', 'onSkip']) {
        if (t[branch]) out[branch] = compileActions(t[branch]);
    }
    return out;
}

/* ── semantic validation — §10.3 ─────────────────────────────────────────────────────────── */

function validateSemantics(tour, content, registry, diag, locate, src) {
    const commands = new Set(registry.commandIds);
    const guideCommands = new Set(registry.guideCommands);
    const targets = new Set([...registry.commandIds, ...registry.manualTargets]);
    const queries = new Set(registry.queries);
    const events = new Set(registry.events);
    const iconCommands = new Set(registry.iconCommandIds);
    const sprites = new Set(registry.sprites);
    const stepIds = new Set(tour.steps.map((s) => s.id));

    tour.steps.forEach((step, i) => {
        const p = ['steps', i];

        for (const t of step.targets || []) {
            if (!targets.has(t.id)) {
                diag.error(`step "${step.id}": unknown target "${t.id}"${suggest(t.id, targets)}`, locate(p));
            }
            if (t.id === 'canvas.frame' && t.args?.index === undefined) {
                diag.error(`step "${step.id}": target canvas.frame requires args.index`, locate(p));
            }
        }

        for (const rule of [step.completion, step.waitFor]) {
            for (const name of conditionEvents(rule)) {
                if (!events.has(name)) diag.error(`step "${step.id}": unknown event "${name}"${suggest(name, events)}`, locate(p));
            }
            for (const name of conditionQueries(rule)) {
                if (!queries.has(name)) diag.error(`step "${step.id}": unknown query "${name}"${suggest(name, queries)}`, locate(p));
            }
        }

        // A `waitAfter` naming an event nothing emits would wait forever in total silence —
        // exactly the failure mode this feature exists to remove, so it is checked like any
        // other event name, and against the earlier steps that could actually arm it.
        if (step.waitAfterEvent) {
            if (!events.has(step.waitAfterEvent)) {
                diag.error(`step "${step.id}": unknown event "${step.waitAfterEvent}"${suggest(step.waitAfterEvent, events)}`, locate(p));
            } else {
                const armed = tour.steps.slice(0, i)
                    .some((s) => conditionEvents(s.completion).has(step.waitAfterEvent));
                if (!armed) {
                    diag.warn(`step "${step.id}": waitAfter "${step.waitAfterEvent}" is not the completion of any earlier step, so this wait can only time out`, locate(p));
                }
            }
        }

        // A tool button names a real command or it does nothing — and unlike a mistyped
        // `enter` action, nothing reports it at runtime: the button simply sits there.
        for (const tool of step.tools || []) {
            if (!commands.has(tool.command) && !guideCommands.has(tool.command)) {
                diag.error(`step "${step.id}": tool command "${tool.command}" is absent from the command registry${suggest(tool.command, new Set([...commands, ...guideCommands]))}`, locate(p));
            }

            // `dismiss` names the events that take a hint's highlight back (CR-01 §4). A typo
            // here fails the way a missing tool command does — silently, and worse: the ring
            // simply never lifts until the timeout, which reads as the hang BUG-01 fixed. So it
            // is an error at author time, where someone is looking.
            if (tool.dismiss !== undefined && tool.do !== 'hint') {
                diag.error(`step "${step.id}": tool "${tool.command}" has dismiss but do is not "hint" — only a hint raises a highlight to take back`, locate(p));
            }
            for (const rule of tool.dismiss || []) {
                if (!events.has(rule.event)) {
                    diag.error(`step "${step.id}": dismiss event "${rule.event}" on tool "${tool.command}" is not an editor event${suggest(rule.event, events)}`, locate(p));
                }
                // `command` only means anything to the one event that carries it.
                if (rule.command !== undefined && rule.event !== 'command.executed') {
                    diag.error(`step "${step.id}": dismiss rule for "${rule.event}" sets command, but only command.executed carries one`, locate(p));
                }
                if (rule.command !== undefined
                    && !commands.has(rule.command) && !guideCommands.has(rule.command)) {
                    diag.error(`step "${step.id}": dismiss command "${rule.command}" is absent from the command registry${suggest(rule.command, new Set([...commands, ...guideCommands]))}`, locate(p));
                }
            }
        }

        for (const action of [...(step.beforeStep || []), ...(step.enter || []), ...(step.exit || [])]) {
            if (!commands.has(action.command) && !guideCommands.has(action.command)) {
                diag.error(`step "${step.id}": unknown command "${action.command}"${suggest(action.command, new Set([...commands, ...guideCommands]))}`, locate(p));
            }
        }

        if (step.fallback?.type === 'goto' && !stepIds.has(step.fallback.stepId)) {
            diag.error(`step "${step.id}": fallback goto points at missing step "${step.fallback.stepId}"`, locate(p));
        }

        // Routing targets get the same check. The runtime warns and falls through on a missing
        // one rather than stranding the user, but a tour that silently walks past the branch its
        // author wrote is a broken tour — it has to fail here, where someone is looking.
        for (const branch of step.routing?.branches || []) {
            if (branch.goto && !stepIds.has(branch.goto)) {
                diag.error(`step "${step.id}": routing branch points at missing step "${branch.goto}"`, locate(p));
            }
        }
        if (step.routing?.defaultNext && !stepIds.has(step.routing.defaultNext)) {
            diag.error(`step "${step.id}": routing defaultNext points at missing step "${step.routing.defaultNext}"`, locate(p));
        }

        // A branch that can never be reached is almost certainly an editing mistake: a
        // `defaultNext` before any branch would be, but branches are ordered and the FIRST match
        // wins, so an unconditional branch makes everything after it dead.
        const always = (step.routing?.branches || []).findIndex((b) => !b.when);
        if (always !== -1 && always < (step.routing.branches.length - 1)) {
            diag.warn(`step "${step.id}": routing branch ${always + 1} has no \`when\`, so the `
                + 'branches after it can never run', locate(p));
        }

        /**
         * A completion rule waiting for a `system` event with the default origin can NEVER
         * match, so the step waits forever with Next disabled and nothing to explain why.
         *
         * Completion defaults to origin "user" (04-tour-format.md) — deliberately, so a tour's
         * own setup cannot satisfy the step it was preparing. But several real events are
         * emitted as `system` because the APP does the thing: frame.created fires from
         * newFrame(), gamifier.opened from destroy(). Found by writing stage1-frames and
         * watching a correct-looking step never complete against a frame that had visibly
         * been created.
         */
        for (const rule of [step.completion, step.waitFor]) {
            for (const name of conditionEvents(rule)) {
                if (!SYSTEM_EVENTS.has(name)) continue;
                if (eventOrigin(rule, name) === 'system') continue;
                diag.warn(`step "${step.id}": "${name}" is emitted with origin "system", but `
                    + 'completion defaults to "user" — add `origin: system` or the step can '
                    + 'never complete', locate(p));
            }
        }

        /**
         * [BUG-020] The ring is an instruction. Ringing a button says "press this", so the
         * step's completion rule has to be something pressing it can actually satisfy.
         *
         * Three ways that instruction lies, and all three shipped:
         *
         *   - the ring invites a press the step never checks. stage1-frames `deleting` rang
         *     delete_selected_frame_content on an INFO step with no rule: the user pressed the
         *     ringed button, the app warned "Selected frame will be deleted", the frame went —
         *     and the guide neither expected the event nor acknowledged it. Reported by a user
         *     with the emitted-but-unhandled event in hand.
         *   - the ring points at button A while the rule waits for command B: pressing the
         *     ringed control does nothing, and pressing an unringed one advances the tour.
         *   - the rule accepts ANY command.executed, so every button in the app satisfies it.
         *
         * NOT flagged: a rule waiting for the CONSEQUENCE of the ringed button rather than the
         * press — add_frame completing on frame.created, shatter_frame on gamifier.opened.
         * That is the stronger check, not a weaker one: it verifies the thing actually happened
         * instead of that a button was clicked. Only a rule the ringed button cannot plausibly
         * reach is a mismatch, so the consequence events are listed rather than guessed.
         *
         * A dotted target (canvas.frame, panel.palette, control.lineWidth) is a SURFACE, not a
         * button, and carries no implied press — left to the author.
         */
        // An internal draft is exempt from the "invites a press it never checks" half only.
        // demo-placement exists PRECISELY to ring a control and watch the panel dodge it — the
        // ring is the subject of the test, not an instruction to a reader, and no reader is
        // ever offered the tour (status: draft, category: internal). The mismatch warnings
        // below still apply to it: ringing one button while waiting for another is a mistake
        // in a probe too. Scoped to both flags together so a tour cannot lose the check by
        // being merely unfinished.
        const isInternalProbe = (tour.meta?.category ?? tour.category) === 'internal'
            && (tour.meta?.status ?? tour.status) === 'draft';

        const ringed = targetButtonId(step, commands);
        if (ringed) {
            const rule = step.type === 'interaction' ? step.completion
                : step.type === 'transition' ? step.waitFor : null;
            const events = conditionEvents(rule);
            const wanted = commandNamesIn(rule);

            if (!rule) {
                if (!isInternalProbe) {
                    diag.warn(`step "${step.id}" rings the button "${ringed}", which invites a press, `
                        + 'but checks nothing — give it a completion rule, or point at something '
                        + 'that is not a control', locate(p));
                }
            } else if (wanted.has('*')) {
                diag.warn(`step "${step.id}" rings "${ringed}" but completes on ANY `
                    + 'command.executed — every other button in the app satisfies it; '
                    + 'add match: {command: ...}', locate(p));
            } else if (wanted.size && !wanted.has(ringed)) {
                diag.warn(`step "${step.id}" rings "${ringed}" but completes on `
                    + `command.executed {command: ${[...wanted].join(' | ')}} — pressing the `
                    + 'ringed button does not advance the step, and pressing an unringed one does',
                    locate(p));
            } else if (events.size && ![...events].some((e) => e === 'command.executed' || CONSEQUENCE_EVENTS.has(e))) {
                diag.warn(`step "${step.id}" rings "${ringed}" but completes on `
                    + `${[...events].join(' | ')}, which pressing it does not produce`, locate(p));
            }
        }

        // §14 warning: an interaction step with no fallback. Targets disappear for ordinary
        // reasons — responsive layout, level gating, a closed panel.
        if (step.type === 'interaction' && !step.fallback) {
            diag.warn(`step "${step.id}" has no fallback`, locate(p));
        }

        if (step.poi && step.poi.length === 9) {
            diag.warn(`step "${step.id}" protects all nine POI zones, leaving nowhere for the panel`, locate(p));
        }
    });

    for (const action of tour.setup || []) {
        if (!commands.has(action.command) && !guideCommands.has(action.command)) {
            diag.error(`setup: unknown command "${action.command}"${suggest(action.command, new Set([...commands, ...guideCommands]))}`, locate(['setup']));
        }
    }

    // §10.3: a completion condition already satisfied by setup — the step completes the instant
    // it appears and the user never gets to act.
    validateSelfCompletion(tour, diag, locate);
    validateBeforeStepConflict(tour, diag, locate);

    /**
     * A tour that needs the editor but never clears the screen.
     *
     * Settings, PDF-maker, the 3D book and every gamifier cover the whole viewport while the
     * editor keeps running underneath, so a step can resolve its target — the button IS in the
     * DOM — and still be pointing at something nobody can reach. `ui.setupLocation` exists for
     * exactly this, and forgetting it produces a tour that works when tested from a clean
     * editor and fails for a user who had settings open.
     *
     * A warning, not an error: a tour of pure info steps needs nothing cleared, and so does one
     * launched somewhere the question does not arise.
     */
    const touchesEditor = tour.steps.some((s) => (s.targets || []).length);
    const clears = [...(tour.setup || []), ...tour.steps.flatMap((s) => s.enter || [])]
        .some((a) => a.command === 'ui.setupLocation');
    if (touchesEditor && !clears) {
        diag.warn('this tour highlights editor controls but never runs `ui.setupLocation` — '
            + 'a settings window or gamifier left open by a previous tour will cover them',
            locate(['steps']));
    }

    // 10-content-icons.md §6 / 09 §8.3 — icon tokens in the DEFAULT locale.
    validateIconTokens(content, iconCommands, sprites, commands, diag, null);
}

/** A step whose own `enter` runs the command its completion waits for (§14, 04's rule). */
function validateSelfCompletion(tour, diag, locate) {
    tour.steps.forEach((step, i) => {
        const rule = step.completion;
        if (!rule) return;
        const names = conditionEvents(rule);
        if (!names.has('command.executed')) return;
        for (const action of step.enter || []) {
            const wanted = commandMatchedBy(rule);
            if (wanted === undefined || wanted === action.command) {
                diag.error(
                    `step "${step.id}" completes itself: its enter action runs "${action.command}", `
                    + 'which fires the very event its completion rule waits for',
                    locate(['steps', i]),
                );
            }
        }
    });
}

/**
 * CR-003: `beforeStep` and `enter` run back to back on every show — `beforeStep` resets what
 * the step is about to ask for, `enter` then prepares the scene. The same command in both
 * lists is not a scene being reset and then prepared; it is one action immediately undone by
 * the other, which is either a copy-paste leftover or an author who put a step's precondition
 * in the wrong list. Command IDENTITY, not "does it look like an inverse" — inferring that a
 * toggle's second call reverses the first belongs to `kind`, not to prose-reading here.
 */
function validateBeforeStepConflict(tour, diag, locate) {
    tour.steps.forEach((step, i) => {
        if (!step.beforeStep?.length || !step.enter?.length) return;
        const enterCommands = new Set(step.enter.map((a) => a.command));
        for (const action of step.beforeStep) {
            if (enterCommands.has(action.command)) {
                diag.error(
                    `step "${step.id}": "${action.command}" is in both beforeStep and enter — `
                    + 'beforeStep runs first, so enter immediately undoes what it just reset',
                    locate(['steps', i]),
                );
            }
        }
    });
}

function commandMatchedBy(rule) {
    if (!rule) return undefined;
    if (rule.type === 'event') return rule.match?.command;
    if (rule.type === 'all' || rule.type === 'any') {
        for (const c of rule.conditions || []) {
            const v = commandMatchedBy(c);
            if (v !== undefined) return v;
        }
    }
    if (rule.type === 'not') return commandMatchedBy(rule.condition);
    return undefined;
}

/**
 * 09 §8.3: icon tokens are checked for EXISTENCE, never for parity between locales. A locale
 * may legitimately use more, fewer or no icons — that is the whole reason the token lives in
 * the sentence rather than in a step field.
 */
export function validateIconTokens(content, iconCommands, sprites, allCommands, diag, localeName) {
    const where = localeName ? ` (${localeName})` : '';
    for (const [key, text] of Object.entries(content)) {
        if (typeof text !== 'string') continue;
        ICON_TOKEN_RX.lastIndex = 0;
        for (const [token, isCmd, id] of text.matchAll(ICON_TOKEN_RX)) {
            if (isCmd) {
                if (!allCommands.has(id)) {
                    diag.error(`icon token "${token}" in "${key}"${where} names a command absent from the registry${suggest(id, allCommands)}`);
                } else if (!iconCommands.has(id)) {
                    // §14 warning: valid command, but nothing will render (10 §5 is silent).
                    diag.warn(`icon token "${token}" in "${key}"${where} names a command with no resolvable icon — it will render nothing`);
                }
            } else if (!sprites.has(id)) {
                // a warning, not an error: the sheet is a build asset the compiler may not have
                diag.warn(`icon token "${token}" in "${key}"${where} is not a sprite in panel-icons.svg`);
            }
        }
    }
}

/**
 * Events the app emits with `origin: 'system'` — the ones a completion rule must opt into.
 *
 * Listed here rather than derived, because origin is an ARGUMENT to emit() and the registry
 * extractor reads event NAMES. The list is short, the events are a frozen namespace
 * (02-editor-api.md §9), and the cost of it going stale is a warning that stops appearing —
 * not a wrong one. Deriving it would mean parsing the third argument of every emit call.
 */
const SYSTEM_EVENTS = new Set([
    'frame.created', 'animation.idle', 'layer.remoteAdded',
    'collaboration.roster', 'collaboration.newUser', 'collaboration.firstInRoom',
    'gamifier.opened', 'gamifier.closed',
]);

/** The `origin` declared for one event name inside a (possibly nested) condition. */
function eventOrigin(rule, name) {
    if (!rule) return undefined;
    if (rule.type === 'event' && rule.event === name) return rule.origin;
    for (const c of rule.conditions || []) {
        const found = eventOrigin(c, name);
        if (found !== undefined) return found;
    }
    return rule.condition ? eventOrigin(rule.condition, name) : undefined;
}

function conditionEvents(rule, out = new Set()) {
    if (!rule) return out;
    if (rule.type === 'event') out.add(rule.event);
    for (const c of rule.conditions || []) conditionEvents(c, out);
    if (rule.condition) conditionEvents(rule.condition, out);
    return out;
}

/**
 * [BUG-020] Events a button press can CAUSE without being a `command.executed` for that button.
 *
 * A step ringing `add_frame` and completing on `frame.created` is not a mismatch — it is the
 * better check, because it verifies a frame actually appeared rather than that a button was
 * clicked (D14 prefers the consequence). This list is what keeps the target/goal warning from
 * firing on that correct pattern.
 *
 * Listed rather than derived for the same reason SYSTEM_EVENTS is: which events a given press
 * can cause is not recoverable from the emit() call sites, the namespace is frozen
 * (02-editor-api.md §9), and a stale entry costs a warning that stops appearing — never a
 * wrong one.
 */
const CONSEQUENCE_EVENTS = new Set([
    'frame.created', 'frame.moved', 'gamifier.opened', 'gamifier.closed',
    'drawing.completed', 'color.selected', 'animation.idle', 'layer.remoteAdded',
    'collaboration.newUser', 'collaboration.roster', 'collaboration.firstInRoom',
]);

/**
 * [BUG-020] The step's primary target when it is a BUTTON, else null.
 *
 * A command id carries no dot; every semantic surface does (`canvas.frame`, `panel.palette`,
 * `control.lineWidth`). Only a button implies "press me", so only a button is held to the rule.
 * An id absent from the registry is already an error elsewhere — not re-reported here.
 */
function targetButtonId(step, commands) {
    const targets = step.targets || [];
    if (!targets.length) return null;
    const primary = (targets.find((t) => t.role === 'primary') || targets[0])?.id;
    if (typeof primary !== 'string') return null;

    // A dotted id is usually a REGION — panel.layers, canvas.frame, nav.frame — and ringing a
    // region is an invitation to look, not to press, so those are rightly exempt.
    //
    // `button.*` is the exception, and skipping it cost two steps: collab.drawing/who-is-here
    // and demo.stage0/collab-button both ringed button.collab with no rule behind it, and the
    // ring then never responded to a press — a highlight is released by _onCompleted(), which
    // a step with no completion rule never reaches. The check that exists to catch exactly
    // that was skipping them on the dot alone.
    if (primary.startsWith('button.')) return primary;

    if (primary.includes('.')) return null;
    if (commands && !commands.has(primary)) return null;
    return primary;
}

/** Every command id a rule's command.executed branches name; '*' when a branch names none. */
function commandNamesIn(rule, out = new Set()) {
    if (!rule) return out;
    if (rule.type === 'event' && rule.event === 'command.executed') {
        out.add(rule.match?.command ?? '*');
    }
    for (const c of rule.conditions || []) commandNamesIn(c, out);
    if (rule.condition) commandNamesIn(rule.condition, out);
    return out;
}

function conditionQueries(rule, out = new Set()) {
    if (!rule) return out;
    if (rule.type === 'state') out.add(rule.query);
    for (const c of rule.conditions || []) conditionQueries(c, out);
    if (rule.condition) conditionQueries(rule.condition, out);
    return out;
}

/** §9.3's "Did you mean …?" — Levenshtein within a small edit budget. */
function suggest(word, candidates) {
    let best = null;
    let bestD = Infinity;
    for (const c of candidates) {
        const d = editDistance(word, c);
        if (d < bestD) { bestD = d; best = c; }
    }
    const budget = Math.max(2, Math.floor(word.length / 4));
    return best && bestD <= budget ? `. Did you mean "${best}"?` : '';
}

function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 8) return Infinity;   // cheap reject
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = tmp;
        }
    }
    return prev[b.length];
}

/* ── locale sidecars — §8.2 ──────────────────────────────────────────────────────────────── */

/**
 * An UNTRANSLATED key must not reach the bundle. `loadLocale()` merges the locale over English
 * with a spread, so a key present as `""` wins and blanks the English text — a skeleton saved
 * half-finished showed empty titles in the catalog rather than falling back. Absence is the
 * only thing that falls back, so an empty (or whitespace-only) value is treated as absent.
 *
 * Deliberately empty copy is not expressible here, and should not be: a step whose body is
 * meant to be blank says so in the tour, not in a translation of it.
 */
function translated(value) {
    return typeof value === 'string' && value.trim() !== '';
}

/**
 * Sidecars are keyed structurally by tour and step id, then mapped onto the generated content
 * keys. Structural keying is what lets a translator see a step rather than a flat key list.
 */
export function compileLocale(sidecarSource, tourId, knownStepIds, file, diag) {
    const src = yamlParse(sidecarSource);
    const content = {};
    if (!src) return content;

    if (translated(src.title)) content[`tour.${tourId}.title`] = src.title;
    if (translated(src.description)) content[`tour.${tourId}.description`] = src.description;
    if (translated(src.requirements?.unavailableHint)) {
        content[`tour.${tourId}.unavailableHint`] = src.requirements.unavailableHint;
    }

    for (const [stepId, copy] of Object.entries(src.steps || {})) {
        if (!knownStepIds.has(stepId)) {
            diag.error(`${file}: translation for unknown step "${stepId}"`);
            continue;
        }
        const keys = contentKeys(tourId, stepId);
        if (translated(copy?.title)) content[keys.title] = copy.title;
        if (translated(copy?.body)) content[keys.body] = copy.body.trimEnd();

        // A step's FALLBACK copy is content too — `tour.<id>.step.<step>.fallback.title|body`,
        // generated by compileTour for any step that declares one. It was unreachable from a
        // sidecar: only `title` and `body` were read here, so a fully translated tour still
        // showed English the moment a step fell back — which is exactly when the reader is
        // already confused and least able to cope with a second language.
        const fallback = copy?.fallback;
        if (translated(fallback?.title)) {
            content[`tour.${tourId}.step.${stepId}.fallback.title`] = fallback.title;
        }
        if (translated(fallback?.body)) {
            content[`tour.${tourId}.step.${stepId}.fallback.body`] = fallback.body.trimEnd();
        }
    }
    return content;
}

/* ── deterministic output — §9.2 ─────────────────────────────────────────────────────────── */

/**
 * §9.2: byte-for-byte deterministic. Stable key order, no timestamps, no random ids, a
 * normalized final newline. `--check` compares bytes, so any instability here reads as a
 * spurious CI failure.
 */
export function stableJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function sortedByKey(obj) {
    return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

/* ── driver ──────────────────────────────────────────────────────────────────────────────── */

/** Existing generated/hand-written JSON, for the migration merge above. `{}` when absent. */
