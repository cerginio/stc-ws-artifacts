importScripts('../_bundle-workers.js');

/*importScripts('../_bundle-workers.js');*/

postMessage({ type: 'ready', buildId: typeof TILECRAFT_BUILD_ID === 'string' ? TILECRAFT_BUILD_ID : '__BUILD_ID__' });

function toggle() {
    // throttling efffect
    commonState.cancel = !commonState.cancel;
}

onmessage = function (event) {
    const data = event.data;

    if (data.cmd == "skip" && data.layer.tiles.length > 1000) {
        toggle();
    }
    // TODO: adjust timeout depending from execution time
    iterationLimit = 15 * 1000 * 1000;
    executionTimeout = 1 * 1000;

    // layerChangeKey (optimization.js) — cheap signature by default, hashSum when
    // useCheapVisibilityGuard is off. hashSum cost ~3x the pass it guards at 46k tiles.
    const lHash = layerChangeKey(data.layer);
    if (lHash == layerHashes[data.taskContext.layerId]) return;
    layerHashes[data.taskContext.layerId] = lHash;

    let result = applyTilesVisibilityDeepOptimization(data.layer, data.taskContext);
    markIsNewResult(data, result);

    postMessage(result);

};

function markIsNewResult(data, result) {
    const layerId = data.taskContext.layerId;
    const prevGroupingResult = commonState.previousGroupingResults['l' + layerId] ?? { count: 0 };

    let isNew = !(result.g == prevGroupingResult.g
        && result.h == prevGroupingResult.h
        && result.v == prevGroupingResult.v
    );
    result.isNew = isNew;
    result.count = ++prevGroupingResult.count;
    commonState.previousGroupingResults['l' + layerId] = result;

    if (result.isNew) { // || !data.active
        // debug info, filter old for active layer
        console.log('#' + layerId + (result.isNew ? ' new' : ' old') + ' grp: ' + result.g + ' hid: ' + result.h + ' vis: ' + result.v + ' (' + result.count + ')');
    }
}
