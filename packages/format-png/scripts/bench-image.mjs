// The images the benchmarks encode, generated so nothing large is committed.

/** A deterministic xorshift generator. */
function random(seed) {
    let state = seed;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 2 ** 32;
    };
}

/**
 * Smooth gradients plus noise. `amount` is how far a sample may move, and
 * `share` how many samples get noise: a little noise everywhere makes it as
 * hard to compress as a photo.
 */
export function image(width, height, amount, share) {
    const data = new Uint8Array(width * height * 4);
    const next = random(0x9e3779b9);
    const noise = () => (next() < share ? Math.round((next() * 2 - 1) * amount) : 0);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const u = x / width;
            const v = y / height;
            data[i] = 40 + 180 * u * (1 - v * 0.5) + noise();
            data[i + 1] = 60 + 120 * Math.sin(Math.PI * v) * (0.6 + 0.4 * u) + noise();
            data[i + 2] = 90 + 140 * (1 - u) * v + 20 * Math.sin(12 * u + 7 * v) + noise();
            data[i + 3] = 255;
        }
    }
    return { width, height, data };
}
