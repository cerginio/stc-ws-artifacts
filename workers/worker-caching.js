importScripts('../_bundle-workers.js');

/*importScripts('../_bundle-workers.js');*/

postMessage({ type: 'ready', buildId: typeof TILECRAFT_BUILD_ID === 'string' ? TILECRAFT_BUILD_ID : '__BUILD_ID__' });

onmessage = async function (event) {
    const data = event.data;

    if (data.layer && data.layer.visible) {

        const lHash = hashSum(data.layer);
        const layersOrderHash = hashSum(layerHashes);
        if (previousLayerHashesOrder == layersOrderHash) {
            if (lHash == layerHashes[data.taskContext.layerId]) return;
        }
        // REFRESH
        layerHashes[data.taskContext.layerId] = lHash;
        previousLayerHashesOrder = hashSum(layerHashes);

        // REDRAW
        const cacheData = redrawCache(data.layer, data.taskContext);

        if (!cacheData.offscreenCanvas) return;

        const offscreenCtx = cacheData.offscreenCanvas.getContext("2d", { willReadFrequently: false });
        // DEBUG
        //addDebugSquares(offscreenCtx, cacheData);

        const imageData = offscreenCtx.getImageData(0, 0, data.taskContext.cw, data.taskContext.ch);

        postMessage(
            {
                d: imageData.data,
                i: cacheData.i
            },
            [imageData.data.buffer]
        );
    }


    if (data.layers && data.layers.length > 0) {
        const result = batchRedrawCache(data.layers, data.taskContext);

        // Send the result back to the main thread
        for (let cacheData of result) {

            if (!cacheData.offscreenCanvas) continue;

            const offscreenCtx = cacheData.offscreenCanvas.getContext("2d", { willReadFrequently: false });

            //addDebugSquares(offscreenCtx, cacheData);

            const imageData = offscreenCtx.getImageData(0, 0, data.options.cw, data.options.ch);

            // Send the pixel data back to the main thread
            postMessage(
                {
                    d: imageData.data,
                    i: cacheData.i
                },
                [imageData.data.buffer]
            );

        }
    }
};


function redrawCache(layer, taskContext) {
    const activeLayer = taskContext.activeLayer;
    const globalChange = taskContext.globalChangeInvalidatedLayersCache;
    const layerId = taskContext.layerId;

    if (globalChange || layerId == activeLayer) {

        let offscreenCanvas = storeLayerToImageCache(layer, taskContext);

        return {
            i: layerId,
            offscreenCanvas: offscreenCanvas
        }
    }

    return {
        i: layerId
    }
}

function batchRedrawCache(layers, taskContext) {

    const activeLayer = taskContext.activeLayer;
    const globalChange = taskContext.globalChangeInvalidatedLayersCache;
    const result = [];

    for (let i = 0; i < layers.length; i++) {

        if (globalChange || i == activeLayer) {

            let offscreenCanvas = storeLayerToImageCache(layers[i], taskContext);
            if (offscreenCanvas) {
                result.push({
                    i: i,
                    offscreenCanvas: offscreenCanvas
                });
            }
        }
    }

    return result;
}

// DEBUG
const debugColors = ['red', 'green', 'blue', 'white', 'cyan', 'magenta', 'yellow'];
function addDebugSquares(offscreenCtx, cacheData) {
    offscreenCtx.fillStyle = debugColors[cacheData.i] ?? debugColors[cacheData.i - debugColors.length] ?? 'red';
    offscreenCtx.fillRect(30 * cacheData.i, 30 * cacheData.i, 100, 100);
    offscreenCtx.fillRect(0, 0, 20, 20);
}
