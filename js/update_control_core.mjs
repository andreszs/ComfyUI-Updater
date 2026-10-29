export const CAPABILITIES_ROUTE = "/comfyui-updater/capabilities";
export const UPDATES_ROUTE = "/comfyui-updater/status";
export const UPDATE_ROUTE = "/comfyui-updater/apply";
export const TOKEN_HEADER = "X-ComfyUI-Updater-Token";

export function hasCompletedUpdate(previousBootId, capabilities) {
    return Boolean(
        capabilities?.available
        && capabilities.boot_id
        && capabilities.boot_id !== previousBootId
    );
}

export function nextPollDelay(currentDelay) {
    return Math.min(Math.round(currentDelay * 1.5), 5000);
}
