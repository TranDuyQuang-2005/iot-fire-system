// Replace only after the Cloudflare Worker deployment and health check pass.
// This fail-safe hostname prevents an accidental release against a laptop or VM.
export const webServerUrl = 'https://configure-iot-fire-worker.invalid';
