"use strict";
// Tour validation — tilecraft/guide/v1/04-tour-format.md "Validation".
// Pure, DOM-free: reject before publishing. Browser global when loaded via <script>,
// CommonJS export when loaded under Node/vitest (tests/setup.js loadTilecraftScript pattern).

// 04-tour-format.md says "a target id containing a CSS selector (#, ., [)" is rejected, but
// its own worked examples use `.` as a namespace separator (canvas.frame, button.collab,
// 02-editor-api.md §9's frames.*/canvas.*/... namespaces) — a literal reading would reject
// every semantic id the spec itself defines. Measured against tour-validate.test.js: `#` and
// `[` are unambiguous (an id is never legitimately a raw CSS selector or attribute matcher),
// so those two are enforced; `.` is treated as the namespace separator the rest of the spec
// relies on. Flagged in the Stage 0 report as a spec/code discrepancy, not silently resolved.
const SEMANTIC_ID_RX = /[#\[]/;

/**
 * Every event a completion rule can name, plus the command each one reports. Used to catch a
 * step whose own `enter` fires the event it is waiting for — 04-tour-format.md lists this as a
 * rejection ("enter runs a command that emits the step's own completion event"), and it is the
 * subtlest failure in the list: the step completes the instant it appears, the user never gets
 * to act, and nothing in the run looks wrong.
 */
function _selfCompletingAction(step) {
    const rule = step.type === 'interaction' ? step.completion : null;
    if (!rule) return null;
    const events = collectEventNamesLocal(rule);
    if (!events.size) return null;

    for (const action of step.enter || []) {
        // an action running command X makes command.executed{command: X} fire
        if (events.has('command.executed') && _ruleMatchesCommand(rule, action.command)) {
            return action.command;
        }
    }
    return null;
}

function _ruleMatchesCommand(rule, commandId) {
    if (!rule) return false;
    if (rule.type === 'event') {
        if (rule.event !== 'command.executed') return false;
        // no `match` means "any command.executed" — an enter action always satisfies it
        if (!rule.match || rule.match.command === undefined) return true;
        return rule.match.command === commandId;
    }
    if (rule.type === 'all' || rule.type === 'any') {
        return (rule.conditions || []).some((c) => _ruleMatchesCommand(c, commandId));
    }
    if (rule.type === 'not') return _ruleMatchesCommand(rule.condition, commandId);
    return false;
}

/** Local copy: tour-validate.js must stay standalone (loaded before condition-eval.js). */
function collectEventNamesLocal(condition, out = new Set()) {
    if (!condition) return out;
    if (condition.type === 'event') out.add(condition.event);
    if (condition.type === 'all' || condition.type === 'any') {
        for (const c of condition.conditions || []) collectEventNamesLocal(c, out);
    }
    if (condition.type === 'not') collectEventNamesLocal(condition.condition, out);
    return out;
}

/** Collect every ContentRef a tour references, so missing translations fail before running. */
function _contentRefs(tour) {
    const refs = [];
    const push = (v) => { if (typeof v === 'string' && v) refs.push(v); };
    push(tour.meta?.title);
    push(tour.meta?.description);
    for (const step of tour.steps || []) {
        push(step.content?.title);
        push(step.content?.body);
        push(step.fallback?.content?.title);
        push(step.fallback?.content?.body);
    }
    return refs;
}

/**
 * Icon tokens in resolved content — 10-content-icons.md §6.
 *
 * Kept in sync with GUIDE_ICON_RX in runtime.js. Duplicated rather than shared because this
 * file must stay standalone: it is loaded before condition-eval.js in the browser and under
 * vitest with no DOM, the same reason collectEventNamesLocal() exists above.
 */
const ICON_TOKEN_RX = /\{icon:(cmd:)?([a-z0-9_-]+)\}/g;

/**
 * A `cmd:` token naming a command that is not in the registry is the failure this validator
 * exists for — "a tour that looks correct and points at nothing". It matters more here than
 * elsewhere because §5 makes a missing icon SILENT at runtime: nothing renders and the user
 * sees a slightly plainer sentence, so authoring time is the only place the typo can surface.
 *
 * Raw sprite ids are deliberately NOT checked: this file is pure and DOM-free, and the 230KB
 * sprite sheet is not available to it. A bad raw id degrades per §5.
 */
function _iconTokenErrors(tour, i18n, knownCommands) {
    if (!i18n || !knownCommands) return [];
    const errors = [];
    for (const ref of _contentRefs(tour)) {
        const text = i18n[ref];
        if (typeof text !== 'string') continue;   // missing translation is reported separately
        for (const [token, cmdPrefix, id] of text.matchAll(ICON_TOKEN_RX)) {
            if (!cmdPrefix) continue;
            if (!knownCommands.has(id)) {
                errors.push(`icon token "${token}" in content key "${ref}" `
                    + 'names a command absent from the registry');
            }
        }
    }
    return errors;
}

/**
 * @param {object} tour
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.knownCommands] command registry ids, when available
 * @param {object|null} [opts.i18n] translation map, to catch unresolved ContentRefs
 */
function validateTour(tour, { knownCommands = null, i18n = null } = {}) {
    const errors = [];
    const err = (msg) => errors.push(msg);

    if (!tour || typeof tour !== 'object') return ['tour must be an object'];

    if (!tour.id) err('id missing');
    if (!(Number(tour.version) >= 1)) err('version < 1');
    if (!Array.isArray(tour.steps) || tour.steps.length === 0) err('no steps');

    const stepIds = new Set();
    const seenTargetIds = [];

    for (const step of tour.steps || []) {
        if (!step.id) { err('a step is missing an id'); continue; }
        if (stepIds.has(step.id)) err(`duplicate step id: ${step.id}`);
        stepIds.add(step.id);

        if (step.type === 'interaction') {
            if (!step.targets || step.targets.length === 0) {
                err(`interaction step "${step.id}" has no target`);
            }
            if (!step.completion) {
                err(`interaction step "${step.id}" has no completion rule`);
            }
        }

        /**
         * A STORY step guides a person through a story rather than teaching a control, so the
         * two rules above are deliberately inverted: it needs no target and no completion.
         * "Mark each version with its own shape" has no right answer to wait for, and a step
         * that gated Next on one would stall a session whenever someone chose not to draw.
         *
         * Its `tools` are the per-step buttons: `activate` runs the command, `hint` highlights
         * where it lives and lets the person press it. Both are visible buttons; only the
         * consequence differs.
         */
        if (step.type === 'story') {
            if (step.completion) {
                err(`story step "${step.id}" must not have a completion rule — a story step is finished when the person says so`);
            }
            for (const tool of step.tools || []) {
                if (typeof tool?.command !== 'string' || !tool.command) {
                    err(`a tool in step "${step.id}" has no command id`);
                } else if (knownCommands && !knownCommands.has(tool.command)) {
                    err(`tool command "${tool.command}" in step "${step.id}" is absent from the command registry`);
                }
                if (tool?.do !== undefined && tool.do !== 'activate' && tool.do !== 'hint') {
                    err(`tool "${tool.command}" in step "${step.id}" has do: "${tool.do}" — expected "activate" or "hint"`);
                }
            }
        }

        for (const t of step.targets || []) {
            seenTargetIds.push(t.id);
            if (SEMANTIC_ID_RX.test(t.id)) {
                err(`target id "${t.id}" in step "${step.id}" looks like a CSS selector — ids are semantic`);
            }
            if (knownCommands && !knownCommands.has(t.id) && !t.id.includes('.')) {
                // dotted ids (canvas.frame, panel.collab, ...) are manual-registry entries,
                // not commands — only bare ids are expected to resolve against the registry
                err(`target "${t.id}" in step "${step.id}" is absent from the command registry`);
            }
        }

        const anchor = step.panelPlacement?.anchor;
        if (anchor) {
            if (!anchor.target || !(step.targets || []).some((t) => t.id === anchor.target)) {
                err(`panel anchor in step "${step.id}" must name one of that step's targets`);
            }
            if (anchor.side !== undefined && !['auto', 'top', 'right', 'bottom', 'left'].includes(anchor.side)) {
                err(`panel anchor in step "${step.id}" has unknown side "${anchor.side}"`);
            }
            if (anchor.align !== undefined && !['start', 'center', 'end'].includes(anchor.align)) {
                err(`panel anchor in step "${step.id}" has unknown align "${anchor.align}"`);
            }
            if (anchor.margin !== undefined && (!Number.isFinite(anchor.margin) || anchor.margin < 0)) {
                err(`panel anchor in step "${step.id}" has invalid margin`);
            }
        }

        for (const action of [...(step.enter || []), ...(step.exit || [])]) {
            if (typeof action.command !== 'string' || !action.command) {
                err(`an action in step "${step.id}" has no command id`);
            }
            if (action.command && /[(){};]/.test(action.command)) {
                err(`action command in step "${step.id}" looks like an expression, not an id: "${action.command}"`);
            }
            // a referenced command must exist — the failure this specification exists to
            // prevent is "a tour that looks correct and points at nothing"
            if (knownCommands && action.command
                && !knownCommands.has(action.command)
                && !action.command.startsWith('demo.') && !action.command.startsWith('ui.')) {
                err(`action command "${action.command}" in step "${step.id}" is absent from the command registry`);
            }
        }

        const selfCompleting = _selfCompletingAction(step);
        if (selfCompleting) {
            err(`step "${step.id}" completes itself: its enter action runs "${selfCompleting}", `
                + 'which fires the very event its completion rule waits for');
        }

        if (step.fallback?.type === 'goto' && step.fallback.stepId && !stepIds.has(step.fallback.stepId)) {
            // may reference a step defined later — checked again in the cross-reference pass below
        }
    }

    // cross-reference pass: goto targets and branches must point at a real step
    for (const step of tour.steps || []) {
        if (step.fallback?.type === 'goto' && !stepIds.has(step.fallback.stepId)) {
            err(`step "${step.id}" fallback goto points at missing step "${step.fallback.stepId}"`);
        }
        for (const branch of step.routing?.branches || []) {
            if (!stepIds.has(branch.goto)) {
                err(`step "${step.id}" branch points at missing step "${branch.goto}"`);
            }
        }
        for (const action of [...(step.enter || []), ...(step.exit || [])]) {
            if (action.onFailure?.type === 'goto' && !stepIds.has(action.onFailure.stepId)) {
                err(`step "${step.id}" action onFailure goto points at missing step "${action.onFailure.stepId}"`);
            }
        }
    }

    // a ContentRef with no translation renders as its own key — visible nonsense to the user,
    // and the second of the two checks 04-tour-format.md says this validation exists for
    if (i18n) {
        for (const ref of _contentRefs(tour)) {
            if (!(ref in i18n)) err(`no translation for content key "${ref}"`);
        }
    }

    // 10-content-icons.md §6 — needs both maps: the translations to read the tokens out of,
    // and the registry to check them against.
    for (const msg of _iconTokenErrors(tour, i18n, knownCommands)) err(msg);

    return errors;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validateTour };
}
