"use strict";
// Guide runtime — Stage 0. Lives in the guide iframe (same origin, guide panel only —
// 01-architecture.md). Owns steps/content/navigation state; knows nothing about the host
// DOM. Talks to GuideHost in the parent document over postMessage
// (tilecraft/guide/v1/03-protocol.md).

const GUIDE_PROTOCOL = 'storytilecraft-guide';
const GUIDE_VERSION = '1.0';

// 03-protocol.md "Timeouts". The guide owns these three; the host owns GUIDE_READY and the
// HOST_CLOSING grace period. Commands get the longest budget because many of them animate and
// `await: "completed"` legitimately waits for the pipeline to drain.
const QUERY_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 30000;
const STEP_READY_TIMEOUT_MS = 10000;

/**
 * How long a hint's highlight may stand with nothing dismissing it (CR-01 §4). Long enough to
 * read the card and look for the control, short enough that a rule which never fires cannot
 * leave a ring on the canvas for the rest of the session — the failure BUG-01 was about.
 */
const HINT_DISMISS_TIMEOUT_MS = 10000;

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function qs(name) {
    return new URLSearchParams(location.search).get(name);
}

/**
 * Report how much room this panel's CONTENT needs (08 §6.4).
 *
 * Measuring `.guide-panel`'s bounding box was a feedback loop: the panel is laid out inside a
 * shell the host already sized from the PREVIOUS measurement, so each render reported slightly
 * less than the last and the shell ratcheted down — measured 360 → 328 → 296 across three
 * steps, ending with the completion surface clipped to a sliver (bug report:
 * guide/bug-reports/demo-collab-drawing.md, image2.png shows "D…Close…guide" and nothing else).
 *
 * scrollHeight is the content's own height, independent of the box constraining it, so the
 * measurement no longer depends on its own previous result. Width is taken from the viewport
 * rather than the panel for the same reason.
 *
 * Every surface reports — steps, library, completion, prompts. Only steps did before, so the
 * host kept sizing the shell for whatever step came last and every other surface inherited a
 * box that had nothing to do with its content.
 */
/**
 * Re-measure whenever the panel's content changes, whatever produced it.
 *
 * Wiring this to a MutationObserver rather than to each render site is deliberate: there are
 * eight places that assign innerHTML (steps, library, completion, failure, tour-failed,
 * unavailable, keep/remove, collab warning), only one of which reported its size. Anything
 * added later would have inherited the same omission, and the symptom — a surface rendered
 * into a box sized for something else — is exactly what the bug report shows.
 */
/**
 * Icons are filled from the same observer for the same reason (10-content-icons.md §8): there
 * are eight innerHTML assignments and a ninth will be added one day. Hooking each render site
 * would work today and rot the moment someone adds a surface — which is exactly the omission
 * this observer was introduced to end. `fillIcons` is passed in rather than imported so the
 * function stays DOM-only and testable.
 *
 * Filling icons mutates the subtree and so re-enters this observer, which is CORRECT rather
 * than a loop: icons change the panel's height, and the host must size the shell for the panel
 * as it finally reads. It terminates because the second pass finds no unfilled placeholders,
 * so fillIcons() returns without touching the DOM.
 */
/**
 * The furniture around a scroll area inside `.guide-panel`: 32px of padding, ~34px of header
 * and its margin, and slack for the shadow and rounding. Mirrors the `- 96px` the CSS fallback
 * subtracts, and exists so the two cannot drift apart silently.
 */
const GUIDE_PANEL_CHROME = 96;

/**
 * `#guide-root`'s own padding, top and bottom. It sits OUTSIDE `.guide-panel`, so it is room
 * the panel never gets, and the host's number describes the shell — root included. Subtracting
 * it separately keeps GUIDE_PANEL_CHROME meaning exactly what its own comment says: the
 * furniture inside the panel.
 */
const GUIDE_ROOT_PADDING = 32;

/**
 * How tall a scrollable surface may grow, as a number the HOST measured (BUG-06).
 *
 * The CSS fallback caps against `vh`, which inside this iframe means the EDITOR WINDOW — there
 * is no CSS height here to resolve a percentage against. So the catalog laid out against the
 * window while the shell was sized to something else, and the gap showed up as content spilling
 * past the shell, or as a shell too small for its own panel clipping the rounded corners.
 *
 * Why an external number and not `max-height: 100%` on the panel — the fix guide.css §library
 * warns about, twice attempted: bounding by the parent makes `panel.scrollHeight` report the
 * CONSTRAINED BOX. reportPanelSize feeds that to the host, the host shrinks the shell to it,
 * the next measurement reads smaller still, and the panel ratchets to a strip. A number handed
 * in from outside cannot close that loop, because `scrollHeight` keeps measuring content.
 *
 * The expanded library asks for more room than the default (90vh vs 75vh in the fallback), and
 * that is a CONTENT decision the runtime still owns — so the ratio is applied here rather than
 * the host being told which surface is on screen.
 */
let lastAvailableHeight = null;

function applyAvailableHeight(px) {
    const height = Number(px ?? lastAvailableHeight);
    if (!Number.isFinite(height) || height <= 0) return;   // keep the vh fallback
    lastAvailableHeight = height;

    // Read from the DOM rather than a flag: this is called from the host's messages too, which
    // know nothing about which surface is on screen. `.guide-library-expanded` IS the state —
    // showLibrary() renders it from this.libraryExpanded — so the class is the honest source
    // as long as the caller runs AFTER the render, which is why the ⤢ handler recomputes there.
    const expanded = !!document.querySelector('.guide-library-expanded');
    const share = expanded ? 0.9 : 0.75;
    const usable = Math.max(0, height - GUIDE_ROOT_PADDING);
    const max = Math.max(0, Math.round(usable * share) - GUIDE_PANEL_CHROME);
    document.documentElement.style.setProperty('--guide-list-max', `${max}px`);
}

function watchPanelSize(root, send, fillIcons) {
    const observer = new MutationObserver(() => {
        fillIcons?.();
        reportPanelSize(root, send);
    });
    observer.observe(root, { childList: true, subtree: true });
    return observer;
}

/**
 * The collapsed forms (08 §7.5 / §10) are the host's answer to "nothing fits at full size", so a
 * height measured while one is applied describes the host's own constraint, not the content's
 * need. Reporting it re-entered the ratchet this function's header describes, one door further
 * along: the host wrote the collapsed height into `panelSize`, then restored the full form
 * against it and sized the shell to ~20px while `.guide-panel` still laid out at its true 218px
 * (bug report: guide/bug-reports/demo-collab-drawing.md, demo-2-step5-height-20px.png).
 *
 * Stripping the classes for the duration of the measurement makes `scrollHeight` independent of
 * the CURRENT FORM as well as of the current box — the property the earlier fix was reaching for
 * and only half reached. The panel is restored within the same frame, before paint, so the
 * collapsed rendering never flickers.
 */
function measureNaturalHeight(panel) {
    const body = document.body;
    const collapsed = ['guide-compact', 'guide-pill'].filter((c) => body.classList.contains(c));
    for (const c of collapsed) body.classList.remove(c);
    try {
        // The padding belongs to #guide-root, not to body — body has none. Reading it off body
        // added 0, so the shell was sized to the panel alone while the panel had to live INSIDE
        // root's 16px inset: 32px short, and `align-items: flex-end` spent the shortfall by
        // pushing the panel 16px above the top of the iframe. That is where the rounded corners
        // went — measured, panel.top was -16 and the 12px radius sat in the clipped strip.
        const container = panel.parentElement || body;
        const cs = getComputedStyle(container);
        return Math.ceil(panel.scrollHeight
            + parseFloat(cs.paddingTop || 0) + parseFloat(cs.paddingBottom || 0));
    } finally {
        for (const c of collapsed) body.classList.add(c);
    }
}

function reportPanelSize(root, send, stepId) {
    const panel = root.querySelector('.guide-panel');
    if (!panel) return;

    // let layout settle before measuring — innerHTML assignment is synchronous but styles
    // and fonts are not, and a first-paint measurement reads short
    requestAnimationFrame(() => {
        // re-resolve: between the mutation and this frame the surface may have been replaced
        // (loading chrome -> step) or cleared entirely by _renderClosed()
        const live = root.querySelector('.guide-panel');
        if (!live) return;
        // The panel's own height, and nothing added on top.
        //
        // This used to add back the list's hidden overflow (`scrollHeight - clientHeight`) so
        // the host would hear "what the catalog WANTS" and clamp it itself. That was necessary
        // while the list capped itself against `vh` — a number unrelated to the shell — because
        // only the host knew the real ceiling.
        //
        // With BUG-06 the list is capped by a pixel height the host supplied, so it already
        // fits, and adding the overflow back made the host size the shell to a panel that does
        // not exist: measured with 9 tours at 1072px viewport, the panel was 745px and the
        // report was 1379px, so the shell stood 295px taller than its own content. An oversized
        // transparent shell is not cosmetic — it hit-tests, swallowing clicks meant for the
        // editor underneath (the same failure launch() documents for the old full-height frame).
        const height = measureNaturalHeight(live);
        if (!height) return;
        send({
            type: 'GUIDE_SIZE_CHANGED',
            payload: {
                stepId, width: GUIDE_DEFAULT_WIDTH, height,
                // The catalog would rather cover a toolbar than be squeezed into the gap
                // between them: it highlights nothing, so there is nothing for it to hide.
                // Every other surface omits this and keeps the strict no-overlap rule.
                ...(live.classList?.contains('guide-library')
                    ? { placementFallback: 'minimum-overlap' } : {}),
            },
        });
    });
}

// The panel's authored width. Reported rather than measured: the content is fluid and would
// otherwise report whatever the current shell allows, feeding the same loop as height did.
const GUIDE_DEFAULT_WIDTH = 360;

/**
 * ── content icons — 10-content-icons.md ───────────────────────────────────────────────────
 *
 * `{icon:<sprite-id>}` or `{icon:cmd:<command-id>}`, written inside TRANSLATION STRINGS rather
 * than as a tour JSON field: word order differs between languages, so only the sentence knows
 * where its icon goes (§3).
 *
 * The character class is deliberately narrow — the same shape catalog.js uses for slugs. A
 * token can name a sprite or a command and nothing else: no `<`, no quote, no attribute, no
 * path separator. That is half of §7's injection boundary; the other half is that the markup
 * is composed by the host from cloned sprite children and never echoes caller input.
 */
const GUIDE_ICON_RX = /\{icon:(cmd:)?([a-z0-9_-]+)\}/g;

/**
 * What may be built into an icon token — the same grammar GUIDE_ICON_RX accepts, anchored.
 * markIcons returns unrecognised text verbatim, so composing a token out of an unchecked id
 * is how raw markup would reach the panel; a story card's tools come from a URL fragment,
 * which is exactly the untrusted case.
 */
const COMMAND_ID_RX = /^[a-z0-9_-]+$/;

/**
 * Escape a string for use inside a double-quoted HTML attribute. Tool labels come from the
 * i18n bundle rather than from a URL, so this is not the untrusted case COMMAND_ID_RX guards
 * — but a translator writing `"` in a title would still break out of the attribute and put
 * the rest of the button under their control, and a bundle is edited by more hands than this
 * file is.
 */
