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

export function actionKeepsCompatiblePair(action, state) {
    if (action === "update_core") {
        return state?.frontend?.installed === state?.frontend?.target;
    }
    if (action === "update_frontend") {
        return state?.frontend?.target === state?.frontend?.required;
    }
    return action === "update_both" || action === "repair_frontend";
}

export function shouldOfferPairedUpdate(state) {
    return Boolean(
        state?.core_update_available
        && state?.frontend?.update_available
    );
}

export function updateResultSummary(operation) {
    if (!operation) {
        return {
            tone: "warning",
            title: "ComfyUI restarted",
            message: "Open Settings → Updates to verify the update result.",
        };
    }

    if (operation.state === "completed") {
        if ((operation.environment_delta?.new_count || 0) > 0) {
            return {
                tone: "warning",
                title: "Update completed with new package warnings",
                message: "ComfyUI restarted successfully. Review Environment check in Settings → Updates before running another update.",
            };
        }
        return {
            tone: "success",
            title: "Update completed successfully",
            message: "ComfyUI restarted and is ready to use.",
        };
    }

    if (operation.state === "rolled_back") {
        return {
            tone: "warning",
            title: "Update safely reverted",
            message: "The update could not be completed, so the previous Core and Frontend were restored. Review Settings → Updates before trying again.",
        };
    }

    if (operation.state === "rollback_unverified") {
        return {
            tone: "warning",
            title: "Restore could not be verified",
            message: "The previous Core and Frontend were restored, but the environment check could not verify the result. Review the technical details in Settings → Updates.",
        };
    }

    if (operation.state === "rollback_failed") {
        return {
            tone: "danger",
            title: "Update and recovery failed",
            message: "Do not try another update. Review the technical details in Settings → Updates before continuing.",
        };
    }

    return {
        tone: "warning",
        title: "Update result needs review",
        message: "ComfyUI restarted. Open Settings → Updates to review the last operation.",
    };
}
