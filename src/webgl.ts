let available: boolean | undefined;

/** Probe WebGL once so decorative models can skip straight to their fallback (and avoid console errors) when it is unavailable. */
export function hasWebGL() {
  if (available === undefined) {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      available = !!gl;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { available = false; }
  }
  return available;
}

export function markWebGLUnavailable() { available = false; }