function escapeAttr(text) {
    return String(text)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replace every icon token with an empty inline placeholder carrying its request.
 *
 * Two-phase because t() is synchronous and QUERY is not (§8): the text renders immediately and
 * the icons land a moment later. The placeholder is empty until filled, so an icon that never
 * resolves collapses to zero width and the sentence closes over it — §5's "renders nothing" is
 * a layout property here, not merely a missing picture.
 */
function markIcons(text) {
    if (typeof text !== 'string' || text.indexOf('{icon:') === -1) return text;
    return text.replace(GUIDE_ICON_RX, (_m, cmdPrefix, id) =>
        `<span class="guide-icon" data-icon="${cmdPrefix ? 'cmd:' : ''}${id}"></span>`);
}

class GuideRuntime {

    constructor({ root, tour, i18n, sessionId, session = null, tourRunId = null }) {
        this.root = root;
        this.tour = tour;
        this.i18n = i18n;
        this.sessionId = sessionId;
        // The owning GuideSession, when there is one. Absent only in unit tests and the
        // direct-launch path, where a run without a library is still a valid thing to be.
        this.session = session;
        this.tourRunId = tourRunId;
        this.stepIndex = 0;
        this.pendingStepRequestId = null;
        this.hostReady = false;
        this.pendingQueries = new Map(); // requestId -> resolve fn
        this.statePollHandle = null;
        this.hintStepId = null;       // which step owns the standing hint, if any (CR-01 §4)
        this.dismissRules = [];       // conditions that take that hint back; any one is enough
        this.dismissTimer = null;     // the net under those conditions
        this.stepReadyTimer = null;   // STEP_READY watchdog (03-protocol.md "Timeouts")
        this.stepWaitTimer = null;    // TransitionStep.timeoutMs
        this.completed = false;       // whether the current step's rule has been satisfied
        this.destroyed = false;       // set by destroy(); see the note there
        // Completing events that have fired during THIS run, for transitions that wait on the
        // far side of a lifecycle (see _latchEvent). Per-run, so restarting a tour re-arms it.
        this.firedEvents = new Set();

        // Bound once and KEPT, so destroy() can actually remove them. They used to be anonymous
        // arrow functions, which cannot be removed at all — every tour ever started left a live
        // listener behind, and because the sessionId is shared by the whole session the filter
        // in _onMessage let every one of those ghosts act on messages meant for the current run
        // (bug report: guide/bug-reports/demo-collab-drawing.md item 5).
        this._onMessageBound = (e) => this._onMessage(e);
        this._onKeydownBound = (e) => { if (e.key === 'Escape') this.close(); };

        window.addEventListener('message', this._onMessageBound);

        // Escape must always close (05-implementation-plan.md "Done when"). GuideHost's own
        // listener is on the PARENT document — a keydown while focus is inside this iframe
        // never bubbles across the frame boundary, so it has to be caught here too. Measured
        // via scenarios/flows/99-probe.spec.js: Escape closed the tour before any click
        // (focus still on the host body) but did nothing once a button inside the iframe had
        // been clicked (focus moved into the iframe's own document).
        //
        // Both Escape paths now converge on close(), so a demo tour gets its keep/remove
        // prompt either way: focus inside the iframe lands here directly, focus on the host
        // arrives as HOST_CLOSING. Neither path destroys the iframe before the user has
        // answered (D15).
        document.addEventListener('keydown', this._onKeydownBound);
    }

    /**
     * End this run for good: no listeners, no timers, no polling.
     *
     * A GuideSession outlives the runs inside it (07 §4), so starting a second tour built a
     * second GuideRuntime while the first stayed fully alive — its `message` listener could not
     * be removed, its step watchdog was still counting, and its state poll still fired every
     * 250ms. Three symptoms followed, all reported as one bug:
     *
     *   - both runtimes wrote to the same `root` and both reported GUIDE_SIZE_CHANGED, so the
     *     host was sizing the shell from two different tours at once ("всі розміри ламаються");
     *   - the old runtime never received the STEP_READY that answered the NEW run's request, so
     *     its 10s watchdog fired and painted "Step unavailable (STEP_TIMEOUT)" over the new tour;
     *   - HOST_READY reached every live runtime, so an old tour could restart itself on top of
     *     the current one.
     *
     * Each restart added another ghost. Raising the timeout would only have delayed the second
     * symptom while leaving the other two untouched — the runs have to actually end.
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        window.removeEventListener('message', this._onMessageBound);
        document.removeEventListener('keydown', this._onKeydownBound);
        this._clearStepTimers();
        this._stopStatePoll();
        // Nothing is waiting on these any more; resolving rather than dropping them keeps an
        // awaiting _runActions from hanging forever on a run that no longer exists.
        for (const resolve of this.pendingQueries.values()) {
            resolve({ success: false, code: 'RUN_ENDED' });
        }
        this.pendingQueries.clear();
        this.pendingStepRequestId = null;
    }

    /**
     * Resolve a ContentRef, then mark any icon tokens it contains (10-content-icons.md §8).
     * Marking happens here rather than at each render site for the same reason watchPanelSize()
     * observes mutations rather than hooking eight innerHTML assignments: a surface added later
     * inherits the behaviour instead of inheriting the omission.
     */
    t(key) {
        return markIcons(this.i18n?.[key] ?? key);
    }

    /**
     * Body copy, rendered as Markdown — 09-tour-authoring.md §3 promises `body: |` gets "normal
     * Markdown formatting", and until now the runtime dropped it into a <p> unchanged, so
     * `**bold**` showed its asterisks and a numbered list ran together into one paragraph.
     *
     * Returns BLOCK markup (its own <p>/<ol>/<ul>), so callers must not wrap it again.
     */
    body(key) {
        // Markdown FIRST, icon tokens second. renderMarkdown escapes its input, so marking
        // icons beforehand would have the escaper turn the placeholder <span> into visible
        // text; running markIcons over the finished HTML instead would mean matching inside
        // markup. Rendering first and substituting the (escape-safe) token afterwards keeps
        // each step operating on exactly what it understands.
        return markIcons(renderMarkdown(this.i18n?.[key] ?? key));
    }

    send(message) {
        window.parent.postMessage(Object.assign({
            protocol: GUIDE_PROTOCOL,
            version: GUIDE_VERSION,
            sessionId: this.sessionId,
            messageId: makeId('msg'),
        }, message), location.origin);
    }

    /**
     * Phase 3 of §8: fill the placeholders left by markIcons().
     *
     * Silent on failure by decision (§5): an unknown sprite, an unknown command, or a sprite
     * sheet that has not finished loading leaves the span empty and logs a warning. A broken
     * image box in a teaching panel tells a nervous user "the guide is broken", which is a
     * worse outcome than a sentence that reads a little plainer than intended. The compensating
     * control is authoring-time — tour-validate.js rejects a cmd: token naming a command that
     * is not in the registry.
     *
     * Deduplicated by request: a step naming the same icon in its title and its body asks once.
     */
    async _fillIcons() {
        // `[data-icon]` is removed once a span is resolved, so a re-entrant observer pass finds
        // nothing and stops — see watchPanelSize(). Spans whose icon was unavailable are also
        // cleared, so §5's silence is not re-queried on every subsequent mutation.
        const spans = [...this.root.querySelectorAll('.guide-icon[data-icon]')];
        if (!spans.length) return;

        // Read the request, THEN clear the attribute — claiming the span before the await is
        // what makes the re-entrant pass find nothing.
        const byRequest = new Map();
        for (const span of spans) {
            const req = span.dataset.icon;
            span.removeAttribute('data-icon');
            if (!byRequest.has(req)) byRequest.set(req, []);
            byRequest.get(req).push(span);
        }

        await Promise.all([...byRequest.entries()].map(async ([req, targets]) => {
            const args = req.startsWith('cmd:')
                ? { command: req.slice(4) }
                : { icon: req };
            const r = await this.query('icon.svg', args);
            // The run ended mid-flight (tour switch, close): destroy() resolves every pending
            // query with RUN_ENDED. That is an ordinary tour switch, not a missing icon, so it
            // must not be reported as one — the warning exists to surface authoring mistakes,
            // and drowning it in lifecycle noise would make it useless for that.
            if (r?.code === 'RUN_ENDED' || this.destroyed) return;

            const markup = r?.success ? r.result : null;
            if (!markup) {
                console.warn('[guide] icon not available:', req);
                return;
            }
            // the panel may have been replaced while the query was in flight
            for (const span of targets) {
                if (span.isConnected) span.innerHTML = markup;
            }
        }));
    }

    start() {
        this.send({ type: 'GUIDE_READY', payload: { versions: [GUIDE_VERSION] } });
    }

    _onMessage(event) {
        const msg = event.data;
        if (!msg || msg.protocol !== GUIDE_PROTOCOL) return;
        if (msg.sessionId !== this.sessionId) return;
        // Second line of defence behind destroy(). sessionId cannot separate runs — it belongs
        // to the SESSION, and every run inside it shares the same one (07 §4) — so a listener
        // that outlived its run would otherwise pass this filter and act on the current run's
        // messages. destroy() removes the listener; this makes a ghost harmless even if some
        // path ever fails to call it, which is the failure mode that produced item 5.
        if (this.destroyed) return;

        switch (msg.type) {
            case 'HOST_READY':
                this.hostReady = true;
                this._startOrWarn();
                break;
            case 'STEP_READY':
                if (msg.payload?.stepRequestId === this.pendingStepRequestId) {
                    if (this.stepReadyTimer) { clearTimeout(this.stepReadyTimer); this.stepReadyTimer = null; }
                    this._renderCurrentStep();
                }
                break;
            case 'STEP_FAILED':
                if (msg.payload?.stepRequestId === this.pendingStepRequestId) {
                    if (this.stepReadyTimer) { clearTimeout(this.stepReadyTimer); this.stepReadyTimer = null; }
                    this._renderFailure(msg.payload);
                }
                break;
            case 'USER_ACTION':
                this._onUserAction(msg.payload);
                break;
            case 'QUERY_RESULT':
                this._onQueryResult(msg.payload);
                break;
            case 'COMMAND_RESULT':
                this._onQueryResult(msg.payload); // same requestId->resolve bookkeeping
                break;
            case 'GUIDE_FORM_CHANGED':
                // 08 §7.5/§10: the host could not fit the full panel beside the target, so it
                // asked for a smaller form. The host cannot reflow iframe content, so the
                // decision arrives here and the class does the rest — guide.css clamps the
                // body at .compact and hides everything but the title at .pill.
                this.form = msg.payload?.form || 'full';
                document.body.classList.toggle('guide-compact', this.form === 'compact');
                document.body.classList.toggle('guide-pill', this.form === 'pill');
                break;
            case 'POSITION_UPDATED':
                // The host moved the shell (08 §8.3). The runtime does not act on it — it owns
                // content, not geometry — but recording it lets a scenario assert WHY the panel
                // moved, and gives a future "the panel moved, here's where" affordance
                // somewhere to read from.
                this.lastPosition = msg.payload;
                break;
            case 'HOST_CLOSING':
                // The host wants to close (Escape, navigation, teardown) but has NOT torn the
                // iframe down — it is waiting for us to resolve any keep/remove decision
                // first (D15; 07 §6.7). close() already owns that logic: it shows the prompt
                // when there is demo content, and sends CLOSE_GUIDE when there is not.
                this.close();
                break;
            case 'GUIDE_CLOSED':
                this._renderClosed();
                break;
            case 'ERROR':
                // The host could not act on something we sent. Not surfaced to the user: every
                // request that matters already has its own timeout and its own fallback, so an
                // ERROR is a diagnostic for whoever is building the tour, not news the reader
                // can act on. Logging it is what turns "the step just sat there" into a cause.
                console.warn('[guide] host error:', msg.payload?.code, msg.payload?.message ?? '');
                break;
            default:
                console.warn('[guide] unhandled message type:', msg.type);
                break;
        }
    }

    /**
     * Every request carries a deadline (03-protocol.md "Timeouts": "Both sides need them or a
     * failure becomes a hang"). Without one, a dropped reply leaves its promise pending
     * forever — and because _runActions awaits each action, a single lost COMMAND_RESULT used
     * to stall the whole tour with no error and no way out but Escape.
     *
     * A timeout resolves (never rejects) with the same { success: false } shape a host error
     * produces, so callers have exactly one failure path to handle rather than two.
     */
    _request(type, payload, { timeoutMs, prefix }) {
        return new Promise((resolve) => {
            const requestId = makeId(prefix);
            const timer = setTimeout(() => {
                this.pendingQueries.delete(requestId);
                console.warn(`[guide] ${type} ${payload.name} timed out after ${timeoutMs}ms`);
                resolve({ requestId, success: false, code: 'TIMEOUT' });
            }, timeoutMs);

            this.pendingQueries.set(requestId, (result) => {
                clearTimeout(timer);
                resolve(result);
            });
            this.send({ type, payload: Object.assign({ requestId }, payload) });
        });
    }

    query(name, args) {
        return this._request('QUERY', { name, args },
            { timeoutMs: QUERY_TIMEOUT_MS, prefix: 'qry' });
    }

    /**
     * Every demo.* command is scoped to a tour's OWN declared `id` (04-tour-format.md), not
     * the file slug it was launched with — GuideHost.start(slug) and the tour's `id` field
     * are two different strings by design (a published tour id is a stable contract; the
     * slug is just where the JSON happens to live). Injecting tourId here means no call site,
     * and no tour author's `setup` action, has to remember to pass it — measured: forgetting
     * it once (in the original _runActions) left demo.hasScene unable to find the frame
     * demo.ensureScene had just marked, because it looked under a different key.
     */
    command(name, args, awaitMode) {
        const finalArgs = name.startsWith('demo.') ? Object.assign({ tourId: this.tour.id }, args) : args;
        return this._request('COMMAND', { name, args: finalArgs, await: awaitMode },
            { timeoutMs: COMMAND_TIMEOUT_MS, prefix: 'cmd' });
    }

    _onQueryResult(payload) {
        const resolve = this.pendingQueries.get(payload.requestId);
        if (!resolve) return;
        this.pendingQueries.delete(payload.requestId);
        resolve(payload);
    }

    /**
     * completion/waitFor is only meaningful for the step that is CURRENTLY active — a
     * USER_ACTION for a step that has since been left (Back, Skip, or a fast double
     * advance) must not retroactively complete it. stepId is the guard 03-protocol.md's
     * cancellation rule relies on here.
     */
    _onUserAction(payload) {
        const step = this.currentStep();
        if (!step || step.id !== payload.stepId) return;

        // A standing hint is checked FIRST and independently of completion (CR-01 §4). It has
        // to be before the guards below: a story step is not `interaction` and carries no
        // completion rule, so every early return underneath would drop the very events a hint
        // subscribed to. The two are unrelated questions anyway — "has this step finished" and
        // "has this hint been answered" — and only the second applies to a story card.
        if (this.hintStepId !== null && this._dismissMatches(payload)) this._clearHint();

        if (step.type !== 'interaction' || !step.completion) return;
        if (step.completion.type !== 'event') return; // state completion is polled, not pushed

        const matched = evalCondition(step.completion, { action: payload });

        // [CR-001] The other half of the journal. guide-events.js reports that an event was
        // emitted; this reports what the waiting step DECIDED about it. That second line is
        // the one that carries a diagnosis: "received command.executed(editor_hard_erase_mode_toggle)
        // but this step waits for editor_erase_mode_toggle" names the defect outright, where
        // the emission alone only proves the app was not silent.
        if (this._debugOn()) {
            const want = step.completion.event
                + (step.completion.match?.command ? `(${step.completion.match.command})` : '');
            const got = payload.event
                + (payload.data?.command ? `(${payload.data.command})` : '');
            console.log(
                `[guide] step ${this.tour?.id}/${step.id} ${matched ? 'COMPLETED' : 'no match'}`,
                `wants ${want}`, `got ${got}`, `origin=${payload.origin} #${payload.sequence}`,
            );
        }

        // [CR-001] The verdict also goes to the workbench's Events pane, and deliberately
        // OUTSIDE the console-debug guard above: the pane only receives it if a workbench is
        // actually listening (it installs the sink at boot), so there is no cost when nobody
        // is, and requiring the console flag as well would mean the pane sat empty for anyone
        // who had not also found the console switch — the very omission the pane exists to fix.
        //
        // This is the half that answers "the gate did not open, why": it names what the step
        // waits for beside what actually arrived.
        try {
            window.parent?.parent?.__guideStepVerdict?.({
                tour: this.tour?.id, step: step.id, matched,
                want: step.completion.event
                    + (step.completion.match?.command ? `(${step.completion.match.command})` : ''),
                got: payload.event + (payload.data?.command ? `(${payload.data.command})` : ''),
                origin: payload.origin, sequence: payload.sequence,
            });
        } catch (e) { /* cross-origin or no workbench listening — the console line stands */ }

        if (matched) {
            this._latchEvent(payload);
            this._onCompleted();
        }
    }

    /**
     * [CR-001] The runtime lives in the guide iframe and GuideEvents in the host, so the flag
     * has to be read on this side too. Same three switches, checked in the same order; the
     * host's own copy is consulted first so `GuideEvents.debug(true)` from the console turns
     * both halves on at once rather than only the emission half.
     */
    _debugOn() {
        try {
            const host = window.parent?.GuideEvents;
            if (host && typeof host.isDebug === 'function') return host.isDebug();
        } catch (e) { /* cross-origin parent — fall through to our own switches */ }
        try {
            if (/[?&]guide-debug=1/.test(location.search)) return true;
            return localStorage.getItem('guide_debug') === '1';
        } catch (e) { return false; }
    }

    /**
     * Record that a step's completing event actually fired, so a LATER transition can wait for
     * the second half of a lifecycle instead of a state that is already true.
     *
     * "Open the shatter workspace, then come back" was authored as two steps: an interaction
     * completing on `gamifier.opened`, then a transition waiting for `gamifier.active` falsy.
     * Nothing is active before the workspace opens, so the transition's first poll saw falsy and
     * advanced immediately — and when step 6 skipped, steps 6-9 fell through in one visible
     * flash. Waiting on a condition that is true BEFORE the action it waits for is the defect;
     * the latch is what makes "after" expressible.
     */
    _latchEvent(payload) {
        const name = payload?.event || payload?.type;
        if (name) this.firedEvents.add(name);
    }

    async _onCompleted() {
        this._stopStatePoll();
        const step = this.currentStep();
        const advance = step?.advance ?? { mode: 'manual' };
        this._markComplete();
        this._clearStepHighlight();
        if (advance.mode === 'automatic') {
            await new Promise((r) => setTimeout(r, advance.delayMs ?? 0));
            this._advance();
        }
    }

    /**
     * Take the step's highlight back the moment its completion rule is satisfied (CR-01 §4,
     * extended to tours).
     *
     * A highlight points at what to do next. Once the person has DONE it, it is pointing at
     * finished business — and it used to keep pointing until the next SHOW_STEP, which on a
     * manual-advance step means until they press Next. Measured on demo-stage1: after dragging
     * the panel, the orange ring stayed around it; after switching the move tool on, the ring
     * stayed on the button.
     *
     * This is the same rule story cards already follow — the difference was only that a card's
     * hint knows its dismiss set, while a tour step's "what answers this" was already written
     * as `complete:` and simply had nothing wired to it. One rule, two spellings.
     *
     * The panel itself is untouched: completion enables Next, it does not advance. The person
     * still reads the step and moves on when ready — only the pointer stops pointing.
     */
    _clearStepHighlight() {
        this.send({ type: 'CLEAR_STEP', payload: { stepId: this.currentStep()?.id } });
    }

    /**
     * Completion arrived: re-render the nav row, not just the Next button.
     *
     * This used to flip `next.disabled` and stop there, which was enough while Next was the
     * only control that cared. It is not any more: Skip hides once the gate opens (it would
     * name the same outcome as Next) and Repeat appears in its place. Both decisions live in
     * _chrome() and are computed from `completed`, so the row has to be rebuilt to reflect it.
     *
     * Only the nav row is replaced. Re-rendering the whole panel would discard the body the
     * reader is mid-sentence in and re-trigger the step's enter actions.
     */
    _markComplete() {
        const btn = this.root.querySelector('[data-action="next"]');
        if (btn) btn.disabled = false;

        const nav = this.root.querySelector('.guide-nav');
        const step = this.currentStep();
        if (!nav || !step) return;

        // _chrome() renders the whole panel; take just the nav row out of it so the rest of
        // the DOM the reader is looking at stays untouched.
        const html = this._chrome(step, /* interactive */ true, /* completed */ true);
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const freshNav = parsed.querySelector('.guide-nav');
        if (!freshNav) return;
        nav.innerHTML = freshNav.innerHTML;
        this._bindNav();
    }

    /**
     * State-type completion/waitFor has no push signal — poll via QUERY, no faster than
     * 250ms (02-editor-api.md §3 "Queries must not mutate... no faster than 250ms").
     */
    _startStatePoll(condition, afterEvent = null) {
        this._stopStatePoll();
        const queries = collectStateQueries(condition);
        if (!queries.length) return;

        const tick = async () => {
            // The gate is re-checked every tick rather than once at the start: the event that
            // arms it (the workspace opening) normally arrives while this poll is already
            // running, and a one-shot check here would latch the answer "no" forever.
            if (afterEvent && !this.firedEvents.has(afterEvent)) {
                this.statePollHandle = setTimeout(tick, 250);
                return;
            }
            const stateValues = {};
            for (const q of queries) {
                const key = queryKey({ query: q.query, args: q.args });
                const r = await this.query(q.query, q.args);
                stateValues[key] = r.success ? r.result : undefined;
            }
            if (evalCondition(condition, { stateValues })) {
                this._onCompleted();
                return;
            }
            this.statePollHandle = setTimeout(tick, 250);
        };
        this.statePollHandle = setTimeout(tick, 250);
    }

    _stopStatePoll() {
        if (this.statePollHandle) { clearTimeout(this.statePollHandle); this.statePollHandle = null; }
    }

    currentStep() {
        return this.tour.steps[this.stepIndex];
    }

    /**
     * 04-tour-format.md: a step's `enter` actions run before it is presented, `exit` after it
     * is left. Neither ran at all until now — only tour.setup did — so any tour needing
     * per-step preparation (open a panel, select a frame, seed state) had nowhere to put it.
     *
     * enter runs BEFORE SHOW_STEP so the targets it creates exist by the time the host
     * resolves them; otherwise a step whose enter opens the panel it highlights would fail
     * with TARGET_NOT_VISIBLE on its own preparation.
     */
    async _showStep(index) {
        const step = this.tour.steps[index];
        if (!step) return;

        this._stopStatePoll();
        this._clearStepTimers();

        // Assigned BEFORE the first render: a story panel is live on that first paint, and its
        // hint buttons quote pendingStepRequestId back to the host. Rendering first would have
        // them quote the PREVIOUS step's id, which handleShowStep discards as stale — a hint
        // that silently does nothing.
        const stepRequestId = makeId('req');
        this.pendingStepRequestId = stepRequestId;

        this._renderLoading(step);

        // CR-003: beforeStep undoes whatever the step is about to ask for, and runs on EVERY
        // show — first time or Repeat — with no way for the author to distinguish the two.
        // It runs before `enter` so a scene `enter` prepares (e.g. ui.setupLocation) is not
        // undone by a beforeStep that follows it; the compiler already rejects the same
        // command appearing in both (validateBeforeStepConflict).
        if (step.beforeStep?.length) {
            const outcome = await this._runActions(step.beforeStep);
            if (this.pendingStepRequestId !== stepRequestId) return;
            if (outcome.failed) return;
        }

        if (step.enter?.length) {
            const outcome = await this._runActions(step.enter);
            // a newer step started while enter was running — abandon this one
            if (this.pendingStepRequestId !== stepRequestId) return;
            if (outcome.failed) return;   // _runActions already routed fail-tour / goto
        }

        // A STORY step stops here. It has no target to resolve, no mask to raise and no
        // completion to wait for, so the SHOW_STEP round trip below would only dim the canvas
        // the person is meant to be drawing on — and arm a STEP_READY watchdog for an answer
        // that means nothing to it. Its panel is already live from _renderLoading; hint
        // buttons send their own SHOW_STEP when pressed, and nothing else needs the host.
        if (step.type === 'story') return;

        const completionRule = step.type === 'interaction' ? step.completion
            : step.type === 'transition' ? step.waitFor : null;

        this.send({
            type: 'SHOW_STEP',
            payload: {
                stepRequestId,
                stepId: step.id,
                // [BUG-012] A step with no completion rule is not waiting for anything, so a
                // disabled target cannot stall it — it can only illustrate. Steps that DO wait
                // still fail on TARGET_DISABLED, which is what stops a tour asking for a press
                // the button cannot accept. Decided here rather than in the host because
                // "does this step wait for something" is the runtime's own knowledge.
                targets: (step.targets || []).map((t) => (
                    step.completion ? t : { ...t, allowDisabled: true }
                )),
                interactionMode: step.interactionMode || 'NONE',
                // 08 §5.2: the canonical POI declaration and placement preference travel with
                // the step. Both optional — a step that declares neither still gets automatic
                // placement, because its own targets are protected without any authoring
                // (§4.1 invariant 1).
                poi: step.poi || [],
                poiOverrides: step.poiOverrides || null,
                panelPlacement: step.panelPlacement || null,
                // 03-protocol.md "Backpressure": only the events THIS step's completion rule
                // names — drawing.completed can fire many times a second.
                subscribeEvents: completionRule ? [...collectEventNames(completionRule)] : [],
            },
        });

        // 03-protocol.md: STEP_READY within 10s, else STEP_TIMEOUT and the step's fallback.
        // A host that never answers (a resolver throwing, a pipeline that never settles past
        // its own ceiling) would otherwise leave the panel showing a permanently disabled
        // Next button with no explanation.
        this.stepReadyTimer = setTimeout(() => {
            if (this.pendingStepRequestId !== stepRequestId) return;
            this._renderFailure({ stepRequestId, stepId: step.id, code: 'STEP_TIMEOUT' });
        }, STEP_READY_TIMEOUT_MS);

        if (completionRule?.type === 'state' || completionRule?.type === 'all' || completionRule?.type === 'any' || completionRule?.type === 'not') {
            // `after` names an event that must already have fired for this wait to mean
            // anything — "the workspace closed" only counts once it has opened. Without it the
            // first poll sees a condition that was true before the user did anything.
            this._startStatePoll(completionRule, step.waitAfterEvent || null);
        }

        // 04-tour-format.md TransitionStep.timeoutMs — "wait for a semantic condition, never a
        // sleep", but a condition that never becomes true must still surrender. Without this a
        // transition step polls forever; the collab tour's "wait for a second participant"
        // step is exactly that shape and already declares timeoutMs: 60000.
        if (step.type === 'transition' && step.timeoutMs) {
            this.stepWaitTimer = setTimeout(() => {
                if (this.pendingStepRequestId !== stepRequestId) return;
                this._stopStatePoll();
                this._renderFailure({ stepRequestId, stepId: step.id, code: 'STEP_TIMEOUT' });
            }, step.timeoutMs);
        }
    }

    _clearStepTimers() {
        if (this.stepReadyTimer) { clearTimeout(this.stepReadyTimer); this.stepReadyTimer = null; }
        if (this.stepWaitTimer) { clearTimeout(this.stepWaitTimer); this.stepWaitTimer = null; }
    }

    /* ── rendering — plain DOM, no framework needed for Stage 0 ────────────── */

    _renderLoading(step) {
        // A story step has nothing to wait for, so it never shows a disabled "loading" state.
        // It renders live on the first paint — which means BINDING here too: _renderLoading is
        // normally an inert placeholder replaced once STEP_READY lands, and leaving a story
        // panel unbound until then would give it dead buttons for no reason (see _storyChrome).
        if (step?.type === 'story') {
            this._renderStoryStep(step);
            return;
        }
        this.root.innerHTML = this._chrome(step, /* interactive */ false);
    }

    /**
     * The single place a story step reaches the screen — both the first paint (_renderLoading)
     * and every later one (_renderCurrentStep) come through here, which is why the hint is
     * taken back here rather than in the nav handlers. A ring raised on step 3 pointing at the
     * pencil means nothing on step 4, and it used to survive the move: rendering happens
     * entirely inside the iframe, so without this the host was never told the step had changed.
     *
     * Only on a CHANGE of step, though. A hint sends SHOW_STEP quoting the current step, the
     * host answers STEP_READY with the same id, and STEP_READY re-renders — so clearing on
     * every render made a hint extinguish its own ring one message later. Measured: the host
     * received SHOW_STEP and CLEAR_STEP back to back, and `.guide-ring` never survived a frame.
     *
     * Keyed by step ID, not index: _showStep() renders BEFORE it assigns this.stepIndex (the
     * panel must be live on the first paint), so an index read here still names the step being
     * left and every move would look like a re-render of the same one.
     */
    _renderStoryStep(step) {
        if (this.hintStepId !== step.id) this._clearHint();
        this.root.innerHTML = this._storyChrome(step);
        this._bindNav();
        this._bindTools(step);
        this._bindHintDismissOnTouch();
        this._reportSize();
    }

    /**
     * Coming back to the card answers the hint as surely as pressing the control does — the
     * person is reading again, so whatever they went looking for is no longer the question.
     * Part of the base set (CR-01 §4): always on, not something `dismiss` can switch off.
     *
     * Bound on `.guide-panel`, NOT on #guide-root: root fills the whole iframe, so a click that
     * misses the panel entirely would count as touching the card. Re-bound on every render
     * because the panel element is replaced wholesale by innerHTML.
     */
    _bindHintDismissOnTouch() {
        this.root.querySelector('.guide-panel')?.addEventListener('pointerdown', (e) => {
            if (this.hintStepId === null) return;
            // The tool row is ON the card, so without this exclusion pressing `activate` would
            // dismiss the hint through this rule — reinstating exactly the BUG-04 behaviour
            // CR-01 §4 removes, by the back door. Reaching for another tool is not coming back
            // to read; the row is where the hint was raised in the first place.
            if (e.target?.closest?.('.guide-tools')) return;
            this._clearHint();
        });
    }

    /**
     * Take back whatever a previous `hint` put on screen.
     *
     * A story card may hold AT MOST ONE hint, and it lives only until the next action of any
     * kind — another hint, an `activate`, moving to another step, closing the card. Only the
     * first of those used to clear it (a second hint sends SHOW_STEP, and handleShowStep
     * clears as its first move); every other path sent the host nothing at all, so a ring —
     * and, before `dim:false`, a full-screen mask — outlived the step that raised it and
     * pointed at a tool that was no longer the subject.
     *
     * Sent unconditionally rather than tracked: 03-protocol.md §"Idempotency" makes duplicate
     * CLEAR_STEP harmless, and a flag here would be one more thing to keep in sync with the
     * host's actual state.
     */
    _clearHint() {
        this.hintStepId = null;
        this.dismissRules = [];
        if (this.dismissTimer) { clearTimeout(this.dismissTimer); this.dismissTimer = null; }
        this.send({ type: 'CLEAR_STEP', payload: { stepId: this.tour?.steps?.[this.stepIndex]?.id } });
    }

    /**
     * Arm the conditions that will take this hint's highlight back (CR-01 §4).
     *
     * A SET, not a single event, and the conditions are ORed: "where is the pencil?" has more
     * than one right answer — they pressed the pencil, or they came back to the card and the
     * question lapsed. A scheme that can express only one would have to pick which of those to
     * ignore.
     *
     * Authored rules are ADDED to a base that always applies and cannot be switched off:
     * another hint replacing this one, a step change, a touch on the card, and the timeout
     * below. `dismiss` extends that base; it cannot make a ring permanent, which is not a
     * freedom worth handing an author — a ring that never lifts is the BUG-01 hang.
     *
     * The default, when nothing is authored, is the ordinary case: the highlighted command
     * being executed. `command.executed` carries `data.command` (guide-events.js), so one
     * subscription covers every possible target and the match is a field comparison — no
     * command→event table is needed.
     */
    _armDismiss(tool) {
        const authored = Array.isArray(tool.dismiss) ? tool.dismiss.filter((r) => r?.event) : null;
        this.dismissRules = authored?.length
            ? authored
            : [{ event: 'command.executed', command: tool.command }];

        // The safety net BUG-01 earned. If no rule ever matches — an event that does not fire
        // for this command, a control reached some other way — the ring must still lift rather
        // than sit on the canvas for the rest of the session.
        if (this.dismissTimer) clearTimeout(this.dismissTimer);
        this.dismissTimer = setTimeout(() => {
            this.dismissTimer = null;
            if (this.hintStepId !== null) this._clearHint();
        }, HINT_DISMISS_TIMEOUT_MS);
    }

    /**
     * Does this editor event answer the standing hint? Any rule matching is enough (they are
     * ORed); a rule matches when every field it names matches, so `{event}` alone is the
     * loosest form and extra fields only narrow it.
     */
    _dismissMatches(payload) {
        return this.dismissRules.some((rule) => {
            if (rule.event !== payload?.event) return false;
            if (rule.command !== undefined && rule.command !== payload?.data?.command) return false;
            if (rule.origin !== undefined && rule.origin !== payload?.origin) return false;
            return true;
        });
    }

    /**
     * The two consequences a tool button can have. `activate` runs the command; `hint` asks the
     * host to highlight where it lives and leaves the pressing to the person.
     *
     * Bound by INDEX into the step's own filtered tool list rather than by a command id read
     * back out of the DOM: markup is not a place to keep authority over what runs.
     */
    _bindTools(step) {
        const tools = (step.tools || []).filter((t) => COMMAND_ID_RX.test(t?.command || ''));
        this.root.querySelectorAll('[data-tool]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tool = tools[Number(btn.dataset.tool)];
                if (!tool) return;
                if (btn.dataset.do === 'hint') {
                    // Remember which step owns the ring, so the STEP_READY this very message
                    // provokes does not re-render into _clearHint() and undo it.
                    this.hintStepId = step.id;
                    this._armDismiss(tool);
                    // Reuses SHOW_STEP rather than adding a protocol message: it is what the
                    // host already understands for "highlight this", and handleShowStep starts
                    // by clearing the previous highlight, so pressing a second hint replaces
                    // the first instead of stacking rings. interactionMode stays NONE — a story
                    // card never locks the editor, since the canvas IS the work.
                    //
                    // `dim:false` is the other half of that same principle, and it is NOT
                    // derivable from interactionMode: NONE only means "do not suppress input",
                    // while the mask used to ride along inside the ring's own box-shadow. A
                    // story card highlights by ADDING a marker, never by darkening the work.
                    this.send({
                        type: 'SHOW_STEP',
                        payload: {
                            stepRequestId: this.pendingStepRequestId,
                            stepId: step.id,
                            targets: [{ id: tool.command, role: 'primary', padding: 8 }],
                            interactionMode: 'NONE',
                            dim: false,
                            poi: [], poiOverrides: null, panelPlacement: null,
                            subscribeEvents: this.dismissRules.map((r) => r.event),
                        },
                    });
                } else {
                    // CR-01 §4: `activate` no longer takes the hint back. BUG-04 made ANY action
                    // dismiss it, which was the cheapest rule that removed the symptom; the
                    // honest rule is that only an action ANSWERING the hint's question does.
                    // Pressing "add a frame" does not answer "where is the pencil?", so the ring
                    // keeps telling the truth about the pencil while something else happens.
                    this._runActions([{ command: tool.command, args: tool.args }]);
                }
            });
        });
    }

    /**
     * 08 §6.4: report the panel's real content size so the host can place it. The runtime owns
     * content and declares constraints; it does NOT assign its own outer geometry (§6.1).
     * Measured after render, so a localized step whose body runs long gets the height it
     * actually needs rather than the height English happened to need.
     */
    /**
     * Direct-launch path only. Under a GuideSession the observer in watchPanelSize() covers
     * every surface, including this one; without a session (a tour launched straight from
     * ?guide=<slug> in a future entry point) there is no observer, so the step still reports
     * for itself. Harmless when both run — the host takes the last measurement either way.
     */
    _reportSize() {
        if (this.session) return;   // the session's observer already handles it
        reportPanelSize(this.root, (m) => this.send(m), this.currentStep()?.id);
    }

    _renderCurrentStep() {
        const step = this.currentStep();
        if (step?.type === 'story') return this._renderStoryStep(step);
        this.root.innerHTML = this._chrome(step, /* interactive */ true, /* completed */ this._isAlreadySatisfied(step));
        this._bindNav();
        this._reportSize();
    }

    /**
     * Defaults per 04-tour-format.md: nextBeforeCompletion defaults to "disable" for a step
     * that HAS a completion rule. Info steps and interaction steps with an explicit "allow"
     * are never gated; a fresh interaction step always starts un-satisfied — this is only
     * about not re-showing "disabled" for a step-type that has no rule to satisfy.
     */
    _isAlreadySatisfied(step) {
        return step.type !== 'interaction' || !step.completion;
    }

    /**
     * 04-tour-format.md StepFallbackPolicy — all four types. `goto` and `fail-tour` were
     * validated but never executed, so a tour declaring either got the generic error panel
     * instead of the route its author chose. "Every interaction step should carry a fallback:
     * targets disappear for ordinary reasons — responsive layout, level gating, a closed
     * panel" — which makes silently ignoring two of the four policies a real gap.
     */
    _renderFailure(payload) {
        const step = this.currentStep();
        const fallback = step?.fallback;
        this._clearStepTimers();

        // A step failing is never nothing, and skip-step makes it look like nothing: the panel
        // moves on and a reader reporting "it jumped four steps" has no way to say why. Name
        // the step, the code and the target that would not resolve.
        console.warn('[guide] step failed:', {
            tour: this.tour?.id,
            step: step?.id,
            code: payload.code,
            targets: (step?.targets || []).map((t) => t.id),
            fallback: fallback?.type || 'none',
        });

        if (fallback?.type === 'skip-step') {
            this._advance();
            return;
        }
        if (fallback?.type === 'goto') {
            const target = this.tour.steps.findIndex((s) => s.id === fallback.stepId);
            if (target !== -1) {
                this.stepIndex = target;
                this._showStep(target);
                return;
            }
            console.warn('[guide] fallback goto points at a missing step:', fallback.stepId);
        }
        if (fallback?.type === 'fail-tour') {
            this._renderTourFailed(payload.code);
            return;
        }
        if (fallback?.type === 'show-info') {
            // A fallback is still THAT STEP, so it wears the step's chrome: the counter, the
            // dots, Back, Skip and Close. Hand-rolling a bare title-and-Next panel made it read
            // as a detached system warning — no way to tell which step it belonged to, and no
            // way back, only forward. Substituting the content keeps one renderer for both.
            this.root.innerHTML = this._chrome(
                { ...step, content: fallback.content },
                /* interactive */ true,
                /* completed */ true,
                // the target could not be resolved, so the reader cannot perform this step:
                // keep Skip, offer no Repeat
                { unperformable: true },
            );
            this._bindNav();
            this._reportSize();
            return;
        }
        // no fallback configured — surface the error rather than stalling silently
        this.root.innerHTML = `<div class="guide-panel"><p>Step unavailable (${payload.code}).</p>
            <div class="guide-nav"><button data-action="close">${this.t('guide.close')}</button></div></div>`;
        this._bindNav();
    }

    /**
     * fail-tour ends the run, but never by yanking the panel away: the user is told the tour
     * cannot continue and closes it themselves. Silent disappearance is the failure mode D15
     * argues against in the demo-content case, and it reads the same way here.
     */
    _renderTourFailed(code) {
        this.root.innerHTML = `
            <div class="guide-panel">
                <h2>${this.t('guide.failed.title')}</h2>
                ${this.body('guide.failed.body')}
                <p class="guide-detail">${code ?? ''}</p>
                <div class="guide-nav">
                    <button data-action="close">${this.t('guide.close')}</button>
                </div>
            </div>`;
        this._bindNav();
    }

    _renderClosed() {
        this.root.innerHTML = '';
    }

    /**
     * STORY LAYOUT — the second of two shells over one runtime.
     *
     * A tour teaches a control: it masks the screen, highlights a target, and waits for the
     * editor to confirm the person did the thing. A story card guides a person through their
     * own story: "mark each version with its own shape" has no right answer to wait for.
     *
     * So three things are deliberately absent, and each absence is the point:
     *   - no mask and no highlight — the canvas is the work, not a backdrop for a pointer;
     *   - Next is NEVER disabled — someone may choose not to draw, and the session continues;
     *   - navigation sits at the BOTTOM, where a reader's thumb already is.
     *
     * `tools` are this step's own buttons, at most four, chosen by the card's author for THIS
     * step rather than being the editor's toolbar. `activate` runs the command outright — for
     * preparation, like moving to frame 2 or switching the thermometer on, where hunting for
     * a control only stands between the person and the exercise. `hint` highlights where the
     * control lives and lets them press it — for the work itself, because doing that for
     * someone is doing their exercise for them.
     */
    _storyChrome(step) {
        const total = this.tour.steps.length;
        const nav = step.navigation || {};
        const isLast = this.stepIndex === total - 1;

        const closeBtn = (nav.close !== 'disable')
            ? `<button data-action="close" aria-label="${this.t('guide.close')}">✕</button>` : '';
        const backBtn = this.stepIndex > 0
            ? `<button data-action="back">${this.t('guide.back')}</button>`
            : `<button data-action="back" disabled>${this.t('guide.back')}</button>`;

        // At most four: the point is a short list chosen for THIS step, and a fifth makes it a
        // toolbar again. The label is the command's own icon token, resolved by the same
        // {icon:cmd:…} path a tour body uses, so one place decides what a command looks like.
        //
        // The id is checked against COMMAND_ID_RX first. markIcons only substitutes tokens it
        // recognises and returns anything else VERBATIM — so `{icon:cmd:"><img src=x onerror=…>}`
        // comes back as live markup. Harmless while every token is authored, but a deck arrives
        // from a URL fragment, so the id is validated here rather than trusted. A tool whose
        // command cannot be an id is dropped: it could never have run anyway.
        // Two buttons that look alike but behave oppositely is the worst version of this row:
        // `activate` runs a command outright, `hint` runs nothing. BUG-03 fixed that with four
        // channels at once — dashed border, fill, a corner glyph and a label — which was one
        // more than the difference needs.
        //
        // CR-01 replaces the glyph with a colour RULE the whole guide obeys: sky #0ea5e9 acts,
        // orange #f97316 points. The ring a `hint` raises on the canvas is orange too, so the
        // button and what it lights up read as one gesture. The dashed border stays: sky and
        // orange are the worst possible pair under protanopia, and after the glyph goes it is
        // the only channel left that survives in greyscale.
        //
        // title/aria-label are NOT decorative and do not go with the glyph: the button holds
        // only an icon, so they are the entire difference for a screen reader.
        const tools = (step.tools || [])
            .filter((tool) => COMMAND_ID_RX.test(tool?.command || ''))
            .slice(0, 4)
            .map((tool, i) => {
                const isHint = tool.do === 'hint';
                const label = this.t(isHint ? 'guide.tool.hint' : 'guide.tool.activate');
                return `<button class="guide-tool" data-tool="${i}" data-do="${isHint ? 'hint' : 'activate'}"`
                    + ` title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">`
                    + `${markIcons(`{icon:cmd:${tool.command}}`)}`
                    + `</button>`;
            }).join('');

        return `
            <div class="guide-panel guide-story">
                <div class="guide-header">
                    <span class="guide-progress">${this.t('guide.step_of')
                .replace('{current}', String(this.stepIndex + 1)).replace('{total}', String(total))}</span>
                    ${closeBtn}
                </div>
                ${this._progressDots(total)}
                ${tools ? `<div class="guide-tools">${tools}</div>` : ''}
                <h2>${this.t(step.content.title)}</h2>
                ${this.body(step.content.body)}
                <div class="guide-nav guide-nav-bottom">
                    ${backBtn}
                    <button data-action="next">${isLast ? this.t('guide.done') : this.t('guide.next')}</button>
                </div>
            </div>`;
    }

    _chrome(step, interactive, completed = true, { unperformable = false } = {}) {
        const total = this.tour.steps.length;
        const nav = step.navigation || {};
        const isLast = this.stepIndex === total - 1;

        const backBtn = (nav.back !== 'disable' && this.stepIndex > 0)
            ? `<button data-action="back">${this.t('guide.back')}</button>` : '';
        // [2026-09-01] "All tours" removed from the step chrome at the author's request. The
        // library is still reachable — Close leads back to it in a session — but it no longer
        // takes a slot in the row beside the action the step is actually asking for.
        // Skip is offered only while the step still WANTS something. Once the gate is open the
        // reader has already done it, and "skip" then names an action with no meaning: it and
        // Next would do the same thing from the reader's point of view.
        // `completed` means "the gate is open", which a FAILED step also reports so that Next
        // is usable — see the show-info fallback. That is not the reader having done anything,
        // and it is exactly when Skip matters most, so the fallback keeps Skip and gets no
        // Repeat: there is nothing to repeat.
        const performed = completed && !unperformable;
        const skipBtn = (nav.skip !== 'disable' && !isLast && !performed)
            ? `<button data-action="skip">${this.t('guide.skip')}</button>` : '';
        // ...and in its place, once the exercise is done, offer the thing that IS useful then:
        // doing it again. Re-running the step re-runs its `enter` and re-evaluates the gate
        // from live state, so a repeat is a real repeat rather than a redraw.
        //
        // Only where there is an exercise to repeat. An info step with no completion rule and
        // no target asks for nothing, so "Repeat" there would offer to redo nothing — it just
        // re-renders the same words. Requiring a rule or a target keeps the button meaningful
        // and, on a plain info step, leaves the row as Back / Next.
        //
        // It takes SKIP's slot, between Back and Next: they are alternatives to each other,
        // so swapping one for the other in place keeps Next where the reader last saw it.
        const asksForSomething = !!step.completion || !!(step.targets && step.targets.length);
        const repeatBtn = (performed && !isLast && interactive && asksForSomething)
            ? `<button data-action="repeat">${this.t('guide.repeat')}</button>` : '';
        const closeBtn = (nav.close !== 'disable')
            ? `<button data-action="close" aria-label="${this.t('guide.close')}">✕</button>` : '';
        const nextLabel = isLast ? this.t('guide.done') : this.t('guide.next');
        // 04-tour-format.md defaults: nextBeforeCompletion defaults to "disable" — Next stays
        // disabled until the step's own completion rule fires, unless the step opts out.
        const nextGatedByCompletion = nav.nextBeforeCompletion !== 'allow' && !completed;
        const nextDisabled = !interactive || nextGatedByCompletion;
        const nextBtn = `<button data-action="next" ${nextDisabled ? 'disabled' : ''}>${nextLabel}</button>`;

        return `
            <div class="guide-panel">
                <div class="guide-header">
                    <span class="guide-progress">${this.t('guide.step_of')
                .replace('{current}', String(this.stepIndex + 1)).replace('{total}', String(total))}</span>
                    ${closeBtn}
                </div>
                ${this._progressDots(total)}
                <h2>${this.t(step.content.title)}</h2>
                ${this.body(step.content.body)}
                <div class="guide-nav">
                    ${backBtn}
                    ${skipBtn}${repeatBtn}
                    ${nextBtn}
                </div>
            </div>`;
    }

    _progressDots(total) {
        const dots = Array.from({ length: total }, (_, i) => {
            const cls = i === this.stepIndex ? 'guide-dot guide-dot-current' : 'guide-dot';
            return `<span class="${cls}"></span>`;
        }).join('');
        return `<div class="guide-dots">${dots}</div>`;
    }

    _bindNav() {
        this.root.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (action === 'next') this._advance();
                else if (action === 'back') this._back();
                else if (action === 'skip') this._skip();
                else if (action === 'library') this._leaveToLibrary();
                else if (action === 'repeat') this._repeat();
                else if (action === 'close') this.close();
            });
        });
    }

    /**
     * Re-run the current step so the reader can do it again.
     *
     * A plain re-render is not enough when the gate is a TOGGLE. Reported from
     * collab.drawing/who-drew-what: the layers panel is open, the step is complete, and
     * Repeat re-rendered the same open panel — the button blinked and nothing could be
     * repeated, because the thing the step asks for had already happened and stayed happened.
     *
     * So a repeat first UNDOES what the step asked for, where undoing is meaningful:
     *
     *   toggle      pressing it again turns it off, so run the command once and the reader
     *               can perform the step for real a second time;
     *   mode-cycle  a second press does NOT turn it off, it moves to another sub-mode
     *               (editor_draw_mode_toggle: foreground -> background -> foreground), so
     *               "undoing" it would leave the editor somewhere else again;
     *   action      add_frame, clone_selected_frame — running it again ADDS another one,
     *               and there is no inverse to call;
     *   anything else, or unclassified (kind null) — we do not know, so we do not touch it.
     *
     * Only `toggle` is reversible by re-running the same command, and only when the gate is
     * literally "this command is on" — command.isOn. A gate on frame.count or a pointer event
     * says nothing about how to get back, and guessing there would destroy the reader's work.
     *
     * The reset is best-effort: if the query or the command fails, the step is still shown.
     */
    async _repeat() {
        await this._undoToggleGate();
        this._showStep(this.stepIndex);
    }

    /**
     * Turn a `command.isOn` gate back off, when — and only when — the command says a second
     * press is what turns it off (kind: "toggle", declared on the command, measured not
     * inferred). Returns silently in every other case.
     */
    async _undoToggleGate() {
        const rule = this.currentStep()?.completion;
        if (!rule || rule.type !== 'state' || rule.query !== 'command.isOn') return;
        // `truthy` is the only shape where "off" is the way back; a falsy gate is already
        // satisfied by the off state, so there is nothing to undo.
        if (rule.operator !== 'truthy') return;

        const id = rule.args?.command;
        if (!id) return;

        try {
            const kind = await this.query('command.kind', { command: id });
            // QUERY_RESULT is { success, result } — not { value }. Reading the wrong field
            // here fails silently: every repeat would simply decline to reset.
            if (!kind?.success || kind.result !== 'toggle') return;
            const on = await this.query('command.isOn', { command: id });
            if (!on?.success || on.result !== true) return;   // already off — nothing to undo
            await this.command(id);
        } catch (e) {
            // a failed reset must not cost the reader the repeat itself
            console.warn('[guide] repeat could not reset the toggle:', id, e);
        }
    }

    /**
     * Skip was an alias for Next, which made skipping the LAST step complete the tour — the
     * opposite of what skipping means. 04-tour-format.md keeps `skip` and `next` as separate
     * navigation permissions, and the teardown table maps them to different branches
     * (onSkip vs onComplete), so they cannot share an implementation.
     *
     * Skipping past the end abandons the tour: no completion is recorded and teardown.onSkip
     * runs instead of onComplete.
     */
    async _skip() {
        await this._runActions(this.currentStep()?.exit);
        if (this.stepIndex < this.tour.steps.length - 1) {
            this.stepIndex += 1;
            this._showStep(this.stepIndex);
        } else {
            await this._runActions(this.tour.teardown?.onSkip);
            // skipping past the end abandons the tour: no completion is recorded, so it goes
            // back to the library rather than to the completion surface
            this._finish({ type: this.session ? 'library' : 'close' });
        }
    }

    /** Next: advance, or complete the tour when there is nowhere left to go. */
    async _advance() {
        const step = this.currentStep();
        await this._runActions(step?.exit);

        // 04-tour-format.md StepRouting. Validated since Stage 0 but never executed, so a tour
        // declaring branches passed validation and then walked straight past them — the worst
        // shape for a gap, because the tour looks correct and behaves as though the author had
        // written nothing.
        const routed = await this._resolveRouting(step);
        if (routed !== null) {
            this.stepIndex = routed;
            this._showStep(routed);
            return;
        }

        if (this.stepIndex < this.tour.steps.length - 1) {
            this.stepIndex += 1;
            this._showStep(this.stepIndex);
        } else {
            await this._runActions(this.tour.teardown?.onComplete);
            // §6.6: Done leads to a completion surface, not to teardown. Without a session
            // (direct launch, no library) there is nowhere to go afterwards, so closing stays
            // the honest outcome.
            this._finish({ type: 'complete' });
        }
    }

    /**
     * 04-tour-format.md StepRouting — where a step goes next when it is not simply the next one.
     *
     *   routing:
     *     branches: [{ when: <Condition>, goto: <stepId> }]
     *     defaultNext: <stepId>
     *
     * First matching branch wins; `defaultNext` applies when none does. Returns the step INDEX
     * to jump to, or null to fall through to linear advance — null rather than the current index
     * so "no routing" and "routing chose to stay" stay distinguishable.
     *
     * Only STATE conditions are evaluated, the same restriction TourAction.when carries: an
     * event condition describes something happening over time, whereas routing asks a question
     * about right now, at the moment the step is left.
     *
     * A `goto` naming a missing step is a validation error (tour-validate.js checks it), so
     * reaching one here means validation was skipped — warn and fall through rather than
     * stranding the user on a step that cannot advance.
     */
    async _resolveRouting(step) {
        const routing = step?.routing;
        if (!routing) return null;

        for (const branch of routing.branches || []) {
            if (!branch?.goto) continue;
            if (branch.when && !(await this._evaluateCondition(branch.when))) continue;
            const index = this._stepIndexById(branch.goto);
            if (index !== -1) return index;
            console.warn('[guide] routing branch points at a missing step:', branch.goto);
        }

        if (routing.defaultNext) {
            const index = this._stepIndexById(routing.defaultNext);
            if (index !== -1) return index;
            console.warn('[guide] routing defaultNext points at a missing step:', routing.defaultNext);
        }
        return null;
    }

    _stepIndexById(id) {
        return this.tour.steps.findIndex((s) => s.id === id);
    }

    /**
     * §6.5/§6.7: every exit funnels through here so the demo keep/remove prompt is offered
     * once, and the ORIGINAL intent survives it. Before Stage A the prompt always ended in
     * CLOSE_GUIDE, which meant "leave this tour" could only ever mean "destroy the guide".
     */
    async _finish(intent) {
        this._stopStatePoll();
        this._clearStepTimers();

        if (this.tour.session?.contentMode === 'demo' && this.tour.session?.onEnd !== 'keep') {
            const hasScene = await this.command('demo.hasScene');
            if (hasScene?.success && hasScene.result?.hasScene) {
                this._renderKeepOrRemovePrompt(intent);
                return;
            }
        }
        this._applyIntent(intent);
    }

    _applyIntent(intent) {
        if (intent.type === 'complete' && this.session) return this.session.showCompletion(this.tour);
        if (intent.type === 'library' && this.session) return this.session.leaveToLibrary();
        this.send({ type: 'CLOSE_GUIDE', payload: {} });
    }

    /** "All tours" — leave the run, keep the guide session (§6.5). */
    async _leaveToLibrary() {
        await this._runActions(this.currentStep()?.exit);
        await this._runActions(this.tour.teardown?.onClose);
        this._finish({ type: 'library' });
    }

    /**
     * Back runs the current step's `exit` too: exit is "leaving this step", not "leaving it
     * forwards". A step whose enter opened a panel and whose exit closes it would otherwise
     * leak that panel open when the user stepped backwards.
     */
    async _back() {
        if (this.stepIndex > 0) {
            await this._runActions(this.currentStep()?.exit);
            this.stepIndex -= 1;
            this._showStep(this.stepIndex);
        }
    }

    /**
     * D15: removal is OFFERED, never performed automatically. Content vanishing by itself is
     * as alarming as content appearing by itself, and some users want to keep what the tour
     * drew. Applies to completed, skipped AND closed — every path funnels through here.
     * onEnd: "keep" (declared, not the 04-tour-format.md default) skips the prompt outright:
     * the tour author has already decided the drawing stays.
     */
    async close({ skipTeardown = false } = {}) {
        this._stopStatePoll();
        this._clearStepTimers();

        // 04-tour-format.md teardown branches. _advance/_skip have already run their own
        // branch (onComplete/onSkip) and pass skipTeardown so a completed tour does not also
        // run the close branch — the reason mapping in 07 §6.7 treats them as distinct.
        if (!skipTeardown) await this._runActions(this.tour.teardown?.onClose);

        // Close is terminal for the whole guide session, never a leave (§5 invariant 1).
        this._finish({ type: 'close' });
    }

    /**
     * §6.7: the initiating intent is RETAINED while the prompt is open, and continued after
     * the answer. Previously both buttons sent CLOSE_GUIDE, so answering the prompt destroyed
     * the guide no matter what the user had actually asked for — which made "All tours" on a
     * demo tour indistinguishable from closing.
     */
    _renderKeepOrRemovePrompt(intent) {
        this.root.innerHTML = `
            <div class="guide-panel">
                <h2>${this.t('guide.demo_prompt.title')}</h2>
                ${this.body('guide.demo_prompt.body')}
                <div class="guide-nav">
                    <button data-action="demo-remove">${this.t('guide.demo_prompt.remove')}</button>
                    <button data-action="demo-keep">${this.t('guide.demo_prompt.keep')}</button>
                </div>
            </div>`;
        this.root.querySelector('[data-action="demo-remove"]').addEventListener('click', async () => {
            await this.command('demo.removeScene');
            this._applyIntent(intent);
        });
        this.root.querySelector('[data-action="demo-keep"]').addEventListener('click', () => {
            this._applyIntent(intent);
        });
    }

    /**
     * D16: a tour whose setup/enter mutates the model asks for confirmation before starting
     * inside a room — its content reaches other participants and local removal does not
     * propagate. A warning, not a refusal: drawing together is the product.
     */
    async _startOrWarn() {
        // 04-tour-format.md Requirements, checked BEFORE anything runs: "A tour pointing at a
        // control the current level does not show is worse than no tour." Previously nothing
        // was checked, so such a tour started, ran its setup, and failed on the step that
        // needed the missing control — after already mutating the model.
        const unmet = await this._checkRequirements();
        if (unmet) {
            this._renderUnavailable(unmet);
            return;
        }

        if (this.tour.session?.contentMode === 'demo') {
            const connected = await this.query('collab.connected');
            if (connected?.success && connected.result) {
                this._renderCollabWarning();
                return;
            }
        }
        await this._runSetupAndShowFirstStep();
    }

    /** Returns a human-readable reason string, or null when every requirement is satisfied. */
    async _checkRequirements() {
        const req = this.tour.requirements;
        if (!req) return null;

        for (const id of req.commands || []) {
            const exists = await this.query('command.exists', { command: id });
            if (!exists?.success || !exists.result) return `command not available: ${id}`;
            const disabled = await this.query('command.disabled', { command: id });
            if (disabled?.success && disabled.result === true) return `command not usable here: ${id}`;
        }

        // [BUG-005] `commands` above asks only whether the id is in the registry — the check
        // that passed while stage2's eraser rendered no button (BUG-001). `targets` asks the
        // real resolver instead, so a tour refuses to start rather than skipping its way
        // through steps whose controls this build does not surface. A target behind a
        // collapsed "..." counts as reachable: the host redirects the highlight to the toggle.
        for (const id of req.targets || []) {
            const ok = await this.query('target.resolvable', { target: id });
            // "not available in this build" was the only wording, and it named a defect that
            // usually was not there: an opt-in feature that is off looks identical to one that
            // was never shipped. Say which, so the reader is not sent hunting the wrong thing.
            if (!ok?.success || !ok.result) return `this control is not on screen right now: ${id}`;
        }

        if (req.minLevel !== undefined) {
            const level = await this.query('editor.level');
            if (!level?.success || !(Number(level.result) >= req.minLevel)) {
                return `needs editor level ${req.minLevel}`;
            }
        }

        // minViewport is measured in the iframe, not asked of the host: the guide panel's own
        // window is what a "does this fit" question is really about, and window.innerWidth
        // inside a same-origin iframe still reports the frame, not the editor. The host owns
        // the editor viewport; 08's placement work is where that distinction gets a real API.
        if (req.minViewport?.width !== undefined && window.parent.innerWidth < req.minViewport.width) {
            return `needs a wider screen (${req.minViewport.width}px)`;
        }

        return null;
    }

    /**
     * Why this tour will not run.
     *
     * `reason` is an internal string with an id in it — "not available in this build:
     * button.collab". Reported as reading like a broken build, when the truth was that
     * collaboration is opt-in and simply switched off in that browser. A tour that knows why
     * its requirement might be unmet can say so in `requirements.unavailableHint`, and that
     * sentence leads; the internal reason stays underneath, smaller, for whoever is debugging.
     */
    _renderUnavailable(reason) {
        // this.body(), not this.t(): the hint is authored prose, so it gets the same markdown
        // and {icon:...} treatment as a step body. Rendering it with t() shipped literal
        // asterisks and unresolved icon tokens to the reader.
        const hintKey = this.tour?.requirements?.unavailableHint;
        const hint = hintKey ? this.body(hintKey) : null;
        this.root.innerHTML = `
            <div class="guide-panel">
                <h2>${this.t('guide.unavailable.title')}</h2>
                ${hint ?? this.body('guide.unavailable.body')}
                <p class="guide-detail">${reason}</p>
                <div class="guide-nav">
                    <button data-action="close">${this.t('guide.close')}</button>
                </div>
            </div>`;
        this._bindNav();
    }

    /**
     * Shared by the direct start path and the collab warning's "continue anyway" button —
     * bypassing this to call _showStep() straight from the warning (the original bug here)
     * skips tour.setup entirely, so demo.ensureScene never runs and the tour shows its first
     * step with no scene actually prepared.
     */
    async _runSetupAndShowFirstStep() {
        await this._runActions(this.tour.setup);
        this._showStep(this._initialStepIndex());
    }

    /**
     * Normally 0. The authoring workbench (09 §11.2 "start from the selected step") sets
     * `__guideStartAtStep` on the parent window so an author tuning step 6 does not click
     * through five steps on every edit.
     *
     * DEVELOPMENT ONLY, and it fails closed: the hook is read once, cleared immediately, and
     * ignored unless it names a real step. Nothing in the shipped application ever sets it —
     * the workbench is served exclusively by the dev server (§11.6).
     *
     * §15 names the risk this carries: "selected-step preview does not run earlier destructive
     * setup unexpectedly". Tour `setup` still runs above, because the scene has to exist; the
     * per-step `enter` actions of the SKIPPED steps deliberately do not, which is why the
     * workbench says so in its status line rather than leaving it to be discovered.
     */
    _initialStepIndex() {
        let requested;
        try {
            requested = window.parent?.__guideStartAtStep;
            if (requested !== undefined) window.parent.__guideStartAtStep = undefined;
        } catch (e) {
            return this.stepIndex;   // cross-origin parent: not the workbench, nothing to read
        }

        const index = Number(requested);
        if (!Number.isInteger(index) || index < 0 || index >= this.tour.steps.length) {
            return this.stepIndex;
        }
        this.stepIndex = index;
        return index;
    }

    /**
     * 04-tour-format.md TourAction[] — tour.setup, per-step enter/exit, and teardown branches.
     *
     * Failure detection was previously a try/catch around this.command(), which never threw:
     * a host-side COMMAND_FAILED resolves with { success: false }, so every onFailure policy
     * was silently unreachable and a broken setup looked like a successful one. Failure is a
     * returned value here, not an exception.
     *
     * Returns { failed } so a caller that must not continue — _showStep, whose enter actions
     * build the very targets the step highlights — can stop instead of presenting a step its
     * preparation never completed.
     */
    async _runActions(actions) {
        for (const action of actions || []) {
            // `when` gates the action on a condition (04-tour-format.md TourAction.when):
            // "open the panel IF it is not already open" is the common shape, and without it
            // a tour has to choose between an unconditional action and no action at all.
            if (action.when && !(await this._evaluateCondition(action.when))) continue;

            const result = await this.command(action.command, action.args, action.await);
            if (result?.success) continue;

            console.warn('[guide] action failed:', action.command, result?.code);
            const policy = action.onFailure?.type ?? 'skip-action';
            if (policy === 'fail-tour') {
                this._renderTourFailed(result?.code);
                return { failed: true };
            }
            if (policy === 'goto') {
                const target = this.tour.steps.findIndex((s) => s.id === action.onFailure.stepId);
                if (target !== -1) {
                    this.stepIndex = target;
                    this._showStep(target);
                    return { failed: true };
                }
                console.warn('[guide] action onFailure goto points at a missing step:', action.onFailure.stepId);
            }
            // 'skip-action' — carry on with the next action
        }
        return { failed: false };
    }

    /**
     * Evaluate a Condition outside a completion rule (TourAction.when). Only state conditions
     * are meaningful here: an event condition describes something that happens over time,
     * whereas `when` asks a question about right now.
     */
    async _evaluateCondition(condition) {
        const queries = collectStateQueries(condition);
        const stateValues = {};
        for (const q of queries) {
            const r = await this.query(q.query, q.args);
            stateValues[queryKey({ query: q.query, args: q.args })] = r.success ? r.result : undefined;
        }
        return evalCondition(condition, { stateValues });
    }

    _renderCollabWarning() {
        this.root.innerHTML = `
            <div class="guide-panel">
                <h2>${this.t('guide.collab_warning.title')}</h2>
                ${this.body('guide.collab_warning.body')}
                <div class="guide-nav">
                    <button data-action="warning-cancel">${this.t('guide.close')}</button>
                    <button data-action="warning-continue">${this.t('guide.collab_warning.continue')}</button>
                </div>
            </div>`;
        this.root.querySelector('[data-action="warning-cancel"]').addEventListener('click', () => this.close());
        this.root.querySelector('[data-action="warning-continue"]').addEventListener('click', () => this._runSetupAndShowFirstStep());
    }
}

