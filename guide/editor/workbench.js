// Tour authoring workbench — 09-tour-authoring.md §11.
//
// A DEVELOPMENT tool layered on the same YAML model, compiler and schema as the CLI (§11.1).
// It imports the real compilation core rather than reimplementing any rule: "There must not be
// a second, editor-only tour format."
//
// Served only by scripts/guide-workbench-server.mjs, which owns the write endpoint (§11.6).

import { compileTour, compileLocale, Diagnostics } from './compile-core.mjs';
import { completionsFor } from './completion.js';
import { highlight } from './highlight.js';
import { renderStructure } from './structure.js';
import { hoverDoc } from './hover.js';

const $ = (id) => document.getElementById(id);

const els = {
    left: document.querySelector('.wb-left'),
    splitter: $('wb-splitter'),
    source: $('wb-source'),
    highlight: $('wb-highlight'),
    gutter: $('wb-gutter'),
    stepLayer: $('wb-step-layer'),
    complete: $('wb-complete'),
    kind: $('wb-kind'),
    tour: $('wb-tour'),
    locale: $('wb-locale'),
    status: $('wb-status'),
    diagList: $('wb-diag-list'),
    diagSummary: $('wb-diag-summary'),
    stage: $('wb-stage'),
    app: $('wb-app'),
    poiOverlay: $('wb-poi-overlay'),
    pickVeil: $('wb-pick-veil'),
    structure: $('wb-structure'),
    hover: $('wb-hover'),
    json: $('wb-json'),
    jsonBody: $('wb-json-body'),
};

/**
 * Locales a tour can be translated INTO from here. `en` is absent on purpose: it is not a
 * sidecar but the tour's own copy, edited as "tour source".
 *
 * Ukrainian is `ua`, matching the bundle names and KNOWN_LOCALES in guide-compile.mjs — not the
 * standard `uk`. See LANGUAGE_ALIASES in localization.js for why that is debt rather than
 * design; when the bundles are renamed, this list moves with them.
 */
/** Newline, and a matcher for one. Built from char codes so no editor or patch tool can
 *  turn the escape into a literal break in this file. */
const NL = String.fromCharCode(10);
const NL_RX = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));

const TRANSLATABLE_LOCALES = ['ua'];
const LOCALE_NAMES = { ua: 'Ukrainian (ua)' };

const state = {
    registry: null,
    sources: [],
    slug: null,
    // '' = the tour itself; a locale code = that sidecar. Not two editors: a translator works
    // on the same document shape, and a second pane would need its own scroll, gutter and
    // highlight for no gain.
    locale: '',
    // sidecar text per locale for the CURRENT tour, so switching back and forth does not lose
    // unsaved work or re-fetch
    localeDrafts: {},
    lastCompile: null,
    pickMode: null,       // 'target' | 'icon' | null
    poiVisible: false,
    dirty: false,
    tab: 'diagnostics',   // 'diagnostics' | 'structure'
    kind: 'tours',        // 'tours' | 'stories' — which documents the selector lists
    // { base, ext, readOnly, reason } — filled by resolveApi() at boot. Null until then, which
    // is why nothing may fetch before boot awaits it.
    api: null,
};

/* ── boot ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Where the editor lives, as a DIRECTORY url.
 *
 * Derived from this page's own location rather than hardcoded: the workbench is served from
 * <root>/guide/editor/, so the app root is two segments up. Ending in "/" is the part that
 * matters — the app builds its sub-route iframes from `window.location.pathname`
 * (api-ext.js:216/263), and loading it as ".../index.html" makes that pathname "/index.html",
 * so Settings became "/index.html/settings/" and 404'd. Only inside the workbench: a normal tab
 * opens the directory and never sees it.
 */
function appUrl() {
    const here = new URL('.', location.href);          // .../guide/editor/
    const root = new URL('../../', here);              // .../
    // The preview must run in the language being edited, or a translator cannot see their own
    // line wrap in a 360px panel — the thing the preview exists for. `lang` is what the editor
    // reads at boot (entry-point.js) and hands down to the guide iframe.
    const lang = state.locale || 'en';
    return `${root.pathname}?pack=default&lang=${encodeURIComponent(lang)}`;
}

/**
 * Where the workbench's data comes from, and whether this deployment can write.
 *
 * Two deployments exist. The DEV SERVER (scripts/guide-workbench-server.mjs) computes
 * /__guide/registry and /__guide/sources per request and can also save and compile. A STATIC
 * BUILD has no server to run code, so `gulp guide:api` snapshots the two read-only endpoints
 * into api/*.json next to this page and marks itself read-only in api/capabilities.json.
 *
 * Probed rather than configured: the same files are served both ways, so a build-time flag
 * would have to be baked into a file that is otherwise copied untouched. capabilities.json is
 * absent on the dev server — 404 IS the signal that writing is available. It is fetched first
 * precisely because it is the cheap file, so the common dev path costs one failed request.
 */
async function resolveApi() {
    const caps = await fetch('api/capabilities.json')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

    return caps
        ? { base: 'api/', ext: '.json', readOnly: true, reason: caps.reason }
        : { base: '/__guide/', ext: '', readOnly: false, reason: null };
}

/**
 * The workbench API is not answering — almost always "opened over a plain file server, or the
 * dev server was never started".
 *
 * Reported through DIAGNOSTICS rather than only the status line: the status line is one short
 * phrase in a corner, and this needs to say what to actually run. Diagnostics is the pane an
 * author already looks at when something is wrong, so the answer goes where the question is.
 */
function reportApiDown(err) {
    selectTab('diagnostics');
    els.diagList.innerHTML = `
        <li data-level="error">
            <span class="wb-where">—</span>
            <span>The workbench API is not responding. Start the dev server:
                <code>npm run guide:workbench</code>, then reload.</span>
        </li>
        <li data-level="info">
            <span class="wb-where">—</span>
            <span>${escapeHtml(String(err?.message || err))} — a static file server cannot
                serve /__guide/; it needs scripts/guide-workbench-server.mjs.</span>
        </li>`;
    setStatus('workbench API unavailable — run npm run guide:workbench', 'error');
}
async function boot() {
    els.app.src = appUrl();

    installVerdictSink();   // [CR-001] before anything can run a tour
    wireSplitter();
    state.api = await resolveApi();
    const { base, ext } = state.api;

    // Measured against a plain static file server: without this the two fetches below reject,
    // boot() dies on the unhandled rejection, and the editor shows an EMPTY status, an empty
    // diagnostics pane and no error at all — the author is left staring at a blank tool with
    // nothing telling them the dev server is what is missing.
    let registry; let sources; let schema;
    try {
        [registry, sources, schema] = await Promise.all([
            fetch(`${base}registry${ext}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))),
            fetch(`${base}sources${ext}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))),
        // The schema is what knows the PROPERTY NAMES; the registry only knows values. Fetched
        // rather than folded into the registry payload because the schema is GENERATED from that
        // registry — shipping it back inside would be circular. Optional on purpose: a static
        // build without the file still gets value completion, just not property names.
            fetch('../schemas/tour-author.schema.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
    } catch (e) {
        reportApiDown(e);
        return;
    }
    state.registry = registry;
    if (schema) state.registry.schema = schema;
    state.sources = sources.tours;

    if (state.api.readOnly) applyReadOnly();

    if (!state.sources.length) {
        setStatus('no authored tours found', 'error');
        return;
    }

    renderTourOptions();
    selectTour(visibleSources()[0]?.slug ?? state.sources[0].slug);

    wireEditor();
    wireFind();
    wireToolbar();
    buildPoiOverlay();
    fitStage();
}

/* ── source / diagnostics splitter ──────────────────────────────────────────────────────── */

const DEFAULT_EDITOR_RATIO = 2 / 3;
const MIN_EDITOR_HEIGHT = 120;
const MIN_DIAGNOSTICS_HEIGHT = 96;
const SPLITTER_KEY_STEP = 12;
let editorRatio = DEFAULT_EDITOR_RATIO;

/** Apply a ratio while keeping both panes large enough to remain usable. */
function setEditorRatio(ratio) {
    const available = els.left.clientHeight - els.splitter.offsetHeight;
    if (available <= 0) return;

    const minEditor = Math.min(MIN_EDITOR_HEIGHT, available);
    const maxEditor = Math.max(minEditor, available - MIN_DIAGNOSTICS_HEIGHT);
    const editorHeight = Math.min(maxEditor, Math.max(minEditor, available * ratio));

    editorRatio = editorHeight / available;
    els.left.style.setProperty('--wb-editor-height', `${editorHeight}px`);
    els.left.dataset.splitResized = 'true';

    const editorPercent = Math.round(editorRatio * 100);
    els.splitter.setAttribute('aria-valuemin', String(Math.round(minEditor / available * 100)));
    els.splitter.setAttribute('aria-valuemax', String(Math.round(maxEditor / available * 100)));
    els.splitter.setAttribute('aria-valuenow', String(editorPercent));
    els.splitter.setAttribute(
        'aria-valuetext',
        `YAML editor ${editorPercent}%, diagnostics ${100 - editorPercent}%`,
    );
}

function wireSplitter() {
    let pointerId = null;
    let grabOffset = 0;

    const finishDrag = () => {
        if (pointerId === null) return;
        pointerId = null;
        els.splitter.dataset.dragging = 'false';
        document.body.classList.remove('wb-resizing');
    };

    els.splitter.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        pointerId = event.pointerId;
        grabOffset = event.clientY - els.splitter.getBoundingClientRect().top;
        els.splitter.setPointerCapture(pointerId);
        els.splitter.dataset.dragging = 'true';
        document.body.classList.add('wb-resizing');
    });

    els.splitter.addEventListener('pointermove', (event) => {
        if (event.pointerId !== pointerId) return;
        const available = els.left.clientHeight - els.splitter.offsetHeight;
        const editorHeight = event.clientY - els.left.getBoundingClientRect().top - grabOffset;
        setEditorRatio(editorHeight / available);
    });

    els.splitter.addEventListener('pointerup', finishDrag);
    els.splitter.addEventListener('pointercancel', finishDrag);
    els.splitter.addEventListener('lostpointercapture', finishDrag);

    els.splitter.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const available = els.left.clientHeight - els.splitter.offsetHeight;
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        setEditorRatio(editorRatio + direction * SPLITTER_KEY_STEP / available);
    });

    els.splitter.addEventListener('dblclick', () => setEditorRatio(DEFAULT_EDITOR_RATIO));
    window.addEventListener('resize', () => setEditorRatio(editorRatio));

    setEditorRatio(DEFAULT_EDITOR_RATIO);
}

