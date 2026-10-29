import { app } from "../../scripts/app.js";
import {
    CAPABILITIES_ROUTE,
    TOKEN_HEADER,
    UPDATE_ROUTE,
    UPDATES_ROUTE,
    hasCompletedUpdate,
    nextPollDelay,
} from "./update_control_core.mjs";

if (!document.getElementById("andreszs-update-control-styles")) {
    const stylesheet = document.createElement("link");
    stylesheet.id = "andreszs-update-control-styles";
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./update_control.css?v=0.1.0", import.meta.url).href;
    document.head.append(stylesheet);
}

const UPDATE_POLL_TIMEOUT_MS = 15 * 60 * 1000;

function apiRequest(route, options = {}) {
    return app.api.fetchApi(route, {
        cache: "no-store",
        credentials: "same-origin",
        ...options,
    });
}

async function readJson(response, context) {
    if (!response.ok) {
        let detail = `${context} failed (${response.status})`;
        try {
            const body = await response.json();
            if (body?.error) detail = body.error;
        } catch {
            // Keep the HTTP status when the server did not return JSON.
        }
        throw new Error(detail);
    }
    return response.json();
}

async function fetchCapabilities() {
    return readJson(await apiRequest(CAPABILITIES_ROUTE), "Capability check");
}

async function fetchUpdateState(capabilities, refresh = false) {
    const suffix = refresh ? "?refresh=1" : "";
    return readJson(
        await apiRequest(`${UPDATES_ROUTE}${suffix}`, {
            headers: { [TOKEN_HEADER]: capabilities.update_token },
        }),
        "Update check",
    );
}

async function submitUpdate(capabilities, action) {
    return readJson(
        await apiRequest(UPDATE_ROUTE, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                [TOKEN_HEADER]: capabilities.update_token,
            },
            body: JSON.stringify({ action }),
        }),
        "Update request",
    );
}

function setText(root, selector, value) {
    const element = root.querySelector(selector);
    if (element) element.textContent = value ?? "—";
}

function setBusy(root, busy) {
    root.setAttribute("aria-busy", String(busy));
    for (const button of root.querySelectorAll("button")) {
        button.disabled = busy || button.dataset.disabled === "true";
    }
}

function setUpdateBadge(root, selector, updateNeeded) {
    const badge = root.querySelector(selector);
    badge.textContent = updateNeeded ? "Update needed" : "Up to date";
    badge.classList.toggle("is-needed", updateNeeded);
    badge.classList.toggle("is-current", !updateNeeded);
}

function formatReleaseDate(value) {
    if (!value) return "Unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unavailable";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    }).format(date);
}

function lastOperationLabel(operation) {
    if (!operation) return "No update has been run by ComfyUI Updater.";
    const labels = {
        scheduled: "Update scheduled.",
        running: "Update worker is running.",
        completed: "The last update completed successfully.",
        rolled_back: "The last update failed and was rolled back.",
        rollback_failed: "The last update and its rollback failed. Check the log.",
        cancelled: "The last update was cancelled before handoff.",
    };
    return labels[operation.state] || `Last operation: ${operation.state}`;
}

