// Step structure graph — the shape of a tour, from the COMPILED result.
//
// Built from the compiler's output rather than from the YAML text, so it shows what the tour
// will actually do: defaults expanded, shorthand resolved, fallbacks materialised. A graph drawn
// from the source would agree with the source and disagree with the runtime, which is the wrong
// half to be right about.
//
// Rendered as text, not SVG: a tour is a short list of steps with a few edges, the monospace
// grid is already there, and text is selectable, diffable and readable in a terminal when
// someone pastes it into an issue.

const GLYPH = {
    target: '🖱',
    completion: '✓',
    waitFor: '⏱',
    action: '⚙',
    fallback: '⟂',
};

/** A step's completion or waitFor rule, in one line. */
function ruleText(rule) {
    if (!rule) return null;
    if (rule.type === 'event') {
        const match = rule.match
            ? ` {${Object.entries(rule.match).map(([k, v]) => `${k}=${v}`).join(', ')}}`
            : '';
        const origin = rule.origin && rule.origin !== 'user' ? ` origin=${rule.origin}` : '';
        return `event ${rule.event}${match}${origin}`;
    }
    if (rule.type === 'state') {
        const args = rule.args
            ? `(${Object.values(rule.args).join(', ')})`
            : '';
        const value = rule.value !== undefined ? ` ${rule.value}` : '';
        return `state ${rule.query}${args} ${rule.operator}${value}`;
    }
    if (rule.type === 'all' || rule.type === 'any') {
        return `${rule.type} of ${rule.conditions?.length ?? 0}`;
    }
    if (rule.type === 'not') return `not ${ruleText(rule.condition)}`;
    return rule.type;
}

function targetText(t) {
    const args = t.args ? ` ${Object.entries(t.args).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
    const pad = t.padding !== undefined ? `  pad ${t.padding}` : '';
    const role = t.role && t.role !== 'primary' ? `  (${t.role})` : '';
    return `${t.id}${args}${pad}${role}`;
}

function actionText(a) {
    const args = a.args
        ? `{${Object.entries(a.args).map(([k, v]) => `${k}: ${v}`).join(', ')}}`
        : '';
    return `${a.command}${args}`;
}

function fallbackText(f) {
    if (!f) return null;
    if (f.type === 'goto') return `fallback goto ${f.stepId}`;
    if (f.type === 'show-info') return 'fallback show-info';
    return `fallback ${f.type}`;
}

/**
 * Render one tour as a text graph.
 *
 * `currentIndex` marks the step the caret is in — the reason this pane is worth having open
 * while editing rather than only before publishing.
 */
export function renderStructure(tour, currentIndex = -1) {
    if (!tour) return 'Nothing compiled — fix the errors first.';

    const lines = [];
    const meta = [
        `v${tour.version}`,
        tour.status,
        tour.meta?.category,
        tour.meta?.estimatedMinutes ? `~${tour.meta.estimatedMinutes} min` : null,
    ].filter(Boolean).join('  ·  ');
    lines.push(`<b>${esc(tour.id)}</b>  ·  ${esc(meta)}`);

    const session = tour.session
        ? `session: ${tour.session.contentMode ?? 'user-content'} · onEnd ${tour.session.onEnd ?? 'ask'}`
        : null;
    if (session) lines.push(dim(session));

    for (const a of tour.setup || []) {
        lines.push(`${dim('│')}  ${GLYPH.action} ${accent('setup')}  ${esc(actionText(a))}`);
    }
    lines.push(dim('│'));

    tour.steps.forEach((step, i) => {
        const last = i === tour.steps.length - 1;
        const stem = last ? '└' : '├';
        const rail = last ? ' ' : '│';
        const current = i === currentIndex;

        const head = `${dim(stem)}${dim('─')}${circled(i + 1)} `
            + `<span class="st-step${current ? ' st-current' : ''}" data-step="${i}">${esc(step.id)}</span>`
            + `  ${dim('·')}  ${kind(step.type)}`;
        lines.push(head);

        const row = (glyph, text, cls) =>
            lines.push(`${dim(rail)}  ${dim('│')}  ${glyph} <span class="${cls}">${esc(text)}</span>`);

        for (const a of step.enter || []) row(GLYPH.action, `enter  ${actionText(a)}`, 'st-action');
        for (const t of step.targets || []) row(GLYPH.target, targetText(t), 'st-target');

        const rule = ruleText(step.completion) ?? ruleText(step.waitFor);
        if (rule) row(step.waitFor ? GLYPH.waitFor : GLYPH.completion, rule, 'st-rule');
        if (step.timeoutMs) row(' ', `timeout ${step.timeoutMs}ms`, 'st-dim');
        for (const a of step.exit || []) row(GLYPH.action, `exit  ${actionText(a)}`, 'st-action');

        const advance = step.advance?.mode === 'automatic'
            ? `auto${step.advance.delayMs ? ` ${step.advance.delayMs}ms` : ''}`
            : 'manual';
        const fb = fallbackText(step.fallback);
        lines.push(`${dim(rail)}  ${dim('└─')} next: ${esc(advance)}`
            + (fb ? `      ${GLYPH.fallback} <span class="st-fallback">${esc(fb)}</span>` : ''));

        // Branches are the one thing a linear list of steps cannot show, which is most of the
        // reason to draw a graph at all — a reader scanning the YAML sees `routing:` and has to
        // hold the jump targets in their head.
        for (const br of step.routing?.branches || []) {
            const cond = br.when ? ruleText(br.when) : 'always';
            lines.push(`${dim(rail)}     ${dim('↳')} if ${esc(cond)} `
                + `${dim('→')} <span class="st-goto">${esc(br.goto)}</span>`);
        }
        if (step.routing?.defaultNext) {
            lines.push(`${dim(rail)}     ${dim('↳')} otherwise `
                + `${dim('→')} <span class="st-goto">${esc(step.routing.defaultNext)}</span>`);
        }

        if (!last) lines.push(dim('│'));
    });

    lines.push(`   ${dim('→')}  ${accent('✔ complete')}`);
    return lines.join('\n');
}

/* ── small helpers ───────────────────────────────────────────────────────────────────────── */

function esc(s) {
    return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
const dim = (s) => `<span class="st-dim">${esc(s)}</span>`;
const accent = (s) => `<span class="st-accent">${esc(s)}</span>`;
const kind = (s) => `<span class="st-kind" data-kind="${esc(s)}">${esc(s)}</span>`;

/** ①②③… up to 20, then a plain number — a tour longer than that has other problems. */
function circled(n) {
    const glyph = n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : `(${n})`;
    return `<span class="st-num">${glyph}</span>`;
}