/**
 * The documents the kind switch is currently showing.
 *
 * A story card is a tour whose steps are story steps — there is no file-level flag, because
 * there is one schema and `kind` distinguishes a STEP (SPEC-story-cards §2). Deciding from the
 * steps is what keeps the two from drifting into separate formats.
 */
function visibleSources() {
    const stories = state.kind === 'stories';
    return state.sources.filter((t) => !!t.hasStorySteps === stories);
}

function renderTourOptions() {
    const visible = visibleSources();
    els.tour.innerHTML = visible.length
        ? visible.map((t) => `<option value="${t.slug}">${escapeHtml(t.slug)}</option>`).join('')
        : '<option value="">— none yet —</option>';
}

/**
 * Switch between tours and story cards. The editor, the schema and the compiler are the same
 * for both; only the list narrows.
 */
function selectKind(kind) {
    state.kind = kind === 'stories' ? 'stories' : 'tours';
    els.kind.value = state.kind;
    renderTourOptions();

    const first = visibleSources()[0];
    if (first) selectTour(first.slug);
    else setStatus(state.kind === 'stories'
        ? 'no story cards yet — a card is a tour whose steps use `kind: story`'
        : 'no tours found', 'warn');
}

function selectTour(slug) {
    const entry = state.sources.find((t) => t.slug === slug);
    if (!entry) return;
    state.slug = slug;
    els.tour.value = slug;
    // Start from what is on disk; edits live here until saved, so switching locale and back
    // keeps them.
    state.localeDrafts = { ...(entry.locales || {}) };
    state.locale = '';
    renderLocaleOptions();
    setSource(entry.source);
    state.tourId = currentTourId();
    state.dirty = false;
    render();
}

/**
 * Fill the document selector for the current tour.
 *
 * Rebuilt per tour rather than written once in the HTML so each option can say whether that
 * translation exists yet — "start it" and "open it" are different actions, and a translator
 * arriving at a tour wants to know which one they are about to take without opening the file.
 */
function renderLocaleOptions() {
    const drafts = state.localeDrafts || {};
    const options = [['', 'Edit: tour source (en)']];
    for (const code of TRANSLATABLE_LOCALES) {
        const has = typeof drafts[code] === 'string' && drafts[code].trim().length > 0;
        options.push([code, `Edit: ${LOCALE_NAMES[code] ?? code} ${has ? '✓' : '— not started'}`]);
    }
    els.locale.innerHTML = options
        .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('');
    els.locale.value = state.locale;
}

/**
 * Switch the editor between the tour and one of its translations.
 *
 * The current text is kept in `localeDrafts` (or written back to the tour entry) rather than
 * discarded, because a translator comparing two files switches constantly and losing a
 * half-finished paragraph to a dropdown is not a tradeoff worth making.
 */
function selectLocale(code) {
    // Resolve the id from the document itself, every time. `entry.id` is whatever /__guide/
    // sources reported when the page loaded: stale if the author has since typed an `id:`, and
    // absent entirely for a workbench tab opened before the endpoint started sending it — which
    // is exactly how a correct tour got told it had no id.
    state.tourId = currentTourId();

    // A sidecar is named after the tour's `id`. Without one there is no file to edit, and
    // entering the mode anyway produced diagnostics about `ua/undefined.yaml` and — worse — let
    // the next switch write the translation back over the TOUR's own source. Refusing here is
    // the difference between an unavailable feature and a destroyed document.
    if (code && !state.tourId) {
        setStatus('this tour has no `id:` yet — add one before translating it', 'error');
        els.locale.value = state.locale;
        return;
    }

    stashCurrentDocument();
    state.locale = code;
    els.locale.value = code;

    if (!code) {
        setSource(state.sources.find((t) => t.slug === state.slug)?.source ?? '');
    } else {
        const draft = state.localeDrafts[code];
        // A draft that still looks like the TOUR is not a translation: it is the tour's own text
        // that an earlier bug stashed under a locale key. Taking it would put `steps:` as a LIST
        // into the sidecar compiler, which reports "unknown step 0..7" — the symptom that kept
        // coming back. Discard it and start from the skeleton instead.
        const usable = typeof draft === 'string' && !/^format:\s*\S/m.test(draft) ? draft : null;
        if (draft && !usable) {
            console.warn('[workbench] discarding a stashed draft that is tour source, not a translation');
            delete state.localeDrafts[code];
        }
        setSource(usable ?? localeSkeleton());
    }
    // A locale switch changes the language the preview runs in, so the app reloads with it.
    els.app.src = appUrl();
    render();
}

/**
 * The current tour's id, read from the tour text rather than from a cached field.
 *
 * Prefers the compiler's own parse; falls back to a line match so an id typed into a document
 * that does not yet compile still counts — an author adding `id:` to a new tour is the case
 * that matters most here.
 */
function currentTourId() {
    const compiled = state.lastCompile?.tour?.id;
    if (compiled) return compiled;
    const text = state.locale
        ? (state.sources.find((t) => t.slug === state.slug)?.source ?? '')
        : els.source.value;
    return /^id:\s*(\S+)/m.exec(text)?.[1]
        ?? state.sources.find((t) => t.slug === state.slug)?.id
        ?? null;
}

function stashCurrentDocument() {
    if (state.locale) {
        state.localeDrafts[state.locale] = els.source.value;
        return;
    }
    const entry = state.sources.find((t) => t.slug === state.slug);
    if (!entry) return;
    // Guard against writing a SIDECAR back as the tour. The two documents have different
    // shapes — a tour has `format:` and a `steps:` LIST, a sidecar has a `steps:` MAP — so a
    // text that lost its `format:` line is not a tour, whatever `state.locale` currently says.
    // Getting this wrong once left a translation sitting in the tour's editor with eight
    // "unknown step 0..7" errors and no undo that reached back past it.
    if (!/^format:\s*\S/m.test(els.source.value) && /^format:\s*\S/m.test(entry.source)) {
        console.warn('[workbench] refusing to stash a non-tour document as the tour source');
        return;
    }
    entry.source = els.source.value;
}

/**
 * A starting sidecar for a tour that has none: every translatable key, empty, with the English
 * original quoted above it.
 *
 * Written from the CURRENT compile rather than from a template, so it can never list a key the
 * tour does not have. The English text is a comment, not a value — a sidecar prefilled with
 * English compiles clean and ships untranslated, which is the failure mode a translator is
 * least likely to notice.
 */
function localeSkeleton() {
    const content = state.lastCompile?.content;
    const tourId = state.tourId;
    // Callers must not reach here without an id (selectLocale refuses), so this is about the
    // tour not compiling: a skeleton is derived from the compiled content, and there is none.
    if (!tourId) return `# this tour has no \`id:\` — a sidecar is named after it${NL}`;
    if (!content) {
        return `# ${state.slug} does not compile yet, so its keys are unknown.${NL}`
            + `# Fix the tour source first, then come back.${NL}`;
    }

    const lines = [
        `# ${state.locale}/${tourId}.yaml — translation of ${state.slug}`,
        '#',
        '# Type between the quotes. The quotes are not decoration: without them a colon, a',
        '# leading quote or a # in ordinary prose is YAML syntax, and the file stops parsing',
        '# ("Увага: рух" is a nested mapping). Worse, some prose parses CLEANLY and loses text:',
        '# "Крок #1" becomes "Крок", and a leading & becomes null. Keep every value quoted.',
        '#',
        '# A key left empty is skipped by the compiler and reads as English at runtime, so a',
        '# half-finished file is a half-translated tour rather than a blank one. Empty means',
        '# untranslated: to leave a key for later, leave it empty or delete its line — both',
        '# fall back. There is no way to translate something TO empty, by design.',
        '',
    ];
    const prefix = `tour.${tourId}.`;
    // `fallback` is matched as its own group rather than folded into the field name: a step's
    // fallback copy nests UNDER the step in a sidecar (`steps.<id>.fallback.title`), and an
    // earlier version of this regex matched only `title|body`, so the six fallback keys of
    // collab-drawing fell through to the meta section as flat `step.x.fallback.title:` lines —
    // which compileLocale does not read at all. The skeleton must only ever offer keys the
    // sidecar format can actually carry.
    const stepKey = /\.step\.([^.]+)\.(?:(fallback)\.)?(title|body)$/;
    const meta = [];
    const steps = new Map();

    for (const [key, english] of Object.entries(content)) {
        if (!key.startsWith(prefix)) continue;
        const m = stepKey.exec(key);
        if (!m) { meta.push([key.slice(prefix.length), english]); continue; }

        const [, stepId, isFallback, field] = m;
        if (!steps.has(stepId)) steps.set(stepId, { fields: {}, fallback: {} });
        (isFallback ? steps.get(stepId).fallback : steps.get(stepId).fields)[field] = english;
    }

    for (const [field, english] of meta) {
        lines.push(`# ${english}`, `${field}: ""`, '');
    }
    if (steps.size) {
        lines.push('steps:');
        for (const [id, { fields, fallback }] of steps) {
            lines.push(`  ${id}:`);
            for (const [field, english] of Object.entries(fields)) {
                lines.push(`    # ${String(english).split(NL)[0]}`, `    ${field}: ""`);
            }
            if (Object.keys(fallback).length) {
                // Shown when the step's target cannot be found. Worth translating: it appears
                // exactly when the reader is already stuck.
                lines.push('    fallback:');
                for (const [field, english] of Object.entries(fallback)) {
                    lines.push(`      # ${String(english).split(NL)[0]}`, `      ${field}: ""`);
                }
            }
            lines.push('');
        }
    }
    return lines.join(NL);
}

/* ── editing ─────────────────────────────────────────────────────────────────────────────── */

function wireEditor() {
    els.source.addEventListener('input', () => {
        // The journal on screen belongs to the tour that was compiled and previewed; the moment
        // the text changes it describes a version that no longer exists, while the thing the
        // author now needs — whether their edit parses — is in Diagnostics.
        //
        // Only FROM Events, and only on the first keystroke of an edit: someone sitting on
        // Structure chose that deliberately, and yanking a tab away mid-read is worse than a
        // stale one.
        if (!state.dirty && state.tab === 'events') selectTab('diagnostics');
        state.dirty = true;
        render();
        maybeComplete();
    });

    // The highlight layer sits behind the textarea; it has to follow the same scroll or the
    // glyphs separate from the caret the moment the file is longer than the pane.
    els.source.addEventListener('scroll', syncScroll);
    els.source.addEventListener('keydown', onEditorKey);
    els.source.addEventListener('blur', () => hideCompletion());
    els.source.addEventListener('click', () => { hideCompletion(); renderStructurePane(); });
    els.source.addEventListener('keyup', (e) => {
        // arrows and Home/End move the caret without changing the text, so `input` never fires
        if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp'
            || e.key === 'PageDown') renderStructurePane();
    });
    els.gutter.addEventListener('click', onGutterClick);
    // [BUG-010 §2] every way the caret can move: typing, clicking, arrow keys, selection.
    for (const ev of ['keyup', 'click', 'input', 'select']) {
        els.source.addEventListener(ev, renderCaretLine);
    }
    document.addEventListener('selectionchange', () => {
        if (document.activeElement === els.source) renderCaretLine();
    });
    wireHover();
}