function renderState(root, state) {
    const coreButton = root.querySelector("[data-update-core]");
    const frontendButton = root.querySelector("[data-update-frontend]");
    const bothButton = root.querySelector("[data-update-both]");
    const repairButton = root.querySelector("[data-frontend-repair]");
    root.querySelector("[data-update-check]").dataset.disabled = "false";

    if (!state.supported) {
        setText(root, "[data-update-message]", state.error || "Updates are unavailable.");
        root.querySelector("[data-update-message]").classList.add("is-error");
        for (const button of [coreButton, frontendButton, bothButton, repairButton]) {
            button.hidden = true;
        }
        return;
    }

    root.querySelector("[data-update-message]").classList.remove("is-error");
    setText(root, "[data-core-current]", state.current.version || state.current.commit?.slice(0, 10));
    setText(root, "[data-core-latest]", state.latest.version);
    setText(root, "[data-core-date-label]", state.latest.date_source === "git_tag" ? "Tagged commit" : "Released");
    setText(root, "[data-core-released]", formatReleaseDate(state.latest.published_at));
    setText(root, "[data-frontend-installed]", state.frontend.installed || "Not installed");
    setText(root, "[data-frontend-target]", state.frontend.target || state.latest.frontend);
    setText(root, "[data-frontend-released]", formatReleaseDate(state.frontend.target_published_at));
    setText(root, "[data-pair-target]", `Target pair: Core ${state.latest.version} · Frontend ${state.frontend.target}`);
    setText(
        root,
        "[data-release-date-source]",
        state.latest.date_source === "git_tag"
            ? "Core has no published GitHub Release; its tagged commit date is shown instead. Frontend uses its first non-yanked PyPI publication."
            : "Release dates: GitHub Releases for Core · first non-yanked PyPI publication for Frontend.",
    );
    setText(root, "[data-update-history]", lastOperationLabel(state.last_operation));
    setUpdateBadge(root, "[data-core-badge]", state.core_update_available);
    setUpdateBadge(root, "[data-frontend-badge]", state.frontend.update_available);

    coreButton.hidden = !state.core_update_available;
    coreButton.dataset.disabled = String(!state.core_update_allowed);
    coreButton.disabled = !state.core_update_allowed;
    coreButton.textContent = "Update Core";

    frontendButton.hidden = !state.frontend.update_available;
    frontendButton.dataset.disabled = String(!state.frontend_update_allowed);
    frontendButton.disabled = !state.frontend_update_allowed;
    frontendButton.textContent = "Update Frontend";

    bothButton.hidden = !state.combined_update_available;
    bothButton.dataset.disabled = String(!state.combined_update_allowed);
    bothButton.disabled = !state.combined_update_allowed;
    bothButton.textContent = "Update both";

    repairButton.hidden = state.frontend.compatible;
    repairButton.dataset.disabled = "false";
    repairButton.textContent = `Restore ${state.frontend.required}`;

    const compatibility = root.querySelector("[data-compatibility-warning]");
    compatibility.hidden = state.frontend.compatible;
    setText(
        root,
        "[data-compatibility-warning] span",
        `Installed Core expects Frontend ${state.frontend.required}.`,
    );

    if (state.current.dirty) {
        setText(root, "[data-update-message]", "Core updates are blocked by tracked local changes; Frontend can still be updated separately.");
    } else if (state.combined_update_available) {
        setText(root, "[data-update-message]", "Updates are available. Choose either component or the recommended paired update.");
    } else {
        setText(root, "[data-update-message]", "Core and Frontend are up to date.");
    }
}

async function waitForNewBoot(previousBootId) {
    const deadline = Date.now() + UPDATE_POLL_TIMEOUT_MS;
    let pollDelay = 750;
    let lastError = new Error("Timed out while waiting for the updated backend.");
    while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, pollDelay));
        try {
            const capabilities = await fetchCapabilities();
            if (hasCompletedUpdate(previousBootId, capabilities)) return;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
        pollDelay = nextPollDelay(pollDelay);
    }
    throw lastError;
}

async function confirmUpdate(action, state) {
    const dialogs = {
        update_core: {
            title: "Update Core only",
            message: `Install Core ${state.latest.version} and keep Frontend ${state.frontend.installed}? The versions may not be compatible.`,
        },
        update_frontend: {
            title: "Update Frontend only",
            message: `Install Frontend ${state.frontend.target} and keep Core ${state.current.version}? The versions may not be compatible.`,
        },
        update_both: {
            title: "Update Core and Frontend",
            message: `Install the recommended pair: Core ${state.latest.version} and Frontend ${state.frontend.target}?`,
        },
        repair_frontend: {
            title: "Restore compatible Frontend",
            message: `Reinstall Frontend ${state.frontend.required}, the version expected by the installed Core?`,
        },
    };
    const dialog = dialogs[action];
    return app.extensionManager.dialog.confirm({
        title: dialog.title,
        message: `${dialog.message} ComfyUI will restart and active jobs will be interrupted.`,
    });
}