/**
 * ── guide session — 07-guide-library-and-tour-switching.md §6 ─────────────────────────────
 *
 * The session owns the shell's content across several tour runs: it shows the library, starts
 * a run, takes it back when the user leaves, and shows the completion surface. GuideRuntime
 * still owns exactly one run and knows nothing about the catalog — the split mirrors §4's
 * "one guide session may contain several tour runs".
 *
 * Before Stage A a tour was a terminal flow: completing the last step and closing followed the
 * same path, and there was no way to reach a second tour without reloading. §1.1 calls that a
 * specification gap rather than a missing button, which is why this is a layer and not a
 * "restart" link.
 */
class GuideSession {

    constructor({ root, sessionId, catalog, i18n }) {
        this.root = root;
        this.sessionId = sessionId;
        this.catalog = catalog;
        this.i18n = i18n;
        this.runtime = null;

        window.addEventListener('message', (e) => this._onMessage(e));
        // one observer for the whole session: every surface it renders reports its own size
        // Icons are filled by whoever owns the surface currently on screen: a run's own runtime
        // while a tour is active, the session itself for the library and completion surfaces.
        // Routing through the live runtime rather than always using the session's own querier
        // keeps a run's requests inside that run, so destroy() can resolve them (see
        // GuideRuntime.destroy) instead of leaving them pending against a dead run.
        watchPanelSize(this.root, (m) => this.send(m), () => this._fillIcons());

        // Ask for the available height rather than waiting to be told (BUG-06). The host
        // volunteers it on HOST_READY — but HOST_READY answers GUIDE_READY, and GUIDE_READY is
        // sent by a RUN's runtime, which the library does not have. So the one surface that
        // actually needs the number, the scrolling catalog, was the one surface that never
        // received it, and it silently kept the `vh` fallback that measures the wrong box.
        this.send({ type: 'QUERY_SPACE', payload: {} });
    }