function syncScroll() {
    els.highlight.scrollTop = els.source.scrollTop;
    els.highlight.scrollLeft = els.source.scrollLeft;
    // the gutter scrolls vertically only — it must not drift sideways with long lines
    els.gutter.scrollTop = els.source.scrollTop;
    // The find marks are a THIRD layer over the same text; leaving it out of here left the
    // highlights behind as soon as the document scrolled.
    const find = $('wb-find-layer');
    if (find) {
        find.scrollTop = els.source.scrollTop;
        find.scrollLeft = els.source.scrollLeft;
    }
    // The step badges are a fourth layer over the same text, but only the VERTICAL half of
    // that mirroring is wanted. Each badge must stay on its line — hence scrollTop — while
    // staying pinned to the right edge of the VIEW rather than to a column of text, so its
    // scrollLeft is deliberately left at 0. Mirroring it dragged every badge off with the
    // glyphs (measured: 14px from the pane edge at scrollLeft 0, 414px at 400).
    if (els.stepLayer) els.stepLayer.scrollTop = els.source.scrollTop;
}

function onEditorKey(e) {
    if (!els.complete.hidden) {
        // While the popup is open it owns these keys, so typing continues to feel like an
        // editor rather than like a dialog that stole the arrow keys.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            moveCompletion(e.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            acceptCompletion();
            return;
        }
        if (e.key === 'Escape') { hideCompletion(); return; }
    }

    if (e.key === 'Escape' && state.pickMode) { e.preventDefault(); endPickMode(); return; }

    // Ctrl+F is usually claimed by the browser, so the toggle icon in the pane corner is the
    // control that is actually discoverable. This stays for the browsers that pass it through.
    if (e.key === 'f' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openFind(); return; }

    // Ctrl+Space: ask for completion explicitly, the shortcut every editor uses.
    if (e.code === 'Space' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        maybeComplete(true);
        return;
    }

    // A plain Space on an otherwise EMPTY indented line offers that block's properties.
    //
    // Sitting on a fresh line inside `launch:` or a step, an author has to know what may go
    // there; Ctrl+Space answers that but only if you know to press it. The indentation already
    // says which block the caret is in, so the space that finishes the indent is a natural
    // moment to show what belongs.
    //
    // Strictly whitespace-only before the caret. Anywhere else a space is prose or the gap
    // after a colon, and popping a list there would fight the typing.
    if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el = els.source;
        const from = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
        const head = el.value.slice(from, el.selectionStart);
        if (el.selectionStart === el.selectionEnd && head.length && /^[ \t]+$/.test(head)) {
            // let the space land first, so the caret sits at the indent the block is read from
            setTimeout(() => maybeComplete(true), 0);
        }
    }

    // Enter keeps the current line's indentation, which in YAML is not a convenience but the
    // structure itself: a new key typed at column 0 silently leaves the block it was meant to
    // join. A plain textarea returns the caret to column 0 every time, so every nested line had
    // to be re-indented by hand.
    //
    // A line that OPENS a block indents one level further, because that is the only place the
    // next line can legally go: `steps:`, `- id: x` (a list item's own keys sit inside it), and
    // a block scalar `body: |`. Everything else simply matches the line above.
    if (e.key === 'Enter' && !e.shiftKey) {
        const el = els.source;
        const lineStart = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
        const line = el.value.slice(lineStart, el.selectionStart);
        const indent = /^[ \t]*/.exec(line)[0];
        // `key:` with nothing after it, `- ` starting an item, or a block scalar introducer
        const opensBlock = /(^\s*-\s|:\s*$|:\s*[|>][-+0-9]*\s*$)/.test(line);
        e.preventDefault();
        insertAtCursor('\n' + indent + (opensBlock ? '  ' : ''));
        return;
    }
    if (e.key === 'Tab') {
        // A YAML editor that inserts a literal tab produces a file YAML cannot parse — tabs are
        // forbidden for indentation by the spec. Two spaces is what the authored files use.
        e.preventDefault();
        insertAtCursor('  ');
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveAndCompile(); }
}

/**
 * Every programmatic edit goes through here, and every one of them uses execCommand.
 *
 * `el.value = ...` and `setRangeText()` both WIPE the browser's native undo stack, which is why
 * Ctrl+Z stopped working after a pick or a POI click. `execCommand('insertText')` is formally
 * deprecated but is still the only way to write into a textarea as if the user had typed —
 * every browser keeps it working for exactly this reason, and there is no replacement API.
 *
 * Returns false if the edit could not be applied, so callers can fall back rather than
 * silently doing nothing.
 */
function replaceRange(from, to, text) {
    const el = els.source;
    el.focus();
    el.setSelectionRange(from, to);

    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
        // Fallback for a browser that has finally dropped execCommand: correctness of the
        // document beats preservation of the undo stack.
        el.setRangeText(text, from, to, 'end');
        el.dispatchEvent(new Event('input'));
    }
    return true;
}

function insertAtCursor(text) {
    replaceRange(els.source.selectionStart, els.source.selectionEnd, text);
}

/**
 * Undo/Redo through the textarea's native history.
 *
 * execCommand does not fire `input` for undo/redo in every browser, so render() is called
 * explicitly — without it the text would change while the highlight layer, the gutter and the
 * diagnostics still described the previous version.
 */
function historyCommand(which) {
    els.source.focus();
    document.execCommand(which);
    state.dirty = true;
    render();
}

/* ── compile + render ────────────────────────────────────────────────────────────────────── */

/**
 * Compile on every keystroke, using the REAL compiler (§11.2 "live diagnostics using the
 * compiler library"). It is a pure function over a small string, so there is nothing to debounce
 * — and a debounce would mean the diagnostics briefly describe text that is no longer on screen.
 */
function render() {
    const source = els.source.value;

    // Find offsets belong to the document's CURRENT text. Previously only typing in the find
    // box rebuilt them; an edit in the YAML left both the count and the offsets from the old
    // text, so Next selected the wrong range (or nothing) after an anchor was added/removed.
    refreshFind(source);

    // A sidecar is not a tour and must not be compiled as one: compileTour would report a
    // missing `format`, `id` and every step, burying the one diagnostic a translator needs
    // (a key for a step that does not exist). The tour's own compile stays on screen —
    // diagnostics about the tour are still true while its translation is being edited.
    if (state.locale) return renderLocale(source);

    let result;
    try {
        result = compileTour(source, `${state.slug}.tour.yaml`, state.registry);
    } catch (e) {
        // A crash in the compiler must not take the editor with it: the author is mid-keystroke
        // and the half-typed document that caused it is exactly what they need to keep editing.
        setStatus(`compiler error: ${e.message}`, 'error');
        return;
    }
    state.lastCompile = result;

    // The trailing space matters: a <pre> collapses a final newline while a textarea keeps it,
    // so the highlight layer rendered one line shorter than the text it mirrors (measured 1826
    // vs 1845 scrollHeight). That desynchronised the two scrollHeights, and with it the scroll
    // position once the file was longer than the pane.
    els.highlight.innerHTML = `${highlight(source, state.registry)} `;
    renderStepBadges();
    syncScroll();
    renderDiagnostics(result.diag);
    renderGutter(result.diag);
    renderStructurePane();
    syncPoiOverlay();
}

/**
 * Live diagnostics for a translation, through the same compileLocale() the CLI uses (§11.1).
 *
 * Needs the tour's step ids to tell a translated step from a typo, so it recompiles the tour
 * from what is on disk — not from the editor, which is holding the sidecar right now.
 */
function renderLocale(source) {
    const entry = state.sources.find((t) => t.slug === state.slug);
    const diag = new Diagnostics(`${state.locale}/${state.tourId}.yaml`);
    try {
        const tourResult = compileTour(entry?.source ?? '', `${state.slug}.tour.yaml`, state.registry);
        // previewCurrentStep() reads state.lastCompile regardless of which document is on
        // screen — without this it kept whatever the tour last compiled to BEFORE the switch
        // to locale mode, and Preview from a sidecar edit could run stale steps. This tour
        // recompile already exists for the translated-key count above; reusing it here is
        // the same information Preview needs, just recorded where it looks.
        if (tourResult.tour) state.lastCompile = tourResult;
        const stepIds = new Set((tourResult.tour?.steps ?? []).map((st) => st.id));
        const translated = compileLocale(
            source, state.tourId, stepIds, `${state.locale}/${state.tourId}.yaml`, diag,
        );
        const done = Object.values(translated).filter((v) => String(v).trim()).length;
        const total = Object.keys(tourResult.content ?? {}).length;
        setStatus(diag.errors.length
            ? `${diag.errors.length} error(s)`
            : `${done}/${total} keys translated${state.dirty ? ' — unsaved' : ''}`,
        diag.errors.length ? 'error' : 'ok');
    } catch (e) {
        // A YAML syntax error arrives as a THROW, not as a diagnostic — and ordinary translated
        // prose produces them: `Увага: рух` is a nested mapping, a leading `"` starts a quoted
        // scalar. Reporting it in the diagnostics pane, where the translator is already looking,
        // beats a one-line status they have to notice.
        diag.error(`${e.message.split(NL_RX)[0]} — quote the value: title: "…"`);
        renderDiagnostics(diag);
        renderGutter(diag);
        setStatus('1 error(s)', 'error');
        els.highlight.innerHTML = `${escapeHtml(source)} `;
        // The document did not parse, so the line-to-step map is unknowable — stale badges
        // would point at lines that have since moved.
        if (els.stepLayer) els.stepLayer.innerHTML = '';
        syncScroll();
        return;
    }

    // highlight() with NO registry, not escapeHtml(): a sidecar has no `target`/`command`/
    // `event` keys, so the tour-only binding roles never fire, and the registry argument only
    // exists to resolve those — passing it here would risk a stray "unresolved" on a sidecar
    // key that happens to share a binding-key name. What DOES apply: keys still colour by role
    // (title/body/description are already `copy`, unknown keys default to `identity`, which
    // covers every step id like `speed:`), quoted strings, and {icon:...} tokens — a translator
    // typing `{icon:gear}` gets the same visual confirmation an author does in the tour.
    els.highlight.innerHTML = `${highlight(source, null)} `;
    // A sidecar has steps too — spelled `<id>:` rather than `- id: <id>` — and stepStartLines()
    // reads state.locale to know which shape to look for, so the badges work in both documents.
    renderStepBadges();
    syncScroll();
    renderDiagnostics(diag);
    renderGutter(diag);
    // Structure describes the tour's step graph, which a sidecar does not have. Leaving the
    // previous render on screen makes it look like it describes what is being edited.
    els.structure.innerHTML = '<p class="wb-empty">Structure applies to the tour source, '
        + 'not to a translation.</p>';
}

