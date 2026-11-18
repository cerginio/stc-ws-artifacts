// Hover documentation — 09-tour-authoring.md §10.1 "hover documentation".
//
// The highlighter emits one span per meaningful token (`data-tok` / `data-kind`), so hover needs
// no second parse: it reads the attribute under the pointer and looks the answer up in the
// generated registry and the schema.
//
// Everything shown here is DERIVED. Nothing is a hand-written description that could drift from
// the application — a command's summary is the command's own `title`/`desc`, an event's shape
// comes from the registry, a key's shape from tour-author.schema.json.

/**
 * Schema fragments for the keys worth explaining.
 *
 * These describe the AUTHORING contract, which the JSON schema states structurally but not
 * readably: `oneOf` branches and `allOf`/`if`/`then` are precise and unhelpful at 2am. The
 * wording is the specification's, not new prose.
 */
const KEY_DOCS = {
    complete: {
        title: 'completion rule',
        note: 'required on kind: interaction',
        shape: ['event: <editor event>   + match? origin?',
            'state: <query>  operator  value?',
            'all: [ … ]   any: [ … ]   not: …'],
        footer: 'origin defaults to "user" — otherwise the tour\'s own setup\nsatisfies the step it was preparing.',
    },
    waitFor: {
        title: 'wait condition',
        note: 'kind: transition',
        shape: ['state: <query>  operator  value?', 'event: <editor event>'],
        footer: 'Wait for a semantic condition, never a sleep.\nPair with timeoutMs — a condition that never becomes true\nmust still surrender.',
    },
    target: {
        title: 'the control this step is about',
        shape: ['target: <semantic id>              shorthand',
            'target: { id, args?, padding?, role? }'],
        footer: 'A semantic id, never a CSS selector. canvas.frame\nrequires args.index (story order, left to right).',
    },
    targets: { title: 'several targets', shape: ['targets: [ {id…}, {id…} ]'],
        footer: 'First is primary, the rest allowed.\nMutually exclusive with `target`.' },
    poi: {
        title: 'protected zones',
        shape: ['poi: [top-left … bottom-right]'],
        footer: 'Authored on the canonical desktop 3x3 grid; the host\nprojects it for compact viewports. Targets are protected\nautomatically — do not duplicate a button as a POI.',
    },
    fallback: {
        title: 'what to do when the step cannot present',
        shape: ['skip-step | fail-tour', '{ type: goto, stepId }', '{ type: show-info, content }'],
        footer: 'Targets disappear for ordinary reasons: responsive\nlayout, level gating, a closed panel.',
    },
    kind: { title: 'step kind', shape: ['info | interaction | transition'],
        footer: 'Explicit, never inferred — inference would let a small\nedit silently change behaviour.' },
    interactionMode: { title: 'pointer/keyboard policy', shape: ['NONE | TARGET_ONLY | EDITOR_LOCKED'],
        footer: 'NONE is the default. TARGET_ONLY and EDITOR_LOCKED also\nsuppress destructive keyboard shortcuts.' },
    advance: { title: 'how the step moves on', shape: ['manual | automatic'] },
    body: { title: 'instructional copy', shape: ['body: |', '  Markdown, may contain {icon:cmd:<id>} tokens'] },
    title: { title: 'step title', footer: 'QUOTE IT if it starts with an icon token:\n  title: "{icon:cmd:id} Move mode"' },
    enter: { title: 'actions run before the step is presented',
        footer: 'Runs before SHOW_STEP, so targets it creates exist by\nthe time the host resolves them.' },
    exit: { title: 'actions run when the step is left', footer: 'Also runs on Back — exit means "leaving this step",\nnot "leaving it forwards".' },
    setup: { title: 'actions run once, before the first step' },
    session: { title: 'content policy', shape: ['content: user | demo', 'onEnd: ask | keep'],
        footer: 'demo creates a marked frame; removal is OFFERED,\nnever automatic.' },
    operator: { title: 'comparison', shape: ['truthy | falsy | eq | neq | gt | gte | lt | lte | contains'],
        footer: 'Prefer truthy/falsy: state() is untyped, so string\nequality breaks on any label change.' },
    timeoutMs: { title: 'give up after', footer: 'A transition whose condition never becomes true\nmust still surrender.' },
};

/** Where a value of each kind may legally appear — useful when an id is valid but misplaced. */
const KIND_USAGE = {
    target: 'target · targets',
    command: 'enter · exit · setup · teardown',
    event: 'complete.event · waitFor.event',
    query: 'complete.state · waitFor.state',
};