    t(key) { return markIcons(this.i18n?.[key] ?? key); }

    /** Block-level body copy — same contract as GuideRuntime.body(); see the note there. */
    body(key) { return markIcons(renderMarkdown(this.i18n?.[key] ?? key)); }

    /**
     * Delegate to the active run when there is one, so its pending queries live and die with it
     * (10-content-icons.md §8). The library and completion surfaces have no run, so the session
     * resolves those itself through _query().
     */
    _fillIcons() {
        if (this.runtime && !this.runtime.destroyed) return this.runtime._fillIcons();
        return this._fillIconsStandalone();
    }

    async _fillIconsStandalone() {
        const spans = [...this.root.querySelectorAll('.guide-icon[data-icon]')];
        if (!spans.length) return;

        const byRequest = new Map();
        for (const span of spans) {
            const req = span.dataset.icon;
            span.removeAttribute('data-icon');
            if (!byRequest.has(req)) byRequest.set(req, []);
            byRequest.get(req).push(span);
        }

        await Promise.all([...byRequest.entries()].map(async ([req, targets]) => {
            const args = req.startsWith('cmd:') ? { command: req.slice(4) } : { icon: req };
            const markup = await this._query('icon.svg', args);
            if (!markup) {
                console.warn('[guide] icon not available:', req);
                return;
            }
            for (const span of targets) {
                if (span.isConnected) span.innerHTML = markup;
            }
        }));
    }