function renderDiagnostics(diag) {
    const items = diag.items;
    els.diagList.innerHTML = items.map((i, idx) => `
        <li data-level="${i.level}" data-idx="${idx}">
            <span class="wb-where">${i.line ? `${i.line}:${i.col}` : '—'}</span>
            <span>${escapeHtml(i.message)}</span>
        </li>`).join('');

    for (const li of els.diagList.querySelectorAll('li')) {
        li.addEventListener('click', () => gotoLine(items[Number(li.dataset.idx)].line));
    }

    const errors = diag.errors.length;
    const warnings = diag.warnings.length;
    els.diagSummary.textContent = errors || warnings
        ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`
        : 'No diagnostics';
    setStatus(errors ? `${errors} error${errors === 1 ? '' : 's'}` : (state.dirty ? 'unsaved' : 'ok'),
        errors ? 'error' : (state.dirty ? '' : 'ok'));

    // Discard only exists while there is something to discard: an always-visible button that
    // does nothing most of the time is noise, and next to Save it is one that destroys work.
    const discard = $('wb-discard');
    if (discard) discard.hidden = !state.dirty;
}

/* ── find in document ───────────────────────────────────────────────────────────────────── */

/**
 * Find-in-document, drawn into a layer of its own.
 *
 * The marks are NOT injected into the syntax-highlighted HTML: that markup is full of tags,
 * and splicing <mark> into it by string offset would land inside one sooner or later. Instead
 * a second <pre> mirrors the same text with everything transparent except the hits, sitting
 * between the highlight layer and the (transparent-background) textarea.
 *
 * Case-insensitive substring, not a regex: an author searching for `frame.count` should not
 * have to know that `.` means something.
 */
let findState = { query: '', hits: [], index: 0 };

function openFind() {
    const box = $('wb-find');
    if (!box) return;
    box.hidden = false;
    // The toggle and the box occupy the same corner, so only one of them is ever on screen.
    const toggle = $('wb-find-toggle');
    if (toggle) { toggle.hidden = true; toggle.setAttribute('aria-expanded', 'true'); }
    // Searching is navigating, and Structure is the map of where a match will land — a
    // diagnostics list has nothing to say about it.
    selectTab('structure');
    const input = $('wb-find-input');
    input.focus();
    input.select();
}

function toggleFind() {
    const box = $('wb-find');
    if (box && !box.hidden) closeFind();
    else openFind();
}

function closeFind() {
    const box = $('wb-find');
    if (box) box.hidden = true;
    const toggle = $('wb-find-toggle');
    if (toggle) { toggle.hidden = false; toggle.setAttribute('aria-expanded', 'false'); }
    findState = { query: '', hits: [], index: 0 };
    renderFindMarks(els.source.value);
    els.source.focus();   // closing hands the document back
}

/** Every match offset for the current query, in document order. */
function findHits(text, query) {
    if (!query) return [];
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    const out = [];
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
        out.push(i);
        if (out.length > 2000) break;   // a one-character query on a long file
    }
    return out;
}

function renderFindMarks(text) {
    const layer = $('wb-find-layer');
    if (!layer) return;
    const { query, hits, index } = findState;
    if (!query || !hits.length) { layer.innerHTML = ''; return; }

    // Mirror the text exactly — same characters, same wrapping — so the marks land where the
    // glyphs are. Everything but the marks is transparent.
    let html = '';
    let at = 0;
    hits.forEach((start, i) => {
        const end = start + query.length;
        html += escapeHtml(text.slice(at, start));
        const cls = i === index ? 'wb-find-hit-current' : 'wb-find-hit';
        html += `<span class="${cls}">${escapeHtml(text.slice(start, end))}</span>`;
        at = end;
    });
    html += escapeHtml(text.slice(at));
    layer.innerHTML = html + ' ';
    syncScroll();
}

/**
 * Scroll a character offset into view.
 *
 * setSelectionRange only scrolls when the textarea has focus, and focus belongs to the search
 * box while stepping — so a match past the fold was selected and never shown. Measured: the
 * caret reached offset 4919 with scrollTop still 0.
 *
 * Line height comes from the computed style rather than a constant: the editor font is set in
 * CSS and a hardcoded number would silently drift from it.
 */
function scrollOffsetIntoView(at) {
    const ta = els.source;
    const before = ta.value.slice(0, at).split(String.fromCharCode(10)).length - 1;
    const cs = getComputedStyle(ta);
    const lineHeight = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.4);
    const y = before * lineHeight;
    const view = ta.clientHeight;
    // only move when it is actually outside, so stepping between near matches stays still
    if (y < ta.scrollTop || y > ta.scrollTop + view - lineHeight * 2) {
        ta.scrollTop = Math.max(0, y - view / 3);
    }
    syncScroll();
}
/** Move the caret to a match so the textarea scrolls it into view. */
function gotoHit(i, keepFocus = true) {
    const { hits, query } = findState;
    if (!hits.length) return;
    findState.index = (i + hits.length) % hits.length;
    const at = hits[findState.index];
    // NO els.source.focus() here. It was needed when the browser did the scrolling, and it
    // cost the search box its focus on every step — measured: after typing "fallback" the
    // input held only "f", because the first keystroke stepped a match and the rest of the
    // word went into the document. scrollOffsetIntoView does the scrolling now, so the
    // selection can be set without ever taking focus away.
    els.source.setSelectionRange(at, at + query.length);
    scrollOffsetIntoView(at);
    if (!keepFocus) els.source.focus();
    renderFindMarks(els.source.value);
    syncScroll();
    $('wb-find-count').textContent = `${findState.index + 1}/${hits.length}`;
}

function runFind(query) {
    findState.query = query;
    findState.hits = findHits(els.source.value, query);
    findState.index = 0;
    const count = $('wb-find-count');
    if (count) {
        count.textContent = !query ? '' : (findState.hits.length ? `1/${findState.hits.length}` : 'none');
    }
    setFindStepsEnabled(findState.hits.length > 0);
    if (findState.hits.length) gotoHit(0);
    else renderFindMarks(els.source.value);
}

/** Keep an open find session truthful while the author edits or switches documents. */
function refreshFind(text) {
    const query = findState.query;
    if (!query) {
        renderFindMarks(text);
        setFindStepsEnabled(false);
        return;
    }

    const oldOffset = findState.hits[findState.index] ?? els.source.selectionStart;
    const hits = findHits(text, query);
    let index = hits.indexOf(oldOffset);
    if (index === -1 && hits.length) {
        // If an edit moved the old match, keep navigation near the caret instead of jumping to
        // an unrelated first hit. This also makes a tour/locale switch deterministic.
        index = hits.findIndex((offset) => offset >= els.source.selectionStart);
        if (index === -1) index = hits.length - 1;
    }
    findState = { query, hits, index: Math.max(0, index) };

    const count = $('wb-find-count');
    if (count) count.textContent = hits.length ? `${findState.index + 1}/${hits.length}` : 'none';
    setFindStepsEnabled(hits.length > 0);
    renderFindMarks(text);
}

/** Grey out the step arrows when there is nothing to step through. */
function setFindStepsEnabled(on) {
    for (const id of ['wb-find-prev', 'wb-find-next']) {
        const b = $(id);
        if (b) b.disabled = !on;
    }
}
function wireFind() {
    const input = $('wb-find-input');
    if (!input) return;
    input.addEventListener('input', () => runFind(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeFind(); return; }
        if (e.key === 'Enter') { e.preventDefault(); gotoHit(findState.index + (e.shiftKey ? -1 : 1)); }
    });
    $('wb-find-close')?.addEventListener('click', closeFind);
    $('wb-find-toggle')?.addEventListener('click', toggleFind);
    $('wb-find-prev')?.addEventListener('click', () => gotoHit(findState.index - 1));
    $('wb-find-next')?.addEventListener('click', () => gotoHit(findState.index + 1));
}
/* ── hover documentation — §10.1 ─────────────────────────────────────────────────────────── */

let hoverTimer = null;

/**
 * Hover targets live in the HIGHLIGHT layer, but the transparent textarea sits on top of it and
 * takes every pointer event. Rather than punching holes in that (which would break selection),
 * the pointer position is translated into the layer underneath with elementFromPoint after
 * hiding the textarea for the duration of one hit-test — the standard trick, and cheap because
 * it runs once per settled hover rather than per mousemove.
 */
function wireHover() {
    els.source.addEventListener('mousemove', (e) => {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => showHover(e.clientX, e.clientY), 350);
    });
    els.source.addEventListener('mouseleave', hideHover);
    els.source.addEventListener('scroll', hideHover);
    els.source.addEventListener('keydown', hideHover);
}

function tokenAt(x, y) {
    // BOTH layers have to be flipped for the probe. The textarea is on top and takes the event;
    // the highlight layer beneath is `pointer-events: none` so it can never intercept a click —
    // which also makes elementFromPoint skip straight past it. Suppressing only the textarea
    // returned the wrapper div every time.
    const src = els.source.style.pointerEvents;
    const hl = els.highlight.style.pointerEvents;
    els.source.style.pointerEvents = 'none';
    els.highlight.style.pointerEvents = 'auto';

    const el = document.elementFromPoint(x, y);

    els.source.style.pointerEvents = src;
    els.highlight.style.pointerEvents = hl;

    const span = el?.closest?.('[data-tok]');
    if (!span || !els.highlight.contains(span)) return null;
    return { tok: span.dataset.tok, kind: span.dataset.kind, status: span.dataset.status, span };
}

function showHover(x, y) {
    const token = tokenAt(x, y);
    if (!token) return hideHover();

    const html = hoverDoc(token, state.registry);
    if (!html) return hideHover();

    els.hover.innerHTML = html;
    els.hover.hidden = false;

    // Place it below the token, flipping above when there is no room — a popup that runs off
    // the bottom of a 190px-tall pane is the same as no popup.
    const r = token.span.getBoundingClientRect();
    const wrap = els.source.parentElement.getBoundingClientRect();
    const h = els.hover.offsetHeight;
    const below = r.bottom - wrap.top + 6;
    const above = r.top - wrap.top - h - 6;

    els.hover.style.top = `${below + h < wrap.height ? below : Math.max(4, above)}px`;
    els.hover.style.left = `${Math.max(4, Math.min(r.left - wrap.left, wrap.width - els.hover.offsetWidth - 8))}px`;
}

function hideHover() {
    clearTimeout(hoverTimer);
    els.hover.hidden = true;
}

/**
 * The structure pane: what the tour IS, beside what is wrong with it.
 *
 * Drawn from the COMPILED tour, not from the YAML — defaults expanded, shorthand resolved — so
 * it describes what will actually run rather than merely agreeing with the text that produced
 * it. Skipped while the tab is hidden: otherwise it is a string build on every keystroke.
 */
function renderStructurePane() {
    if (state.tab !== 'structure') return;
    const tour = state.lastCompile?.tour;
    els.structure.innerHTML = renderStructure(tour, tour ? stepIndexAtCaret(tour) : -1);

    for (const el of els.structure.querySelectorAll('[data-step]')) {
        el.addEventListener('click', () => gotoStep(Number(el.dataset.step)));
    }
}

/** Clicking a step in the graph puts the caret on its `- id:` line. */
function gotoStep(index) {
    const step = state.lastCompile?.tour?.steps[index];
    if (!step) return;
    const at = els.source.value.search(new RegExp(`^\\s*-\\s+id:\\s*${step.id}\\s*$`, 'm'));
    if (at === -1) return;
    gotoLine(els.source.value.slice(0, at).split('\n').length + 1);
}

function selectTab(tab) {
    state.tab = tab;
    $('wb-tab-diag').setAttribute('aria-selected', String(tab === 'diagnostics'));
    $('wb-tab-struct').setAttribute('aria-selected', String(tab === 'structure'));
    $('wb-tab-events').setAttribute('aria-selected', String(tab === 'events'));
    els.diagList.hidden = tab !== 'diagnostics';
    els.structure.hidden = tab !== 'structure';
    $('wb-events').hidden = tab !== 'events';
    if (tab === 'structure') renderStructurePane();
    if (tab === 'events') attachEventJournal();
}

/**
 * [CR-001] Live event journal, in the workbench rather than only in a browser console.
 *
 * A guide step completes on an EVENT, so the question an author actually has — "I pressed the
 * thing, why did the step not advance?" — is only answerable by seeing two facts side by side:
 * what the app emitted, and what the waiting step decided about it. Until now both existed
 * only as console.log in the app frame, which meant opening devtools on a nested iframe and
 * knowing to type GuideEvents.debug(true) first. That is not a tool an author will use.
 *
 * Subscribes directly to the app's GuideEvents rather than scraping console output: the hub is
 * right there through the iframe's window, and its envelope carries origin and sequence, which
 * a console line would make us parse back out of a string.
 */
let eventJournalAttached = false;

/**
 * [CR-001] The verdict sink is installed at BOOT, not when the Events tab is first opened.
 *
 * The runtime posts a verdict for every event a step considers, and the interesting ones
 * happen while the author is clicking around — often before it occurs to them to open the
 * pane. Registering only on first open meant the pane was empty exactly when it was needed
 * and filled up only afterwards. Verdicts are buffered here and drained into the list once
 * the pane exists.
 */
const verdictBuffer = [];

function installVerdictSink() {
    window.__guideStepVerdict = (v) => {
        const row = {
            cls: `wb-ev wb-ev-step ${v.matched ? 'wb-ev-matched' : 'wb-ev-unmatched'}`,
            html: `<span class="wb-ev-n">#${v.sequence}</span>`
                + `<span class="wb-ev-name">step ${v.step} — ${v.matched ? 'COMPLETED' : 'no match'}`
                + `: wants ${v.want}, got ${v.got}</span>`,
        };
        const list = document.getElementById('wb-events-list');
        if (list) appendEventRow(list, row);
        else { verdictBuffer.push(row); while (verdictBuffer.length > 300) verdictBuffer.shift(); }
    };
}