function renderUpdateSettings() {
    const root = document.createElement("section");
    root.className = "andreszs-update-control";
    root.innerHTML = `
        <header class="andreszs-update-control-heading">
            <div>
                <strong>ComfyUI updates</strong>
                <span>Core and Frontend can be managed independently.</span>
            </div>
            <button type="button" data-update-check>Check for updates</button>
        </header>
        <div class="andreszs-update-control-grid">
            <article class="andreszs-update-control-card">
                <header>
                    <div>
                        <strong>ComfyUI Core</strong>
                        <span>Stable release</span>
                    </div>
                    <span class="andreszs-update-badge" data-core-badge>Checking…</span>
                </header>
                <dl>
                    <div><dt>Installed</dt><dd data-core-current>Checking…</dd></div>
                    <div><dt>Latest</dt><dd data-core-latest>—</dd></div>
                    <div><dt data-core-date-label>Released</dt><dd data-core-released>—</dd></div>
                </dl>
                <button type="button" class="andreszs-card-action" data-update-core hidden>Update Core</button>
            </article>
            <article class="andreszs-update-control-card">
                <header>
                    <div>
                        <strong>Frontend</strong>
                        <span>Stable target paired with latest Core</span>
                    </div>
                    <span class="andreszs-update-badge" data-frontend-badge>Checking…</span>
                </header>
                <dl>
                    <div><dt>Installed</dt><dd data-frontend-installed>Checking…</dd></div>
                    <div><dt>Latest</dt><dd data-frontend-target>—</dd></div>
                    <div><dt>Released</dt><dd data-frontend-released>—</dd></div>
                </dl>
                <button type="button" class="andreszs-card-action" data-update-frontend hidden>Update Frontend</button>
            </article>
        </div>
        <aside class="andreszs-update-recommendation">
            <div>
                <strong>Recommended: update both together</strong>
                <span>Core and Frontend releases are tested as a version pair. Separate updates remain available above.</span>
                <span class="andreszs-update-pair-target" data-pair-target>Reading target pair…</span>
            </div>
            <button type="button" class="is-primary" data-update-both hidden>Update both</button>
        </aside>
        <div class="andreszs-update-compatibility" data-compatibility-warning hidden>
            <span></span>
            <button type="button" data-frontend-repair>Restore compatible Frontend</button>
        </div>
        <div class="andreszs-update-control-status">
            <p class="andreszs-update-control-message" data-update-message>Reading local versions…</p>
            <p class="andreszs-update-control-history" data-update-history></p>
            <p class="andreszs-update-control-source" data-release-date-source>Checking authoritative release dates…</p>
        </div>
    `;

    let capabilities = null;
    let state = null;
    const refresh = async (remote) => {
        setBusy(root, true);
        setText(root, "[data-update-message]", remote ? "Checking the stable release channel…" : "Reading local versions…");
        try {
            capabilities = await fetchCapabilities();
            state = await fetchUpdateState(capabilities, remote);
            renderState(root, state);
        } catch (error) {
            const updateError = error instanceof Error ? error : new Error(String(error));
            setText(root, "[data-update-message]", updateError.message);
            root.querySelector("[data-update-message]").classList.add("is-error");
        } finally {
            setBusy(root, false);
        }
    };

    const startAction = async (action) => {
        if (!state || !capabilities || !await confirmUpdate(action, state)) return;
        setBusy(root, true);
        try {
            const previousBootId = capabilities.boot_id;
            await submitUpdate(capabilities, action);
            const progress = {
                update_core: "Updating Core and keeping the installed Frontend…",
                update_frontend: "Updating Frontend and keeping the installed Core…",
                update_both: "Updating Core and Frontend as a matched pair…",
                repair_frontend: "Restoring the Frontend expected by the installed Core…",
            };
            setText(root, "[data-update-message]", `${progress[action]} Keep this page open.`);
            await waitForNewBoot(previousBootId);
            location.reload();
        } catch (error) {
            const updateError = error instanceof Error ? error : new Error(String(error));
            setText(root, "[data-update-message]", updateError.message);
            root.querySelector("[data-update-message]").classList.add("is-error");
            setBusy(root, false);
        }
    };

    root.querySelector("[data-update-check]").addEventListener("click", () => void refresh(true));
    root.querySelector("[data-update-core]").addEventListener("click", () => void startAction("update_core"));
    root.querySelector("[data-update-frontend]").addEventListener("click", () => void startAction("update_frontend"));
    root.querySelector("[data-update-both]").addEventListener("click", () => void startAction("update_both"));
    root.querySelector("[data-frontend-repair]").addEventListener("click", () => void startAction("repair_frontend"));
    void refresh(false);
    return root;
}

app.registerExtension({
    name: "andreszs.ComfyUIUpdater",
    settings: [
        {
            id: "andreszs.ComfyUIUpdater.Panel",
            name: "",
            category: ["Updates", "ComfyUI", "Updater"],
            type: renderUpdateSettings,
            defaultValue: null,
            sortOrder: 100,
        },
    ],
});


