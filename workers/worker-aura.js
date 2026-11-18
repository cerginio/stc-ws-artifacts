"use strict";

importScripts('../_bundle-workers.js');

self.onmessage = ({ data }) => {
    try {
        const layers = data.snapshot.map(({ props, tiles }) => ({
            visible: props[0], tileShape: props[1], gridSize: props[2], scale: props[3],
            tiles: tiles.map(tile => ({ ...tile, f: data.frameId })),
        }));
        self.postMessage({ id: data.id, modelGeneration: data.modelGeneration,
            contours: self.aura2d.build({ layers }, data.frameId) });
    } catch (error) {
        self.postMessage({ id: data.id, modelGeneration: data.modelGeneration, error: String(error) });
    }
};