function appendEventRow(list, row) {
    const li = document.createElement('li');
    li.className = row.cls;
    li.innerHTML = row.html;
    list.appendChild(li);
    // Newest at the bottom, scrolled into view: an author watches this WHILE clicking, so the
    // line they just caused must be the one on screen.
    list.scrollTop = list.scrollHeight;
    while (list.children.length > 300) list.removeChild(list.firstChild);
}

function attachEventJournal() {
    const box = $('wb-events');
    if (eventJournalAttached) return;

    const hub = appGlobal('GuideEvents');
    if (!hub?.on) {
        box.innerHTML = '<p class="wb-events-empty">The app frame is not ready yet — reopen this tab in a moment.</p>';
        return;
    }
    eventJournalAttached = true;

    // Turning the app-side journal on too, so the console and this pane agree. An author who
    // opens this tab has asked to see events; making them also find a console switch would be
    // the same omission this pane exists to fix.
    hub.debug?.(true);

    box.innerHTML = '<div class="wb-events-head">'
        + '<button id="wb-events-clear" class="wb-link" type="button">Clear</button>'
        + '<span class="wb-events-hint">Every guide event, and what the waiting step decided.</span>'
        + '</div><ul id="wb-events-list" class="wb-events-list"></ul>';
    const list = $('wb-events-list');
    $('wb-events-clear').addEventListener('click', () => { list.innerHTML = ''; });
    for (const row of verdictBuffer.splice(0)) appendEventRow(list, row);

    // [BUG-019] A hand-kept list silently omits any event added later — `color.selected` was
    // emitted, and satisfied its step, while the pane showed nothing, which is exactly the
    // "did the app say anything?" blindness this pane exists to remove. The registry already
    // derives the real list from the emit() call sites (guide-registry.mjs extractEvents), and
    // the workbench already holds it, so read it from there and fall back to the literal only
    // when the registry is unavailable.
    const EVENTS = (state.registry?.events?.length ? state.registry.events : [
        'command.executed', 'drawing.completed', 'color.selected', 'frame.created', 'frame.moved',
        'gamifier.opened', 'gamifier.closed', 'animation.idle',
        'collaboration.newUser', 'collaboration.roster', 'collaboration.firstInRoom',
        'layer.remoteAdded',
    ]);

    for (const name of EVENTS) {
        hub.on(name, (env) => {
            const detail = env.data && Object.keys(env.data).length
                ? Object.entries(env.data).map(([k, v]) => `${k}=${v}`).join(' ') : '';
            appendEventRow(list, {
                cls: `wb-ev wb-ev-${env.origin}`,
                html: `<span class="wb-ev-n">#${env.sequence}</span>`
                    + `<span class="wb-ev-name">${name}</span>`
                    + `<span class="wb-ev-data">${detail}</span>`
                    + `<span class="wb-ev-origin">${env.origin}</span>`,
            });
        });
    }
}

/**
 * Line numbers, with error/warning markers replacing the number on affected lines.
 *
 * Rebuilt as one innerHTML rather than as absolutely-positioned markers: the gutter is now a
 * real column in the flow, so it scrolls with the text for free instead of needing every
 * marker's `top` recomputed on every scroll event.
 */
function renderGutter(diag) {
    const byLine = new Map();
    for (const i of diag.items) {
        if (!i.line) continue;
        // an error on a line outranks a warning on the same line
        if (byLine.get(i.line) !== 'error') byLine.set(i.line, i.level);
    }

    const total = els.source.value.split('\n').length;
    const rows = [];
    for (let n = 1; n <= total; n++) {
        const level = byLine.get(n);
        rows.push(level
            // The marker doubles as the "clean this line" control (see onGutterClick): one click
            // target rather than a marker plus a separate button crowding a 44px column.
            ? `<span class="wb-gut wb-gut-mark" data-level="${level}" data-line="${n}"
                     title="${level === 'error' ? 'Error' : 'Warning'} on line ${n} — click to clear the offending text">${level === 'error' ? '●' : '▲'}</span>`
            : `<span class="wb-gut" data-line="${n}">${n}</span>`);
    }
    // Joined with NO separator: each row is already a block, and a literal newline between them
    // under `white-space: pre` renders as an extra line box. Measured: 38.75px row pitch against
    // a 19.375px line height — exactly double — so the numbers drifted one line further out of
    // step with every row down the file.
    els.gutter.innerHTML = rows.join('');
    renderCaretLine();   // the rebuild dropped the caret classes — put them back
}

/**
 * Where each step begins in the CURRENT source pane, as 1-based line numbers.
 *
 * One derivation, three consumers (the gutter's caret band, the step badges, and the reader
 * asking "which step is this?"), because three regexes over the same file would drift apart
 * the first time the authoring shape changed.
 *
 * The pane shows either the tour or a locale sidecar, and they spell a step id differently —
 * `  - id: <id>` against a bare `  <id>:` mapping key. The sidecar shape is far too loose to
 * trust alone (`title:` and `body:` match it too), so sidecar candidates are filtered against
 * the tour's real step ids; the same filter is harmless on the tour side and keeps the two
 * branches honest about returning steps IN ORDER.
 *
 * Returns `[]` when there is no compiled tour to check ids against — the callers all treat
 * that as "no step structure to show", which is the correct state while a file is broken.
 */
function stepStartLines(tour = state.lastCompile?.tour) {
    if (!tour?.steps?.length || !els.source) return [];
    const stepIds = new Set(tour.steps.map((s) => s.id));
    const rx = state.locale
        ? /^\s*([a-z0-9-]+):\s*$/
        : /^\s*-\s+id:\s*([a-z0-9-]+)\s*$/;

    const out = [];
    els.source.value.split('\n').forEach((text, i) => {
        const m = rx.exec(text);
        // `n` is the step's position in the COMPILED tour, not in this list, so a badge reads
        // the same number the runtime shows ("STEP 4 OF 9") even if the file holds a step the
        // compiler dropped, or spells them out of order.
        if (m && stepIds.has(m[1])) {
            out.push({ line: i + 1, id: m[1], n: tour.steps.findIndex((s) => s.id === m[1]) + 1 });
        }
    });
    return out;
}

/**
 * The step containing a given 1-based line: `{ line, id, n, from, to }`, or null.
 *
 * `to` is the line before the next step starts — or the last line of the file for the final
 * step, which is what makes the gutter's band cover a step's whole body.
 */
function stepAtLine(line, tour = state.lastCompile?.tour) {
    const starts = stepStartLines(tour);
    let i = -1;
    for (let k = 0; k < starts.length; k++) {
        if (starts[k].line <= line) i = k; else break;
    }
    if (i === -1) return null;   // also covers an empty list: the caret is above the first step
    return {
        ...starts[i],
        from: starts[i].line,
        to: i + 1 < starts.length
            ? starts[i + 1].line - 1
            : els.source.value.split('\n').length,
    };
}