    send(message) {
        window.parent.postMessage(Object.assign({
            protocol: GUIDE_PROTOCOL, version: GUIDE_VERSION,
            sessionId: this.sessionId, messageId: makeId('msg'),
        }, message), location.origin);
    }

    _onMessage(event) {
        const msg = event.data;
        if (!msg || msg.protocol !== GUIDE_PROTOCOL || msg.sessionId !== this.sessionId) return;

        // SHOW_LIBRARY arrives when the editor's Guides control is used while the guide is
        // already open — §6.1: that is a leave, not a second guide.
        if (msg.type === 'SHOW_LIBRARY') this.leaveToLibrary();
        // Handled on the SESSION, not on the run: it applies to every surface, including the
        // library and the completion screen, which exist with no run at all. Three messages
        // carry it because all three mark a moment the available room can differ — the first
        // paint, a viewport change, and a form change.
        else if (msg.type === 'HOST_READY' || msg.type === 'GUIDE_SPACE_CHANGED'
            || msg.type === 'GUIDE_FORM_CHANGED') {
            applyAvailableHeight(msg.payload?.availableHeight);
        }
        // everything else belongs to the active run, if there is one
    }

    request(type, payload, expect) {
        return new Promise((resolve) => {
            const onReply = (e) => {
                const m = e.data;
                if (!m || m.protocol !== GUIDE_PROTOCOL || m.sessionId !== this.sessionId) return;
                if (m.type !== expect && m.type !== 'TOUR_REJECTED') return;
                window.removeEventListener('message', onReply);
                resolve(m);
            };
            window.addEventListener('message', onReply);
            this.send({ type, payload });
            setTimeout(() => {
                window.removeEventListener('message', onReply);
                resolve(null);   // 03-protocol.md budgets; a hang here would strand the library
            }, 10000);
        });
    }

