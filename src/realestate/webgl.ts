export function checkWebGL2Support(): boolean {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return true;
    }
    try {
        const testCanvas = document.createElement('canvas');
        const gl = testCanvas.getContext('webgl2');
        return Boolean(gl);
    } catch {
        return false;
    }
}

export function attachContextLossListeners(
    canvas: HTMLCanvasElement,
    onContextLost: (event: Event) => void,
    onContextRestored?: (event: Event) => void
): () => void {
    const handleLost = (e: Event) => {
        console.warn('[RealEstate3D] WebGL context lost! Triggering fallback mode...');
        e.preventDefault();
        onContextLost(e);
    };

    const handleRestored = (e: Event) => {
        console.log('[RealEstate3D] WebGL context restored.');
        if (onContextRestored) {
            onContextRestored(e);
        }
    };

    canvas.addEventListener('webglcontextlost', handleLost, false);
    if (onContextRestored) {
        canvas.addEventListener('webglcontextrestored', handleRestored, false);
    }

    return () => {
        canvas.removeEventListener('webglcontextlost', handleLost);
        if (onContextRestored) {
            canvas.removeEventListener('webglcontextrestored', handleRestored);
        }
    };
}