/**
 * Step badges: which step each line belongs to, shown against the text and scrolling with it.
 *
 * Built as a transparent <pre> mirroring the source exactly — the same trick the find marks use
 * (renderFindMarks). The alternative, absolutely-positioned labels, needs every badge's `top`
 * recomputed on every scroll and every edit; mirroring the text means the browser does that
 * placement for free and the badge cannot drift from its line.
 *
 * One badge per step, on the step's FIRST line, floated into the right margin so it never
 * displaces a glyph: the layer must stay character-for-character aligned with the textarea
 * above it, so anything that occupies width would push the rest of the line sideways.
 */
function renderStepBadges() {
    const layer = els.stepLayer;
    if (!layer || !els.source) return;

    const starts = stepStartLines();
    if (!starts.length) { layer.innerHTML = ''; return; }

    const byLine = new Map(starts.map((s) => [s.line, s]));
    const lines = els.source.value.split(String.fromCharCode(10));
    const total = state.lastCompile?.tour?.steps?.length ?? starts.length;
    const html = lines.map((text, i) => {
        const hit = byLine.get(i + 1);
        if (!hit) return escapeHtml(text);
        // The badge is a sibling of the line's text, not a wrapper around it: wrapping would
        // make the mirrored text a different length from the textarea's and break alignment.
        return escapeHtml(text)
            + `<span class="wb-step-badge" data-step="${hit.n}" title="${escapeHtml(hit.id)} — step ${hit.n} of ${total}">`
            + `${hit.n}/${total} ${escapeHtml(hit.id)}</span>`;
    }).join(String.fromCharCode(10));

    layer.innerHTML = html + ' ';
    syncScroll();
}


/**
 * [BUG-010 §2] Mark the line the caret is on, and the step that "Preview step" would run.
 *
 * The caret is not decoration here — it SELECTS THE STEP the preview starts from
 * (stepIndexAtCaret). That made it hidden state driving a visible button, which is how a
 * preview quietly starting from step 9 went unexplained. Showing it turns "which step will
 * this preview?" into something answerable before pressing, not after.
 *
 * Updates classes on the existing rows rather than re-rendering the gutter: renderGutter()
 * rebuilds innerHTML and runs on every diagnostics pass, while this runs on every caret move.
 */
function renderCaretLine() {
    if (!els.gutter || !els.source) return;
    const upto = els.source.value.slice(0, els.source.selectionStart);
    const line = upto.split('\n').length;

    // The step the caret sits in — via the same stepStartLines() the badges use, so the band
    // and the badge can never disagree about where a step begins. (It also fixes a locale
    // sidecar, whose `<id>:` step shape the inline version here never matched.)
    const at = stepAtLine(line);
    const from = at ? at.from : line;
    const to = at ? at.to : line;

    for (const el of els.gutter.children) {
        const n = Number(el.dataset.line);
        el.classList.toggle('wb-gut-caret', n === line);
        el.classList.toggle('wb-gut-step', n >= from && n <= to && n !== line);
    }
}

/**
 * Clicking a marker removes only the OFFENDING TEXT on that line, never the whole line.
 *
 * The distinction is the point: a broken `poi: [bottom-right]{icon:...}` should become
 * `poi: [bottom-right]` again, not vanish. Deleting the line would take the author's own work
 * with it, which is worse than the error.
 *
 * What counts as "offending" is the column the compiler reported: everything from there to the
 * end of the line. That is exactly what the diagnostics in the reported session pointed at —
 * `column 24` on the pasted icon token, `column 5` on the welded-on `target:`.
 */
function onGutterClick(e) {
    const mark = e.target.closest('.wb-gut-mark');
    if (!mark) return;

    const line = Number(mark.dataset.line);
    const items = (state.lastCompile?.diag.items ?? []).filter((i) => i.line === line);
    if (!items.length) return gotoLine(line);

    const value = els.source.value;
    const lines = value.split('\n');
    const lineStart = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    const lineText = lines[line - 1] ?? '';

    // earliest reported column on this line, 1-based; keep at least the indent
    const col = Math.max(1, Math.min(...items.map((i) => i.col ?? 1)));
    const indent = /^[ \t]*/.exec(lineText)[0].length;
    const cut = Math.max(indent, col - 1);

    if (cut >= lineText.length) return gotoLine(line);

    const kept = lineText.slice(0, cut).replace(/\s+$/, '');
    replaceRange(lineStart, lineStart + lineText.length, kept);
    setStatus(`cleared line ${line} from column ${col}`, 'ok');
}

function gotoLine(line) {
    if (!line) return;
    const pos = els.source.value.split('\n').slice(0, line - 1).join('\n').length + 1;
    els.source.focus();
    els.source.setSelectionRange(pos, pos);
    const cs = getComputedStyle(els.source);
    els.source.scrollTop = Math.max(0, (line - 3) * parseFloat(cs.lineHeight));
    syncScroll();
}

/* ── completion — §10.2 ──────────────────────────────────────────────────────────────────── */

let completionState = null;

function maybeComplete(force = false) {
    // completionsFor() reads the TOUR grammar — command ids, query names, target roles. In a
    // sidecar every one of those suggestions is wrong, and accepting one inserts a key the
    // translation format does not have. A translator types prose; there is nothing to complete.
    if (state.locale) return hideCompletion();

    const el = els.source;
    const found = completionsFor(el.value, el.selectionStart, state.registry, force);
    if (!found || !found.items.length) return hideCompletion();

    completionState = { ...found, index: 0 };
    els.complete.innerHTML = found.items.slice(0, 60).map((it, i) => `
        <div role="option" aria-selected="${i === 0}" data-i="${i}">
            <span class="wb-c-id">${escapeHtml(it.id)}</span>
            <span class="wb-c-doc">${escapeHtml(it.doc || '')}</span>
        </div>`).join('');

    for (const row of els.complete.querySelectorAll('[data-i]')) {
        row.addEventListener('mousedown', (e) => {
            e.preventDefault();   // keep focus in the textarea
            completionState.index = Number(row.dataset.i);
            acceptCompletion();
        });
    }

    positionCompletion();
    els.complete.hidden = false;
}

/**
 * Place the popup under the caret. A textarea exposes no caret rectangle, so the position is
 * derived from the caret's line/column and the (monospace) metrics — which is exactly why the
 * editor font is monospace and why both layers share it.
 */
function positionCompletion() {
    const el = els.source;
    const upto = el.value.slice(0, el.selectionStart);
    const line = upto.split('\n').length;
    const col = upto.length - upto.lastIndexOf('\n') - 1;

    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight);
    // `${size} ${family}` rather than cs.font: the shorthand resolves to '' once the metrics
    // are declared as longhands (which they now are, to keep the two layers pixel-identical),
    // and an empty font made canvas measureText fall back to 10px sans-serif — so the popup
    // was placed against a character width that had nothing to do with the editor's.
    const charWidth = measureCharWidth(`${cs.fontSize} ${cs.fontFamily}`);

    const top = parseFloat(cs.paddingTop) + line * lineHeight - el.scrollTop + 4;
    const left = parseFloat(cs.paddingLeft) + col * charWidth - el.scrollLeft;

    // Clamp INSIDE the visible pane, not to 0. `Math.max(0, top)` pinned the popup to the top
    // of the editor whenever the caret was scrolled far enough down for `top` to go negative —
    // which is most of the time in a real file, and is why the completion list looked like it
    // was appearing somewhere unrelated to the cursor, or not at all.
    const maxTop = el.clientHeight - 60;   // keep at least a row of it on screen
    els.complete.style.top = `${Math.max(4, Math.min(top, maxTop))}px`;
    els.complete.style.left = `${Math.max(0, Math.min(left, el.clientWidth - 300))}px`;
}

let charWidthCache = null;
function measureCharWidth(font) {
    if (charWidthCache?.font === font) return charWidthCache.width;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    const width = ctx.measureText('0'.repeat(64)).width / 64;
    charWidthCache = { font, width };
    return width;
}

function moveCompletion(delta) {
    const rows = [...els.complete.querySelectorAll('[data-i]')];
    if (!rows.length) return;
    completionState.index = (completionState.index + delta + rows.length) % rows.length;
    rows.forEach((r, i) => r.setAttribute('aria-selected', String(i === completionState.index)));
    rows[completionState.index].scrollIntoView({ block: 'nearest' });
}

function acceptCompletion() {
    if (!completionState) return;
    const chosen = completionState.items[completionState.index];
    if (!chosen) return hideCompletion();

    const { from, to } = completionState.range;
    hideCompletion();
    replaceRange(from, to, chosen.insert ?? chosen.id);
}

function hideCompletion() {
    els.complete.hidden = true;
    completionState = null;
}

/* ── toolbar ─────────────────────────────────────────────────────────────────────────────── */

function wireToolbar() {
    els.kind.addEventListener('change', () => {
        // Same guard as the tour selector: switching kind changes the document, and a
        // half-written step is not worth losing to a dropdown.
        if (state.dirty && !confirm('Discard unsaved changes?')) {
            els.kind.value = state.kind;
            return;
        }
        selectKind(els.kind.value);
    });

    els.tour.addEventListener('change', () => {
        if (state.dirty && !confirm('Discard unsaved changes?')) {
            els.tour.value = state.slug;
            return;
        }
        selectTour(els.tour.value);
    });

    // The textarea's own history, reached through the same execCommand path every programmatic
    // edit uses (replaceRange). Focus first: execCommand acts on the focused editable, and
    // clicking a toolbar button has just moved focus off the textarea.
    els.locale.addEventListener('change', () => selectLocale(els.locale.value));

    $('wb-undo').addEventListener('click', () => historyCommand('undo'));
    $('wb-redo').addEventListener('click', () => historyCommand('redo'));

    $('wb-save').addEventListener('click', saveAndCompile);
    $('wb-preview').addEventListener('click', previewCurrentStep);
    $('wb-discard').addEventListener('click', discardEdits);
    $('wb-pick-target').addEventListener('click', () => startPickMode('target'));
    $('wb-pick-icon').addEventListener('click', () => startPickMode('icon'));
    $('wb-poi').addEventListener('click', togglePoi);
    $('wb-tab-diag').addEventListener('click', () => selectTab('diagnostics'));
    $('wb-tab-struct').addEventListener('click', () => selectTab('structure'));
    $('wb-tab-events').addEventListener('click', () => selectTab('events'));
    $('wb-show-json').addEventListener('click', showJson);
    $('wb-viewport').addEventListener('change', (e) => {
        els.stage.dataset.viewport = e.target.value;
        fitStage();
    });

    els.json.querySelector('[data-close]').addEventListener('click', () => els.json.close());
    window.addEventListener('resize', fitStage);
}