    /* ── library — §6.4 ───────────────────────────────────────────────────── */

    /**
     * Tear down the current run, if any. The mirror of GuideHost.endRun() on this side of the
     * frame: `this.runtime = null` alone only dropped the REFERENCE, leaving the object itself
     * running with its listeners and timers intact (item 5). Every path that leaves a run —
     * library, leave, and starting the next tour — goes through here so none can forget.
     */
    endRun() {
        if (!this.runtime) return;
        this.runtime.destroy();
        this.runtime = null;
        if (window.__guideRuntime === undefined) return;
        window.__guideRuntime = null;   // scenario/probe hook must not point at a dead run
    }

    async showLibrary() {
        this.endRun();
        const entries = await this._eligibleEntries();
        // Kept on the session, not in the DOM: showLibrary() rewrites the whole panel — after
        // starting a tour and coming back, or on a locale change — and a flag read off the old
        // markup would be gone by then. The reader expanded the catalog; it stays expanded
        // until they collapse it or close the guide.
        const expanded = this.libraryExpanded === true;
        const expandKey = expanded ? 'guide.library.collapse' : 'guide.library.expand';
        this.root.innerHTML = `
            <div class="guide-panel guide-library${expanded ? ' guide-library-expanded' : ''}">
                <div class="guide-header">
                    <h2>${this.t('guide.library.title')}</h2>
                    <div class="guide-header-actions">
                        <button class="guide-expand" data-action="expand"
                            aria-pressed="${expanded}"
                            title="${this.t(expandKey)}" aria-label="${this.t(expandKey)}"
                        >${expanded ? '⤡' : '⤢'}</button>
                        <button data-action="close" aria-label="${this.t('guide.close')}">✕</button>
                    </div>
                </div>
                <ul class="guide-tour-list" tabindex="0">
                    ${entries.map((e) => this._card(e)).join('')}
                </ul>
            </div>`;

        this.root.querySelector('[data-action="close"]')
            ?.addEventListener('click', () => this.closeGuide());
        this.root.querySelectorAll('[data-slug]').forEach((btn) => {
            btn.addEventListener('click', () => this.startTour(btn.dataset.slug));
        });

        // Re-render rather than toggling the class in place: the button's own glyph, title and
        // aria-pressed all change with the state, and the panel must re-measure either way —
        // the MutationObserver in watchPanelSize() reports the new height to the host, which is
        // what actually resizes the shell around the taller list.
        this.root.querySelector('[data-action="expand"]')?.addEventListener('click', () => {
            this.libraryExpanded = !this.libraryExpanded;
            // The room did not change, the SHARE of it did (75% -> 90%), and that is a content
            // decision this side owns — so recompute from the height the host last gave us.
            //
            // AFTER the await: showLibrary() is async (it resolves eligibility before writing
            // any markup), so a synchronous call here reads the OLD panel and recomputes the
            // share it already had — the class flipped and not a single pixel moved.
            this.showLibrary().then(() => applyAvailableHeight());
        });

        // The list scrolls, so it opens at the top rather than wherever a previous render left
        // it — reopening the catalog mid-list reads as missing tours. `tabindex=0` on the <ul>
        // is what lets arrow keys and PageDown drive that scroll: the cards' buttons are
        // reachable by Tab, but a scroll container is not focusable on its own.
        const list = this.root.querySelector('.guide-tour-list');
        if (list) list.scrollTop = 0;
    }

