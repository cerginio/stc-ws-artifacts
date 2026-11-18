"use strict";
// Condition evaluation — tilecraft/guide/v1/04-tour-format.md "Conditions and completion".
// Pure, DOM-free: operates on values already fetched (query results, event envelopes), never
// reaches into the DOM or the host itself. Browser global when loaded via <script>, CommonJS
// export when loaded under Node/vitest (tests/setup.js loadTilecraftScript pattern).

/**
 * [BUG-017] A real, finite number — the only thing gt/gte/lt/lte will compare.
 *
 * NaN is excluded too: every comparison against NaN is false anyway, so admitting it would
 * only make an ordering rule silently unsatisfiable instead of plainly rejected. Numeric
 * STRINGS are excluded deliberately — a query that answers "3" where a number was meant is a
 * bug in that query, and quietly coercing it here is what hides it.
 */
function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Evaluate a StateCondition against an already-fetched query result.
 * `truthy`/`falsy` per 04-tour-format.md: state() is untyped (boolean here, an emoji string
 * there, undefined elsewhere), so string equality is deliberately NOT the default path.
 */
function evalStateCondition(condition, value) {
    switch (condition.operator) {
        case 'truthy': return !!value;
        case 'falsy': return !value;
        case 'eq': return value === condition.value;
        case 'neq': return value !== condition.value;
        // [BUG-017] Relational operators compare NUMBERS ONLY, and a non-number answers false
        // rather than being coerced.
        //
        // A query says "no answer" by returning null or undefined — `frame.selected.index`
        // returns null when nothing is selected, exactly as documented. JavaScript's `>=`
        // then coerces: `null >= 0` is TRUE, so `frame.selected.index gte 0` — the rule
        // spelling "a frame is selected" — was satisfied by NOTHING BEING SELECTED. The step
        // completed on its first 250ms poll, the runtime took the highlight back as finished
        // business (_onCompleted -> _clearStepHighlight), and the ring vanished ~180ms after
        // it appeared while the panel still asked the person to choose a frame.
        //
        // `null`, `''`, `false` and `[]` all coerce to 0 this way, so every gte/lte rule with
        // a 0 threshold opened for an absent value. That is a gate that passes when the app
        // has reported nothing at all — the exact opposite of what a completion rule is for.
        case 'gt': return isNum(value) && isNum(condition.value) && value > condition.value;
        case 'gte': return isNum(value) && isNum(condition.value) && value >= condition.value;
        case 'lt': return isNum(value) && isNum(condition.value) && value < condition.value;
        case 'lte': return isNum(value) && isNum(condition.value) && value <= condition.value;
        case 'contains':
            if (Array.isArray(value) || typeof value === 'string') return value.includes(condition.value);
            return false;
        default:
            return false;
    }
}

/**
 * Match an EventCondition against a USER_ACTION envelope.
 * origin defaults to "user" (04-tour-format.md): otherwise a tour's own setup would satisfy
 * the step it was preparing (D7). `match` is a subset check on `data`, not deep equality —
 * a completion rule names the fields it cares about, not the whole payload shape.
 */
function evalEventCondition(condition, action) {
    if (!action) return false;
    if (action.event !== condition.event) return false;
    const wantOrigin = condition.origin ?? 'user';
    if (action.origin !== wantOrigin) return false;
    if (condition.match) {
        for (const [key, val] of Object.entries(condition.match)) {
            if (action.data?.[key] !== val) return false;
        }
    }
    return true;
}

/**
 * Evaluate a full Condition tree. `stateValues` maps query key (built by queryKey()) to its
 * fetched value; `action` is the USER_ACTION envelope being tested, or null when only state
 * conditions are being checked (e.g. a transition step's waitFor, polled rather than event-driven).
 */
function evalCondition(condition, { stateValues = {}, action = null } = {}) {
    if (!condition) return false;

    switch (condition.type) {
        case 'state':
            return evalStateCondition(condition, stateValues[queryKey(condition)]);
        case 'event':
            return evalEventCondition(condition, action);
        case 'all':
            return condition.conditions.every((c) => evalCondition(c, { stateValues, action }));
        case 'any':
            return condition.conditions.some((c) => evalCondition(c, { stateValues, action }));
        case 'not':
            return !evalCondition(condition.condition, { stateValues, action });
        default:
            return false;
    }
}

/** Stable key for a StateCondition's (query, args) pair — used to fetch/cache its value. */
function queryKey(condition) {
    return `${condition.query}:${JSON.stringify(condition.args ?? {})}`;
}

/** Collect every event name a condition tree (completion or waitFor) references. */
function collectEventNames(condition, out = new Set()) {
    if (!condition) return out;
    if (condition.type === 'event') out.add(condition.event);
    if (condition.type === 'all' || condition.type === 'any') {
        for (const c of condition.conditions) collectEventNames(c, out);
    }
    if (condition.type === 'not') collectEventNames(condition.condition, out);
    return out;
}

/** Collect every StateCondition (query, args) pair a condition tree references. */
function collectStateQueries(condition, out = []) {
    if (!condition) return out;
    if (condition.type === 'state') out.push({ query: condition.query, args: condition.args ?? {} });
    if (condition.type === 'all' || condition.type === 'any') {
        for (const c of condition.conditions) collectStateQueries(c, out);
    }
    if (condition.type === 'not') collectStateQueries(condition.condition, out);
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { evalCondition, evalStateCondition, evalEventCondition, queryKey, collectEventNames, collectStateQueries };
}
