"use strict";
// Tour catalog — 07-guide-library-and-tour-switching.md §6.2/§6.3.
//
// The browser cannot list a directory, so the tours a user may start are declared in an
// explicit manifest. This module validates that manifest and answers "may this tour start
// here, right now" — both pure, both DOM-free, so the rules are testable as data rather than
// as a browser scenario.
//
// Browser global when loaded via <script>, CommonJS export under Node/vitest.

/** §6.2: a resource locator, not an identity. Kept strict so it can never escape the folder. */
const CATALOG_SLUG_RX = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate a catalog manifest.
 *
 * The path rules are the security-relevant part: `definition` becomes a fetch, and tour
 * selection must never turn user input into an unrestricted one. A slug arriving from
 * `?guide=<slug>` is matched against the manifest rather than concatenated into a path, so an
 * attacker-supplied value can only ever select an entry that was already published.
 *
 * @returns {string[]} errors; empty when the manifest is usable
 */
function validateCatalog(catalog) {
    const errors = [];
    const err = (m) => errors.push(m);

    if (!catalog || typeof catalog !== 'object') return ['catalog must be an object'];
    if (!Array.isArray(catalog.tours)) return ['catalog.tours must be an array'];

    const seenSlugs = new Set();
    const seenIds = new Set();

    for (const entry of catalog.tours) {
        const where = entry?.slug || entry?.id || '(unnamed entry)';

        if (!entry.slug || !CATALOG_SLUG_RX.test(entry.slug)) {
            err(`"${where}": slug must match ${CATALOG_SLUG_RX}`);
        } else if (seenSlugs.has(entry.slug)) {
            err(`duplicate slug: ${entry.slug}`);
        } else {
            seenSlugs.add(entry.slug);
        }

        if (!entry.id) err(`"${where}": id missing`);
        else if (seenIds.has(entry.id)) err(`duplicate tour id: ${entry.id}`);
        else seenIds.add(entry.id);

        if (!(Number(entry.version) >= 1)) err(`"${where}": version < 1`);

        if (!['draft', 'published', 'deprecated'].includes(entry.status)) {
            err(`"${where}": unknown status "${entry.status}"`);
        }

        if (typeof entry.definition !== 'string' || !entry.definition) {
            err(`"${where}": definition missing`);
        } else if (!isSafeDefinitionPath(entry.definition)) {
            err(`"${where}": definition must be a plain manifest-relative path`);
        }

        if (!entry.meta?.title) err(`"${where}": meta.title missing`);
    }

    return errors;
}

/** No scheme, host, query, fragment, absolute root or `..` segment (§6.2). */
function isSafeDefinitionPath(path) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;   // scheme
    if (path.startsWith('//') || path.startsWith('/')) return false;
    if (/[?#]/.test(path)) return false;
    if (path.split('/').includes('..')) return false;
    return true;
}

/**
 * Is this entry startable here and now (§6.3)?
 *
 * `state` carries what only the host can answer: which commands exist and are usable, the
 * editor level, the viewport. Returning a REASON rather than a boolean is deliberate — §6.3
 * says unavailable tours may be shown disabled with a localized reason, and "it just isn't
 * there" is the least helpful thing a library can say.
 *
 * @returns {{eligible: boolean, reason?: string}}
 */
function evaluateEligibility(entry, {
    source = 'editor',
    allowDraft = false,
    commandExists = () => true,
    commandDisabled = () => false,
    level = null,
    viewportWidth = null,
    requirements = null,
} = {}) {
    if (entry.status === 'deprecated') return { eligible: false, reason: 'deprecated' };
    if (entry.status === 'draft' && !allowDraft) return { eligible: false, reason: 'draft' };

    const allowed = entry.launch?.allowedSources;
    if (allowed && !allowed.includes(source)) {
        return { eligible: false, reason: `not available from ${source}` };
    }

    // requirements may live on the catalog entry (so the library can filter without fetching
    // every definition) or on the definition itself once loaded
    const req = requirements ?? entry.requirements;
    if (!req) return { eligible: true };

    for (const id of req.commands || []) {
        if (!commandExists(id)) return { eligible: false, reason: `needs ${id}` };
        if (commandDisabled(id)) return { eligible: false, reason: `${id} is unavailable here` };
    }

    if (req.minLevel !== undefined && !(Number(level) >= req.minLevel)) {
        return { eligible: false, reason: `needs level ${req.minLevel}` };
    }

    if (req.minViewport?.width !== undefined
        && viewportWidth !== null
        && viewportWidth < req.minViewport.width) {
        return { eligible: false, reason: `needs a ${req.minViewport.width}px wide screen` };
    }

    return { eligible: true };
}

/**
 * Completion is keyed by `tour.id + tour.version`, never by slug (ADR-0017 D17c): the slug says
 * which file, the id says which tour. A version bump means not-yet-completed, which is exactly
 * why 04-tour-format.md says to bump `version` on behavioural change and not on copy edits.
 */
function completionKey(tourId, version) {
    return `guide.completed.${tourId}@${version}`;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CATALOG_SLUG_RX, validateCatalog, isSafeDefinitionPath,
        evaluateEligibility, completionKey,
    };
}