    _card(e) {
        const mins = e.meta.estimatedMinutes ? `${e.meta.estimatedMinutes} min` : '';
        const label = e.completed ? this.t('guide.library.again') : this.t('guide.library.start');
        const meta = [e.meta.category, mins].filter(Boolean).join(' · ');
        return `
            <li class="guide-tour-card${e.eligible ? '' : ' guide-unavailable'}">
                <div class="guide-tour-text">
                    <strong>${this.t(e.meta.title)}</strong>
                    ${e.meta.description ? `<span>${this.t(e.meta.description)}</span>` : ''}
                    <small>${meta}${e.completed ? ' · ✓' : ''}</small>
                    ${e.eligible ? '' : `<small class="guide-reason">${e.reason}</small>`}
                </div>
                ${e.eligible
                ? `<button data-slug="${e.slug}">${label}</button>`
                : `<button disabled>${label}</button>`}
            </li>`;
    }

    /**
     * §6.3: eligibility is evaluated BEFORE a tour is offered, so it can never fail halfway
     * through because the library skipped a known precondition. Draft entries are shown only
     * with an explicit development flag — a URL alone cannot enable them (§6.2).
     */
    async _eligibleEntries() {
        const allowDraft = new URLSearchParams(location.search).get('drafts') === '1';
        const level = await this._query('editor.level');
        const viewportWidth = await this._query('editor.viewportWidth');

        const out = [];
        for (const entry of this.catalog.tours) {
            const verdict = evaluateEligibility(entry, {
                source: 'editor', allowDraft, level, viewportWidth,
                commandExists: () => true,   // catalog-level check; the run re-checks properly
            });

            // §6.2: "Production catalogues show only published entries. Draft entries may be
            // enabled by an explicit development flag." Draft and deprecated are HIDDEN, not
            // shown disabled — an unfinished tour is not a tour the user is missing out on.
            // Everything else unavailable IS shown, with its reason (§6.3), because "needs a
            // wider screen" is information and silence is not.
            if (verdict.reason === 'draft' || verdict.reason === 'deprecated') continue;

            out.push({
                ...entry,
                eligible: verdict.eligible,
                reason: verdict.reason || '',
                completed: await this._query('tour.completed', { tourId: entry.id, version: entry.version }),
            });
        }
        return out;
    }