/**
 * Shrink a preset when the pane cannot show it at 1:1.
 *
 * `zoom`, NOT `transform: scale()`. Measured, with screenshots: scaling the stage made the
 * embedded editor render as a flat blue rectangle — the canvas kept its correct 1438x897
 * backing size and the app was fine standalone, but a paint-time scale over a live <canvas>
 * inside an iframe composited to nothing usable. `zoom` changes the used values instead, so the
 * iframe lays out and paints at its real size and merely occupies less room.
 *
 * It also removes the need for the negative margins a transform required: `zoom` affects layout,
 * so the box actually shrinks rather than reserving its full footprint.
 *
 * The nominal size comes from this table, never from getComputedStyle: once zoom is applied the
 * computed width is the zoomed width, and re-measuring it would shrink the stage a little more
 * on every resize.
 */
const VIEWPORT_PRESETS = {
    desktop: { width: 1440, height: 900 },
    portrait: { width: 420, height: 860 },
    landscape: { width: 860, height: 420 },
};

function fitStage() {
    const preset = VIEWPORT_PRESETS[els.stage.dataset.viewport] ?? VIEWPORT_PRESETS.desktop;
    const pane = els.stage.parentElement;
    const scale = Math.min(1,
        (pane.clientWidth - 24) / preset.width,
        (pane.clientHeight - 24) / preset.height);

    els.stage.style.zoom = scale >= 1 ? '' : String(scale);
}

async function saveAndCompile() {
    if (!state.locale && state.lastCompile?.diag.errors.length) {
        // Saving a file that cannot compile is legitimate — an author interrupted mid-edit still
        // wants their text on disk — but it must be a deliberate answer, not a silent one.
        if (!confirm('This tour has errors and will not produce runtime JSON. Save the source anyway?')) return;
    }

    // A static build has no write endpoint (§11.6). The button is already disabled, so reaching
    // here means a keyboard shortcut — answer with the reason rather than a network error.
    if (state.api?.readOnly) return setStatus('read-only build — saving needs the dev server', 'error');

    setStatus('saving…');
    // Two endpoints because they write to two places: a sidecar is addressed by locale and tour
    // ID, a tour by slug. Both are followed by the same real compile — a translation that is
    // saved but not compiled is not in ua.json, and the preview would keep showing the old text.
    const save = state.locale
        ? await postJson('/__guide/save-locale', {
            locale: state.locale, tourId: state.tourId, source: els.source.value,
        })
        : await postJson('/__guide/save', { slug: state.slug, source: els.source.value });
    if (save.error) return setStatus(save.error, 'error');
    stashCurrentDocument();
    // the "not started" badge is now stale for whatever was just written
    renderLocaleOptions();

    const compiled = await postJson('/__guide/compile', {});
    state.dirty = false;

    if (!compiled.ok) {
        setStatus(`saved; ${compiled.errors} compile error(s)`, 'error');
        return;
    }
    setStatus(compiled.written.length ? `saved, wrote ${compiled.written.length} file(s)` : 'saved', 'ok');
    // the app iframe is showing artifacts that just changed on disk
    els.app.contentWindow.location.reload();
}

/**
 * Turn the workbench into a reader.
 *
 * A static build ships the UI and the compiled answers but nothing that can write (§11.6). The
 * honest shape for that is a tool that plainly cannot save — disabled, labelled and explained
 * up front — rather than one that looks writable and fails on the click. Everything else the
 * workbench does (open, validate, compile in-browser, preview against the real app) needs no
 * server and keeps working.
 */
function applyReadOnly() {
    const save = $('wb-save');
    if (save) {
        save.disabled = true;
        save.textContent = 'Save (dev only)';
        save.title = state.api.reason;
    }

    document.body.classList.add('wb-readonly');

    // Inserted BEFORE the status/preview/save group rather than appended: .wb-bar is a
    // fixed-height flex row that does not wrap, so anything appended past that group is pushed
    // off the right edge at ordinary widths. Sitting just left of Save also puts the
    // explanation next to the control it explains.
    const status = $('wb-status');
    if (status?.parentNode) {
        const tag = document.createElement('span');
        tag.className = 'wb-readonly-tag';
        tag.textContent = 'read-only build';
        tag.title = state.api.reason;
        status.parentNode.insertBefore(tag, status);
    }
}

function postJson(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then((r) => r.json()).catch((e) => ({ error: String(e.message || e) }));
}

function showJson() {
    const tour = state.lastCompile?.tour;
    els.jsonBody.textContent = tour
        ? JSON.stringify(tour, null, 2)
        : 'Nothing compiled — fix the errors first.';
    els.json.showModal();
}

/* ── reaching into the app iframe ────────────────────────────────────────────────────────── */

/**
 * Read one of the app's top-level bindings.
 *
 * `win.GuideHost` is ALWAYS undefined, and this was a real bug: "Preview step" reported "editor
 * not ready" on a fully loaded editor, and the target picker could never have resolved a manual
 * target either. The app declares `const GuideHost = ...`, `const command = {...}` at the top
 * level of classic <script> files, and a top-level `const` in a classic script creates a
 * SCRIPT-SCOPE binding — it is deliberately not a property of the global object, unlike `var`.
 * Same-origin access to the window therefore cannot see it.
 *
 * `win.eval` evaluates in that scope, so the binding is reachable — it just cannot be reached
 * by property lookup. Nothing is injected into the app to make this work: the workbench is a
 * development tool, and the shipped application should not grow a global for its benefit.
 */
function appGlobal(name) {
    const win = els.app?.contentWindow;
    if (!win) return undefined;
    try {
        return win.eval(`typeof ${name} !== 'undefined' ? ${name} : undefined`);
    } catch (e) {
        return undefined;   // frame navigating, or not loaded yet
    }
}

/* ── preview — §11.2 "start from the selected step" ──────────────────────────────────────── */

/**
 * Launch the compiled tour in the app iframe, at the step the caret is in.
 *
 * Starting from an arbitrary step is the feature that makes iteration bearable — otherwise
 * tuning step 6 means clicking through five steps every time. §15 flags the risk this carries:
 * "selected-step preview does not run earlier destructive setup unexpectedly". Tour `setup`
 * still runs (the scene has to exist), but per-step `enter` actions of skipped steps do not,
 * and that is stated in the status line rather than left for the author to discover.
 */
/**
 * Throw away unsaved edits and reload this tour from disk.
 *
 * Preview runs the COMPILED tour, so unsaved text cannot be previewed at all. Without a way
 * to drop the edits the only exit was to save them, which a read-only build cannot do —
 * leaving the reader stuck behind "save first" with no way to obey it.
 *
 * selectTour() already re-reads the source and clears `dirty`, so this is that, plus the
 * confirmation that an accidental click deserves.
 */
function discardEdits() {
    if (!state.dirty) return;
    if (!confirm('Discard unsaved changes and reload this tour from disk?')) return;
    selectTour(state.slug);
    setStatus('edits discarded', 'ok');
}
function previewCurrentStep() {
    const result = state.lastCompile;
    if (!result?.tour) return setStatus('fix the errors first', 'error');

    if (state.dirty) {
        // The host loads the COMPILED tour from guide/tours/*.json, not the text on screen.
        // Previewing unsaved edits would quietly show the previous version and look like the
        // preview was broken — which is a worse failure than saying so.
        //
        // In a read-only build saving is impossible, so "save first" was a dead end: the only
        // way forward is to throw the edits away, and Discard is the button that does it.
        return setStatus(state.api?.readOnly
            ? 'unsaved edits — Discard to preview the compiled tour (this build cannot save)'
            : 'save first — preview runs the compiled tour, or Discard to drop the edits',
            'error');
    }

    const stepIndex = stepIndexAtCaret(result.tour);
    const win = els.app.contentWindow;
    const host = appGlobal('GuideHost');
    if (!host?.start) return setStatus('editor not ready', 'error');

    win.__guideStartAtStep = stepIndex;   // read by the runtime's preview hook
    host.close?.();
    host.start(state.slug);
    // Previewing means watching what the app emits and what the step decides about it, which
    // is exactly the Events tab. Switching there is the difference between the journal being
    // available and it being SEEN — an author debugging "why won't this advance" should not
    // have to know the tab exists.
    selectTab('events');
    setStatus(stepIndex > 0 ? `preview from step ${stepIndex + 1} (earlier enter actions skipped)` : 'preview');
}

/**
 * [BUG-010] Load text into the editor AND put the caret at the top.
 *
 * Assigning `.value` does not move the caret when the textarea already has a selection, so
 * after switching tours `selectionStart` stayed wherever it was in the PREVIOUS document.
 * "Preview step" reads the caret to decide which step to start from (stepIndexAtCaret), so a
 * freshly opened tour previewed from its LAST step — the `if (!ids.length) return 0` branch
 * that exists for exactly this case never ran, because the caret was not at 0 at all.
 */
function setSource(text) {
    els.source.value = text;
    els.source.selectionStart = els.source.selectionEnd = 0;
}

/**
 * Which step is the caret inside? Derived from the `- id:` lines above it.
 *
 * [BUG-016] The slice ends AT THE CARET, so the last `- id:` line is cut wherever the caret
 * happens to sit — and an author placing it by clicking the step they want lands in the middle
 * of that very line. `- id: select-frame` with the caret after "sele" matched as the id "s",
 * which is no step's id, findIndex returned -1, and the `|| 0` below silently previewed step 1
 * instead. Every "Preview step" from a click on the id line ran the wrong step, and the status
 * line said plain "preview" — the one message that looks like nothing went wrong.
 *
 * Fixed by reading the id from the caret's OWN line in full rather than from the truncated
 * slice: the line is taken whole out of the untruncated text, so a caret anywhere within it
 * yields the same complete id.
 */