function esc(s) {
    return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function box(headline, badge, rows) {
    const head = `<div class="hv-head"><b>${esc(headline)}</b>`
        + (badge ? `<span class="hv-badge" data-kind="${esc(badge.kind)}">${esc(badge.text)}</span>` : '')
        + '</div>';
    return head + rows.filter(Boolean).join('');
}

const line = (text, cls = '') => `<div class="hv-line ${cls}">${esc(text)}</div>`;
const shape = (lines) => `<pre class="hv-shape">${lines.map(esc).join('\n')}</pre>`;

/**
 * Documentation for the token under the pointer, or null when there is nothing worth saying.
 *
 * @param {{tok: string, kind: string, status?: string}} token  from the span's data attributes
 * @param {object} registry
 */
export function hoverDoc(token, registry) {
    const { tok, kind, status } = token;

    if (kind === 'key') {
        const doc = KEY_DOCS[tok];
        if (!doc) return null;
        return box(tok, doc.note ? { kind: 'note', text: doc.note } : null, [
            line(doc.title, 'hv-sub'),
            doc.shape ? shape(doc.shape) : '',
            doc.footer ? line(doc.footer, 'hv-foot') : '',
        ]);
    }

    if (kind === 'icon') {
        const m = /^\{icon:(cmd:)?([a-z0-9_-]+)\}$/.exec(tok);
        if (!m) return null;
        const [, isCmd, id] = m;
        if (!isCmd) {
            const known = registry?.sprites?.includes(id);
            return box(tok, { kind: known ? 'ok' : 'warn', text: known ? 'sprite' : 'not in sheet' }, [
                line('raw sprite from images/panel-icons.svg', 'hv-sub'),
                line('Prefer {icon:cmd:<command-id>}: it follows the registry,\nso redrawing the icon updates the tour.', 'hv-foot'),
            ]);
        }
        const iconed = registry?.iconCommandIds?.includes(id);
        const exists = registry?.commandIds?.includes(id);
        return box(tok, {
            kind: iconed ? 'ok' : exists ? 'warn' : 'err',
            text: iconed ? 'renders' : exists ? 'no icon' : 'unknown command',
        }, [
            line(registry?.commandDocs?.[id] ?? '', 'hv-sub'),
            !exists ? line('Not in the command registry — this is a validation error.', 'hv-foot')
                : !iconed ? line('The command exists but has neither icon nor iconProvider,\nso nothing will render (a missing icon is silent).', 'hv-foot')
                    : '',
        ]);
    }

    // a semantic value: target / command / event / query
    if (KIND_USAGE[kind]) {
        const ok = status !== 'unresolved';
        const rows = [];

        if (kind === 'target' || kind === 'command') {
            const doc = registry?.commandDocs?.[tok];
            if (doc) rows.push(line(doc, 'hv-sub'));
            if (registry?.manualTargets?.includes(tok)) {
                rows.push(line('manual registry target', 'hv-sub'));
            } else if (ok) {
                rows.push(line(`resolves: button[name="${tok}"]`, 'hv-mono'));
            }
            if (tok === 'canvas.frame') rows.push(line('requires args.index (story order)', 'hv-foot'));
        }
        if (kind === 'event') {
            rows.push(line('editor event', 'hv-sub'));
            if (tok === 'frame.moved') rows.push(line('pointer panend while move mode is on · origin user\ndata: travelDistance · idleMs · pointerType', 'hv-foot'));
            if (tok === 'drawing.completed') rows.push(line('pointer panend while drawing, and only if the stroke added tiles · origin user\ndata: travelDistance · idleMs · pointerType', 'hv-foot'));
            if (tok === 'command.executed') rows.push(line('a command ran · narrow it with match: {command: …}\norigin user for a real click, hotkey or slider', 'hv-foot'));
            // [BUG-019] Its own event because a palette pick runs no command at all: colours
            // are painted on a canvas, so there is no id for match: {command: …} to name.
            if (tok === 'color.selected') rows.push(line('a colour was picked from the palette · origin user\ndata: color (hex)', 'hv-foot'));
        }
        if (kind === 'query') {
            rows.push(line('state query, polled no faster than 250ms', 'hv-sub'));
            // Steer authors off command.state for the "is it on?" question: state() is the
            // button's BADGE, so `eq "more"` is string equality against a UI label.
            if (tok === 'command.state') {
                rows.push(line('the button\'s own badge — untyped (false, "less", "foreground ⊻", 1).\n'
                    + 'For "is this tool on?" prefer command.isOn: matching a label breaks\n'
                    + 'silently when the badge is reworded.', 'hv-foot'));
            }
            if (tok === 'command.isOn') {
                rows.push(line('is this tool on right now — a boolean, declared by the command\n'
                    + 'itself. null when the command has not declared isOn(), which is NOT\n'
                    + '"off": a step waiting for a tool to come on must not pass on silence.', 'hv-foot'));
            }
            if (tok === 'command.kind') {
                rows.push(line('what a SECOND press does: toggle (turns off) · mode-cycle\n'
                    + '(changes sub-mode, never off — the pencil) · action (does it again).\n'
                    + 'null when unclassified, deliberately distinct from "action".', 'hv-foot'));
            }
        }

        rows.push(line(`usable in: ${KIND_USAGE[kind]}`, 'hv-foot'));
        if (!ok) rows.unshift(line(`Not found in the ${kind} registry.`, 'hv-err'));

        return box(tok, { kind: ok ? 'ok' : 'err', text: ok ? kind : 'unresolved' }, rows);
    }

    return null;
}