    _query(name, args) {
        return new Promise((resolve) => {
            const requestId = makeId('qry');
            const onReply = (e) => {
                const m = e.data;
                if (m?.protocol !== GUIDE_PROTOCOL || m.type !== 'QUERY_RESULT') return;
                if (m.payload?.requestId !== requestId) return;
                window.removeEventListener('message', onReply);
                resolve(m.payload.success ? m.payload.result : null);
            };
            window.addEventListener('message', onReply);
            this.send({ type: 'QUERY', payload: { requestId, name, args } });
            setTimeout(() => { window.removeEventListener('message', onReply); resolve(null); }, 5000);
        });
    }

    /* ── starting, leaving, completing — §6.5 ─────────────────────────────── */

    /**
     * `startTour('stage1-frames')` runs a published tour: found in the catalog, fetched by
     * definition. `startTour(tourObject)` runs one the caller already has — a story deck
     * handed over inline (SPEC-story-cards §5.3), where there is nothing to fetch and no
     * catalog entry to find.
     *
     * Everything after the two differ — validation, the run, both layouts — is shared, which
     * is the point: one runtime, two ways of getting steps into it.
     */
    async startTour(slugOrTour) {
        // Before anything else, and before any await: the previous run must not survive into
        // the new one. Every early return below funnels into showLibrary(), which calls
        // endRun() again — it is idempotent, so the double call is free.
        this.endRun();

        const inline = typeof slugOrTour === 'object' && slugOrTour !== null;
        const slug = inline ? (slugOrTour.slug || slugOrTour.id || 'inline') : slugOrTour;

        const entry = inline ? null : this.catalog.tours.find((t) => t.slug === slug);
        if (!inline && !entry) return this.showLibrary();

        const ack = await this.request('TOUR_SELECTED', { slug, source: 'editor' }, 'TOUR_READY');
        if (!ack || ack.type === 'TOUR_REJECTED') {
            console.warn('[guide] tour rejected:', slug, ack?.payload?.reason);
            return this.showLibrary();
        }

        const tour = inline ? slugOrTour : await fetchTour(entry.definition);
        if (!tour) {
            // §13: a broken definition returns to the library with the error on that card,
            // rather than leaving the user looking at an empty panel
            return this.showLibrary();
        }

        // An inline deck is validated by the SAME rules as a published tour — it arrived from a
        // URL fragment, so it is the less trustworthy of the two, and skipping validation
        // "because we just built it" is how a malformed deck would reach the panel.
        //
        // With ONE exception: content keys. A published tour carries i18n KEYS and is broken if
        // a key has no translation — that renders as visible nonsense, which is the failure the
        // check exists for. A deck carries the facilitator's own sentences, already in their
        // language, because there is nothing to translate them through; body() falls back to the
        // key itself precisely so they render verbatim. Validating those as keys rejected every
        // deck ever typed (BUG-05, second half): "no translation for content key
        // 'Це не тест — просто помічаємо кілька способів'".
        const errors = validateTour(tour, {
            knownCommands: knownCommandSet(),
            i18n: inline ? null : this.i18n,
        });
        if (errors.length) {
            console.error('[guide] invalid tour:', slug, errors);
            // A published tour falls back to the library. An inline deck has no library entry
            // to fall back TO — showing the catalog would answer "your deck is broken" with a
            // list of unrelated tours, so it says what happened instead.
            if (inline) return this._renderDeckRejected();
            return this.showLibrary();
        }

        this.runtime = new GuideRuntime({
            root: this.root, tour, i18n: this.i18n, sessionId: this.sessionId,
            session: this, tourRunId: ack.payload.tourRunId,
        });
        window.__guideRuntime = this.runtime;   // scenario/probe hook only
        this.runtime.start();
    }

    /** An inline deck that failed validation: say so, and offer the only useful action. */
    _renderDeckRejected() {
        this.root.innerHTML = `
            <div class="guide-panel">
                ${this.body('guide.deck.rejected')}
                <div class="guide-nav">
                    <button data-action="close">${this.t('guide.close')}</button>
                </div>
            </div>`;
        this.root.querySelector('[data-action="close"]')
            ?.addEventListener('click', () => this.closeGuide());
    }

    /** "All tours" — §6.5: leave this run, keep the session, show the catalog. */
    async leaveToLibrary() {
        // Ended before the round trip, not after: while LEAVE_TOUR is in flight the old run is
        // still listening, and a step watchdog firing in that window would paint a failure over
        // the library that is about to replace it.
        this.endRun();
        await this.request('LEAVE_TOUR', {}, 'TOUR_LEFT');
        this.showLibrary();
    }

    /** §6.6: Done does not destroy the guide; completion is persisted, then offered a next. */
    async showCompletion(tour) {
        // The run is OVER — the tour reached its last step. Ending it here is what makes
        // "finish a tour, then start another" clean: this is the exact path the bug report
        // describes ("після проходження гайду та перезапуску на новому турі"), and without it
        // the completed run stayed live underneath the completion panel and followed the user
        // into the next tour. §6.6 keeps the SESSION alive, not the run.
        this.endRun();
        await this.request('TOUR_COMPLETED', { tourId: tour.id, version: tour.version }, 'COMPLETION_RECORDED');
        this.root.innerHTML = `
            <div class="guide-panel">
                <h2>${this.t('guide.completed.title')}</h2>
                ${this.body('guide.completed.body')}
                <div class="guide-nav">
                    <button data-action="close">${this.t('guide.close')}</button>
                    <button data-action="another">${this.t('guide.completed.another')}</button>
                </div>
            </div>`;
        this.root.querySelector('[data-action="close"]').addEventListener('click', () => this.closeGuide());
        this.root.querySelector('[data-action="another"]').addEventListener('click', () => this.showLibrary());
    }

    closeGuide() {
        this.send({ type: 'CLOSE_GUIDE', payload: {} });
    }
}

/** Same-origin registry read for validation only — see the note in GuideSession.startTour. */
function knownCommandSet() {
    try {
        if (window.parent?.command) return new Set(Object.keys(window.parent.command));
    } catch (e) { /* cross-origin — validate without the registry check */ }
    return null;
}

async function fetchTour(definition) {
    try {
        const r = await fetch(`tours/${definition}`);
        if (!r.ok) throw new Error(`tour not found: ${definition}`);
        return await r.json();
    } catch (e) {
        console.error('[guide]', e);
        return null;
    }
}

/**
 * Load a locale bundle, MERGED OVER English rather than replacing it.
 *
 * A translation may be partial — a sidecar covers the steps someone has translated so far — and
 * a key that falls through renders as its own key, which is visible nonsense to the reader
 * (04-tour-format.md's "Validation" calls that out). English underneath means a half-translated
 * tour reads as half-translated rather than as broken.
 *
 * Falls back silently when the bundle is absent: `?lang=de` on a build with no German guide is
 * an ordinary state, not an error worth interrupting the user for.
 */
async function loadLocale(lang) {
    const english = await fetch('i18n/en.json').then((r) => r.json());
    if (!lang || lang === 'en') return english;

    // the language comes from a URL parameter; keep it to a plain language tag so it can only
    // ever name a bundle, never a path
    if (!/^[a-z]{2}$/.test(lang)) return english;

    // `uk` -> `ua`, mirroring LANGUAGE_ALIASES in ../localization.js. Duplicated rather than
    // imported because the guide is its own document and does not load the editor's scripts;
    // the editor normally passes its already-resolved code down, so this only matters when the
    // guide is opened directly with ?lang=uk. Both are deleted together when the bundles are
    // eventually renamed to the standard code.
    const bundle = lang === 'uk' ? 'ua' : lang;

    try {
        const r = await fetch(`i18n/${bundle}.json`);
        if (!r.ok) return english;
        return { ...english, ...await r.json() };
    } catch (e) {
        return english;
    }
}

async function boot() {
    const root = document.getElementById('guide-root');
    const sessionId = qs('session');
    const view = qs('view') || 'tour';
    const slug = qs('tour');
    const languageTag = String(qs('lang') || 'en').slice(0, 2).toLowerCase();
    const requestedLanguage = /^[a-z]{2}$/.test(languageTag) ? languageTag : 'en';
    if (document.documentElement) {
        document.documentElement.lang = requestedLanguage === 'ua' ? 'uk' : requestedLanguage;
    }

    if (!sessionId) {
        root.innerHTML = '<div class="guide-panel"><p>Missing session.</p></div>';
        return;
    }

    const [catalog, i18n] = await Promise.all([
        fetch('tours/index.json').then((r) => r.json()).catch(() => ({ tours: [] })),
        loadLocale(requestedLanguage),
    ]);

    const catalogErrors = validateCatalog(catalog);
    if (catalogErrors.length) {
        // §13: "catalog unavailable — show retry and close; do not show an empty unexplained
        // panel". An invalid manifest is the same class of failure.
        console.error('[guide] invalid catalog:', catalogErrors);
        root.innerHTML = `<div class="guide-panel"><p>${i18n['guide.library.broken'] ?? 'The tour catalog could not be read.'}</p></div>`;
        return;
    }

    const session = new GuideSession({ root, sessionId, catalog, i18n });
    window.__guideSession = session;   // scenario/probe hook only

    // ?inline=1 means the host is holding a tour object for us (guide-host.js inlineTour) —
    // a story deck that arrived in a URL fragment and was never a catalog entry. Same-origin,
    // so this is a direct read: the tour must exist before the runtime can send anything,
    // which makes the postMessage handshake the wrong shape for handing it over.
    let inlineTour = null;
    if (qs('inline') === '1') {
        try { inlineTour = window.parent?.GuideHost?.inlineTour(sessionId) ?? null; }
        catch (e) { console.error('[guide] inline tour unavailable:', e); }
    }

    if (inlineTour) await session.startTour(inlineTour);
    else if (view === 'library' || !slug) await session.showLibrary();
    else await session.startTour(slug);
}

boot();