function stepIndexAtCaret(tour) {
    const text = els.source.value;
    const caret = els.source.selectionStart;
    // Extend to the end of the caret's line so a partially-typed slice cannot truncate an id.
    const lineEnd = text.indexOf('\n', caret);
    const upto = text.slice(0, lineEnd === -1 ? text.length : lineEnd);

    // Tour source and locale sidecar spell a step id differently: the tour writes
    // `  - id: <id>`, the sidecar writes `  <id>:` as a bare mapping key directly under
    // `steps:`. #wb-source shows one or the other depending on state.locale, so Preview
    // picked step 1 for every sidecar edit until this branched — `- id:` never matches a
    // sidecar line, `ids.length` was always 0. The sidecar pattern is unanchored on
    // indentation (YAML tolerates any consistent indent), so it is checked against the
    // tour's own step ids rather than trusted on shape alone — `title:` or `body:` would
    // match `^\s*([a-z0-9-]+):\s*$` too if id membership were not the filter.
    const stepIds = new Set(tour.steps.map((s) => s.id));
    const rx = state.locale
        ? /^\s*([a-z0-9-]+):\s*$/gm
        : /^\s*-\s+id:\s*([a-z0-9-]+)\s*$/gm;
    const ids = [...upto.matchAll(rx)].map((m) => m[1]).filter((id) => stepIds.has(id));
    if (!ids.length) return 0;
    const idx = tour.steps.findIndex((s) => s.id === ids[ids.length - 1]);
    return idx === -1 ? 0 : idx;
}

/* ── target / icon picker — §11.3 ────────────────────────────────────────────────────────── */

/**
 * The picker inserts SEMANTIC IDS, never CSS selectors (§11.3). It resolves a clicked element by
 * asking the app's own GuideHost.resolveTarget for each candidate id — the same resolver the
 * runtime uses — rather than inventing a second mapping from DOM to semantics. If the resolver
 * changes, the picker follows automatically.
 */
function startPickMode(mode) {
    const win = els.app.contentWindow;
    if (!win?.document) return setStatus('editor not ready', 'error');

    state.pickMode = mode;
    els.pickVeil.hidden = false;
    $(mode === 'target' ? 'wb-pick-target' : 'wb-pick-icon').setAttribute('aria-pressed', 'true');

    win.document.addEventListener('pointerdown', onPickPointerDown, true);
    win.document.addEventListener('keydown', onPickKey, true);
}

function endPickMode() {
    const win = els.app.contentWindow;
    win?.document?.removeEventListener('pointerdown', onPickPointerDown, true);
    win?.document?.removeEventListener('keydown', onPickKey, true);
    els.pickVeil.hidden = true;
    $('wb-pick-target').setAttribute('aria-pressed', 'false');
    $('wb-pick-icon').setAttribute('aria-pressed', 'false');
    state.pickMode = null;
}

function onPickKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endPickMode(); }
}

function onPickPointerDown(e) {
    // Capture phase and swallowed: a pick must not also press the button. Clicking "delete
    // frame" to reference it would otherwise delete a frame.
    e.preventDefault();
    e.stopPropagation();

    const mode = state.pickMode;
    const id = semanticIdAt(e.target);
    endPickMode();

    if (!id) return setStatus('no semantic id for that element', 'error');

    if (mode === 'icon') {
        if (!state.registry.iconCommandIds.includes(id)) {
            // §10.2: offering a command whose icon does not resolve is offering silence.
            return setStatus(`${id} has no icon to show`, 'error');
        }
        // An icon token belongs in COPY (10-content-icons.md §3). Dropping one onto a structural
        // line produces YAML that does not parse — the reported
        // `poi: [bottom-right]{icon:cmd:united_frames_toggle}` is exactly that. Refusing is
        // better than inserting somewhere the author did not mean: the caret after a pick is
        // wherever it last was, which is often not where they were looking.
        if (!caretIsInCopy()) {
            return setStatus('put the caret in a title or body first', 'error');
        }
        insertAtCursor(`{icon:cmd:${id}}`);
        return setStatus(`inserted {icon:cmd:${id}}`, 'ok');
    }

    insertTargetLine(id);
    setStatus(`inserted target ${id}`, 'ok');
}

/**
 * Is the caret somewhere an icon token is legal — a `title:` value, or inside a `body: |` block?
 *
 * Structural lines (`target:`, `poi:`, `kind:`, `complete:`) are not copy, and a token there is
 * both meaningless and a YAML syntax error.
 */
function caretIsInCopy() {
    const value = els.source.value;
    const caret = els.source.selectionStart;
    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    const line = value.slice(lineStart, caret);

    if (/^\s*(title|body):/.test(line)) return true;

    // Inside a block scalar: walk back to the nearest line with less indentation and check
    // whether it opened one. This is the common case — most icons live in `body: |`.
    const indent = /^[ \t]*/.exec(value.slice(lineStart))[0].length;
    const before = value.slice(0, lineStart).split('\n').reverse();
    for (const prev of before) {
        if (!prev.trim()) continue;
        if (/^[ \t]*/.exec(prev)[0].length >= indent) continue;
        return /^\s*(title|body):\s*[|>]/.test(prev);
    }
    return false;
}

/**
 * Walk up from the clicked node, asking the app's resolver whether any known id resolves to it.
 * `button[name="<id>"]` is how the app addresses its own buttons, so the fast path is reading
 * that attribute; the manual registry needs the resolver.
 */
function semanticIdAt(node) {
    const win = els.app.contentWindow;
    // via appGlobal, not `win.GuideHost` — see the note there. The button branch below worked by
    // accident because it reads a DOM attribute; the manual-target branch never ran at all.
    const host = appGlobal('GuideHost');

    for (let el = node; el && el !== win.document.body; el = el.parentElement) {
        const name = el.getAttribute?.('name');
        if (name && state.registry.commandIds.includes(name)) return name;
    }

    if (!host?.resolveTarget) return null;
    for (const id of state.registry.manualTargets) {
        if (id === 'canvas.frame') continue;   // needs args; picked as `canvas` instead
        const resolved = host.resolveTarget({ id });
        if (resolved?.el && (resolved.el === node || resolved.el.contains(node))) return id;
    }
    return null;
}

/**
 * Insert a `target:` line into the step the caret is in, matching its indentation. Writing the
 * whole line rather than the bare id is what makes the picker useful in an empty step — the
 * author does not have to remember the key name or the indent.
 */
function insertTargetLine(id) {
    const el = els.source;
    const value = el.value;
    const caret = el.selectionStart;
    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = value.indexOf('\n', caret);
    if (lineEnd === -1) lineEnd = value.length;

    const line = value.slice(lineStart, lineEnd);
    const indent = /^[ \t]*/.exec(line)[0] || '    ';

    // Replace an existing `target:` line rather than adding a second one — a step may have only
    // one, and stacking them is invalid YAML the author then has to clean up by hand.
    if (/^\s*target:/.test(line)) {
        replaceRange(lineStart, lineEnd, `${indent}target: ${id}`);
        return;
    }

    // Otherwise open a NEW line below the current one. The old code inserted at the caret with a
    // leading newline, which split whatever line the caret sat inside — the reported corruption
    // (`poi: [bottom-right]{icon:...}` and a `target:` welded onto the end of another line) came
    // from exactly this: after a pick the caret is wherever it last was, which is rarely a
    // blank line.
    const blank = line.trim() === '';
    if (blank) {
        replaceRange(lineStart, lineEnd, `${indent}target: ${id}`);
    } else {
        replaceRange(lineEnd, lineEnd, `\n${indent}target: ${id}`);
    }
}

/* ── POI overlay — §11.4 ─────────────────────────────────────────────────────────────────── */

const ZONES = [
    'top-left', 'top-center', 'top-right',
    'middle-left', 'middle-center', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right',
];

function buildPoiOverlay() {
    els.poiOverlay.innerHTML = ZONES.map((z) =>
        `<div class="wb-poi-cell" data-zone="${z}">${z.replace('-', '\n')}</div>`).join('');
    for (const cell of els.poiOverlay.querySelectorAll('[data-zone]')) {
        cell.addEventListener('click', () => togglePoiZone(cell.dataset.zone));
    }
}

function togglePoi() {
    state.poiVisible = !state.poiVisible;
    els.poiOverlay.hidden = !state.poiVisible;
    $('wb-poi').setAttribute('aria-pressed', String(state.poiVisible));
    syncPoiOverlay();
}

/** Reflect the caret's step `poi:` list into the grid, so the overlay shows the truth. */
function syncPoiOverlay() {
    if (!state.poiVisible || !state.lastCompile?.tour) return;
    const step = state.lastCompile.tour.steps[stepIndexAtCaret(state.lastCompile.tour)];
    const on = new Set(step?.poi || []);
    for (const cell of els.poiOverlay.querySelectorAll('[data-zone]')) {
        cell.dataset.on = String(on.has(cell.dataset.zone));
    }
}

/**
 * Clicking a cell edits the step's `poi:` list in the SOURCE (§11.5's round-trip requirement in
 * miniature): the YAML stays the single model, so the overlay can never hold state the file
 * does not.
 */
function togglePoiZone(zone) {
    const tour = state.lastCompile?.tour;
    if (!tour) return;
    const step = tour.steps[stepIndexAtCaret(tour)];
    if (!step) return;

    const current = new Set(step.poi || []);
    current.has(zone) ? current.delete(zone) : current.add(zone);
    const list = ZONES.filter((z) => current.has(z));

    writeStepPoi(step.id, list);
}

function writeStepPoi(stepId, zones) {
    const lines = els.source.value.split('\n');
    const stepLine = lines.findIndex((l) => new RegExp(`^\\s*-\\s+id:\\s*${stepId}\\s*$`).test(l));
    if (stepLine === -1) return;

    const indent = /^(\s*)-/.exec(lines[stepLine])[1] + '  ';
    const nextStep = lines.findIndex((l, i) => i > stepLine && /^\s*-\s+id:/.test(l));
    const end = nextStep === -1 ? lines.length : nextStep;
    const poiLine = lines.findIndex((l, i) => i > stepLine && i < end && /^\s*poi:/.test(l));

    const rendered = `${indent}poi: [${zones.join(', ')}]`;

    // Offsets of a whole line, so the edit is a single replaceRange and therefore a single undo
    // step. Rewriting the entire document through `.value` (what this did) wiped the undo stack
    // on every cell click.
    const offsetOf = (lineIndex) =>
        lines.slice(0, lineIndex).reduce((n, l) => n + l.length + 1, 0);

    if (poiLine !== -1) {
        const from = offsetOf(poiLine);
        const to = from + lines[poiLine].length;
        // removing the last zone removes the line, newline included
        if (zones.length) replaceRange(from, to, rendered);
        else replaceRange(from, Math.min(to + 1, els.source.value.length), '');
    } else if (zones.length) {
        const at = offsetOf(end);
        replaceRange(at, at, `${rendered}\n`);
    }
}

/* ── util ────────────────────────────────────────────────────────────────────────────────── */

function setStatus(text, kind = '') {
    els.status.textContent = text;
    els.status.dataset.kind = kind;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

boot().catch((e) => setStatus(`boot failed: ${e.message}`, 'error'));
