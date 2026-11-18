"use strict";

const createSurface = (width, height) => {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
};

/**
 * Прев’ю всієї історії з растрів кадрів: авторські позиції, чорне тло й білі аркуші.
 * @param {any} model model — джерело історії.
 * @param {{rasterizer?: any, width?: number, height?: number, padding?: number, auraHull?: boolean, createCanvas?: (width: number, height: number) => any}} [options] options — растеризатор, розмір прев’ю та аура.
 */
export function renderStoryPreview(model, { rasterizer, width = 865, height = 500,
    padding = 20, auraHull = true, createCanvas = createSurface } = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || !Number.isFinite(padding) || padding < 0 || padding * 2 >= Math.min(width, height)) {
        throw new TypeError('story-preview: invalid-size');
    }
    if (typeof rasterizer?.rasterizeFrame !== 'function') throw new TypeError('story-preview: rasterizer-unavailable');
    if (!Array.isArray(model?.frames) || !Array.isArray(model?.layers)) throw new TypeError('story-preview: invalid-model');
    const frames = model.frames.filter(frame => !frame.hid);
    if (!frames.length) throw new TypeError('story-preview: no-visible-frames');
    const ids = new Set();
    for (const frame of frames) {
        if (!Number.isInteger(frame.id) || ids.has(frame.id)
            || !Array.isArray(frame.points) || frame.points.length !== 4
            || !frame.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) {
            throw new TypeError('story-preview: invalid-frame');
        }
        ids.add(frame.id);
        const [a, b, c, d] = frame.points;
        const u = { x: b.x - a.x, y: b.y - a.y };
        const v = { x: d.x - a.x, y: d.y - a.y };
        if (Math.hypot(u.x, u.y) <= 0 || Math.hypot(v.x, v.y) <= 0
            || Math.abs(u.x * v.y - u.y * v.x) < 1e-8
            || Math.abs(u.x * v.x + u.y * v.y) > Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) * 1e-6
            || Math.hypot(c.x - b.x - d.x + a.x, c.y - b.y - d.y + a.y) > 1e-6) {
            throw new TypeError('story-preview: unsupported-quad');
        }
    }
    const points = frames.flatMap(frame => frame.points);
    const minX = Math.min(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y));
    const storyWidth = Math.max(...points.map(point => point.x)) - minX;
    const storyHeight = Math.max(...points.map(point => point.y)) - minY;
    const scale = Math.min((width - padding * 2) / storyWidth, (height - padding * 2) / storyHeight);
    const left = (width - storyWidth * scale) / 2;
    const top = (height - storyHeight * scale) / 2;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('story-preview: context-unavailable');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    for (const frame of frames) {
        const [a, b, , d] = frame.points;
        const frameWidth = Math.hypot(b.x - a.x, b.y - a.y);
        const frameHeight = Math.hypot(d.x - a.x, d.y - a.y);
        // Вільні тайли не належать аркушу; hideOtherTiles сам не ізолює моделі без vcam.
        const source = { ...model, layers: model.layers.map(layer => ({ ...layer,
            tiles: (layer.tiles ?? []).filter(tile => tile && tile.f === frame.id) })) };
        const raster = rasterizer.rasterizeFrame(source, frame.id, {
            scale, cw: Math.ceil(frameWidth * scale) + 1, ch: Math.ceil(frameHeight * scale) + 1,
            background: '#ffffff', bgColor: '#ffffff', hideOtherTiles: true, auraHull,
        });
        ctx.save();
        ctx.transform((b.x - a.x) * scale / raster.width, (b.y - a.y) * scale / raster.width,
            (d.x - a.x) * scale / raster.height, (d.y - a.y) * scale / raster.height,
            left + (a.x - minX) * scale, top + (a.y - minY) * scale);
        ctx.drawImage(raster.canvas, 0, 0);
        ctx.restore();
    }
    return { canvas, width, height, frameIds: frames.map(frame => frame.id), scale };
}
