import { app } from "../../scripts/app.js";
import {
    CAPABILITIES_ROUTE,
    TOKEN_HEADER,
    UPDATE_ROUTE,
    UPDATES_ROUTE,
    actionKeepsCompatiblePair,
    hasCompletedUpdate,
    nextPollDelay,
    shouldOfferPairedUpdate,
    updateResultSummary,
} from "./update_control_core.mjs";

if (!document.getElementById("andreszs-update-control-styles")) {
    const stylesheet = document.createElement("link");
    stylesheet.id = "andreszs-update-control-styles";
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./update_control.css?v=0.1.1", import.meta.url).href;
    document.head.append(stylesheet);
}

const UPDATE_SLOW_THRESHOLD_MS = 15 * 60 * 1000;
const ROLLBACK_PREFERENCE_KEY = "andreszs.ComfyUIUpdater.rollbackOnConflicts";
const UPDATE_SESSION_KEY = "andreszs.ComfyUIUpdater.activeUpdate";
const UPDATE_OVERLAY_ID = "andreszs-update-overlay";
const SETTINGS_SESSIONS = new WeakMap();
let updateGuardActive = false;

function settingsDialogFor(root) {
    return root.closest('[role="dialog"], .p-dialog') || document;
}

function settingsSession(root) {
    const dialog = settingsDialogFor(root);
    let session = SETTINGS_SESSIONS.get(dialog);
    if (session) return session;

    session = {
        capabilities: null,
        state: null,
        pending: null,
    };
    SETTINGS_SESSIONS.set(dialog, session);

    if (dialog !== document) {
        const clear = () => SETTINGS_SESSIONS.delete(dialog);
        const closeButton = dialog.querySelector(
            '.p-dialog-header-close, .p-dialog-close-button, button[aria-label="Close"]',
        );
        closeButton?.addEventListener("click", clear, { once: true });

        const observer = new MutationObserver(() => {
            if (!dialog.isConnected) {
                clear();
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    return session;
}

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

async function submitUpdate(capabilities, action, rollbackOnConflicts) {
    return readJson(
        await apiRequest(UPDATE_ROUTE, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                [TOKEN_HEADER]: capabilities.update_token,
            },
            body: JSON.stringify({
                action,
                rollback_on_conflicts: rollbackOnConflicts,
            }),
        }),
        "Update request",
    );
}

function readActiveUpdate() {
    try {
        const record = JSON.parse(sessionStorage.getItem(UPDATE_SESSION_KEY));
        if (
            record
            && typeof record === "object"
            && typeof record.action === "string"
            && typeof record.previousBootId === "string"
        ) {
            return record;
        }
    } catch {
        // A blocked or corrupt session store must not prevent the Settings panel loading.
    }
    return null;
}

function writeActiveUpdate(record) {
    try {
        sessionStorage.setItem(UPDATE_SESSION_KEY, JSON.stringify(record));
        return true;
    } catch {
        return false;
    }
}

function clearActiveUpdate() {
    try {
        sessionStorage.removeItem(UPDATE_SESSION_KEY);
    } catch {
        // The in-memory overlay can still be dismissed when storage is unavailable.
    }
}

function updateDescription(action, state) {
    const descriptions = {
        update_core: `Installing Core ${state.latest.version} and keeping Frontend ${state.frontend.installed}.`,
        update_frontend: `Installing Frontend ${state.frontend.target} and keeping Core ${state.current.version}.`,
        update_both: `Installing the tested pair: Core ${state.latest.version} and Frontend ${state.frontend.target}.`,
        repair_frontend: `Restoring Frontend ${state.frontend.required}, the version expected by Core ${state.current.version}.`,
    };
    return descriptions[action] || "Installing the selected ComfyUI update.";
}

function warnBeforeUnload(event) {
    event.preventDefault();
    event.returnValue = "";
}

function blockUpdateKeyboard(event) {
    if (!updateGuardActive) return;
    const overlay = document.getElementById(UPDATE_OVERLAY_ID);
    if (overlay?.classList.contains("is-result") && overlay.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    overlay?.focus({ preventScroll: true });
}

function startUpdateGuard() {
    if (updateGuardActive) return;
    updateGuardActive = true;
    document.body.classList.add("andreszs-update-locked");
    document.addEventListener("keydown", blockUpdateKeyboard, true);
    window.addEventListener("beforeunload", warnBeforeUnload);
}

function allowAutomaticReload() {
    window.removeEventListener("beforeunload", warnBeforeUnload);
}

function stopUpdateGuard() {
    updateGuardActive = false;
    document.body.classList.remove("andreszs-update-locked");
    document.removeEventListener("keydown", blockUpdateKeyboard, true);
    window.removeEventListener("beforeunload", warnBeforeUnload);
}

function ensureUpdateOverlay(record) {
    let overlay = document.getElementById(UPDATE_OVERLAY_ID);
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = UPDATE_OVERLAY_ID;
        overlay.className = "andreszs-update-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-labelledby", "andreszs-update-overlay-title");
        overlay.setAttribute("aria-describedby", "andreszs-update-overlay-description");
        overlay.tabIndex = -1;
        overlay.innerHTML = `
            <section class="andreszs-update-progress-dialog">
                <div class="andreszs-update-spinner" data-update-overlay-spinner aria-hidden="true"></div>
                <div class="andreszs-update-progress-copy">
                    <span class="andreszs-update-progress-eyebrow">ComfyUI Updater</span>
                    <h2 id="andreszs-update-overlay-title" data-update-overlay-title>Updating ComfyUI</h2>
                    <p id="andreszs-update-overlay-description" data-update-overlay-description></p>
                    <p class="andreszs-update-progress-status" data-update-overlay-status aria-live="polite"></p>
                    <p class="andreszs-update-progress-notice" data-update-overlay-notice>
                        Do not close this window or stop ComfyUI. It will restart automatically when the update finishes.
                    </p>
                </div>
                <div class="andreszs-update-result-actions" data-update-result-actions hidden>
                    <button type="button" data-update-result-close>Continue</button>
                </div>
            </section>
        `;
        overlay.querySelector("[data-update-result-close]").addEventListener("click", () => {
            clearActiveUpdate();
            stopUpdateGuard();
            overlay.remove();
        });
        document.body.append(overlay);
    }
    overlay.querySelector("[data-update-overlay-description]").textContent = record.description
        || "Installing the selected ComfyUI update.";
    startUpdateGuard();
    overlay.focus({ preventScroll: true });
    return overlay;
}

function showUpdateProgress(record, phase) {
    const overlay = ensureUpdateOverlay(record);
    const messages = {
        preparing: "Preparing the update…",
        installing: "Installing the update. This may take several minutes…",
        offline: "ComfyUI is temporarily offline while the update is installed. Waiting for the automatic restart…",
        slow: "The update is taking longer than expected. ComfyUI Updater is still waiting for the automatic restart…",
        restarted: "ComfyUI restarted successfully. Verifying the update result…",
        resuming: "Reconnecting to the ComfyUI update…",
    };
    overlay.classList.remove("is-result", "is-success", "is-warning", "is-danger");
    overlay.querySelector("[data-update-overlay-spinner]").hidden = false;
    overlay.querySelector("[data-update-overlay-title]").textContent = "Updating ComfyUI";
    overlay.querySelector("[data-update-overlay-status]").hidden = false;
    overlay.querySelector("[data-update-overlay-status]").textContent = messages[phase] || messages.installing;
    overlay.querySelector("[data-update-overlay-notice]").hidden = false;
    overlay.querySelector("[data-update-result-actions]").hidden = true;
}

function renderUpdateResult(record, summary) {
    const overlay = ensureUpdateOverlay(record);
    overlay.classList.add("is-result", `is-${summary.tone}`);
    overlay.querySelector("[data-update-overlay-spinner]").hidden = true;
    overlay.querySelector("[data-update-overlay-title]").textContent = summary.title;
    overlay.querySelector("[data-update-overlay-description]").textContent = summary.message;
    overlay.querySelector("[data-update-overlay-status]").hidden = true;
    overlay.querySelector("[data-update-overlay-notice]").hidden = true;
    overlay.querySelector("[data-update-result-actions]").hidden = false;
    allowAutomaticReload();
    clearActiveUpdate();
    overlay.querySelector("[data-update-result-close]").focus({ preventScroll: true });
}

function showUpdateResult(record, operation) {
    const matchesJob = !record.jobId || operation?.job_id === record.jobId;
    renderUpdateResult(record, updateResultSummary(matchesJob ? operation : null));
}

function showUpdateFailure(record, error) {
    renderUpdateResult(record, {
        tone: "danger",
        title: "Update could not be started",
        message: error instanceof Error ? error.message : String(error),
    });
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
        rollback_unverified: "The last update was rolled back, but the environment check could not confirm the result.",
        rollback_failed: "The last update and its rollback failed. Check the log.",
        cancelled: "The last update was cancelled before handoff.",
    };
    return labels[operation.state] || `Last operation: ${operation.state}`;
}

function renderEnvironmentHealth(root, state) {
    const health = state.environment;
    const operation = state.last_operation;
    const delta = operation?.environment_delta;
    const badge = root.querySelector("[data-environment-badge]");
    const details = root.querySelector("[data-environment-details]");
    const issueList = root.querySelector("[data-environment-issues]");
    let badgeText = "Not checked";
    let badgeClass = "is-unknown";
    let summary = "Package compatibility could not be checked.";
    let recommendation = "You can update, but the result cannot be verified automatically.";
    let technicalIssues = health?.issues || [];

    if (operation?.state === "rollback_failed") {
        badgeText = "Action required";
        badgeClass = "is-danger";
        summary = "The last update failed and the previous version could not be fully restored.";
        recommendation = "Do not try another update. Keep ComfyUI closed if it is not working and use the technical details when asking for support.";
        technicalIssues = operation.environment_delta?.new || technicalIssues;
    } else if (operation?.state === "rollback_unverified") {
        badgeText = "Restore not verified";
        badgeClass = "is-warning";
        summary = "The updater restored the previous Core and Frontend, but could not verify all shared software afterward.";
        recommendation = "If ComfyUI opens and your usual workflow runs, keep the current version. Otherwise, do not try another update and include the technical details when asking for support.";
    } else if (operation?.state === "rolled_back" && delta?.new_count > 0) {
        badgeText = "Update safely reverted";
        badgeClass = "is-warning";
        summary = "The attempted update created new compatibility problems, so ComfyUI Updater restored the previous version.";
        recommendation = "Keep the current version for now and do not repeat the same update. The technical details can be included in a bug report.";
        technicalIssues = delta.new;
    } else if (operation?.state === "completed" && delta?.available) {
        badgeText = delta.new_count > 0 ? `${delta.new_count} new ${delta.new_count === 1 ? "problem" : "problems"}` : "Update verified";
        badgeClass = delta.new_count > 0 ? "is-danger" : "is-healthy";
        summary = delta.new_count > 0
            ? "The last update introduced new package compatibility problems."
            : "The last update did not introduce any new package compatibility problems.";
        recommendation = delta.new_count > 0
            ? "Do not run another update until these new problems have been reviewed."
            : (health?.issue_count > 0
                ? `${health.issue_count} older ${health.issue_count === 1 ? "warning remains" : "warnings remain"}, but they were not caused by the update.`
                : "Everything detected by the package check is compatible. No action is needed.");
        technicalIssues = delta.new_count > 0 ? delta.new : (health?.issues || []);
    } else if (health?.available && health.issue_count === 0) {
        badgeText = "Ready";
        badgeClass = "is-healthy";
        summary = "No package compatibility problems were found.";
        recommendation = "Use Update both to keep Core and Frontend paired.";
    } else if (health?.available) {
        badgeText = `${health.issue_count} ${health.issue_count === 1 ? "warning" : "warnings"}`;
        badgeClass = "is-warning";
        summary = `${health.issue_count} package ${health.issue_count === 1 ? "warning already exists" : "warnings already exist"}; they were not caused by this updater.`;
        recommendation = "You can update. Results will be compared again after restart.";
    }

    badge.textContent = badgeText;
    badge.classList.remove("is-healthy", "is-warning", "is-danger", "is-unknown");
    badge.classList.add(badgeClass);
    setText(root, "[data-environment-summary]", summary);
    setText(root, "[data-environment-recommendation]", recommendation);

    issueList.replaceChildren();
    for (const issue of technicalIssues) {
        const item = document.createElement("li");
        item.textContent = issue;
        issueList.append(item);
    }
    details.hidden = technicalIssues.length === 0;
    const detailsLabel = details.querySelector("summary");
    detailsLabel.textContent = `Technical details (${technicalIssues.length}) — only needed for support`;
}

function renderState(root, state) {
    const coreButton = root.querySelector("[data-update-core]");
    const frontendButton = root.querySelector("[data-update-frontend]");
    const bothButton = root.querySelector("[data-update-both]");
    const bothCard = root.querySelector("[data-update-both-card]");
    const repairButton = root.querySelector("[data-frontend-repair]");
    root.querySelector("[data-update-check]").dataset.disabled = "false";
    renderEnvironmentHealth(root, state);

    if (!state.supported) {
        setText(root, "[data-update-message]", state.error || "Updates are unavailable.");
        root.querySelector("[data-update-message]").classList.add("is-error");
        for (const button of [coreButton, frontendButton, bothButton, repairButton]) {
            button.hidden = true;
        }
        bothCard.hidden = true;
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
    setText(root, "[data-pair-target]", `Tested pair: Core ${state.latest.version} · Frontend ${state.frontend.target}`);
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

    const pairedUpdateAvailable = shouldOfferPairedUpdate(state);
    bothCard.hidden = !pairedUpdateAvailable;
    bothButton.hidden = !pairedUpdateAvailable;
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
    } else if (pairedUpdateAvailable) {
        setText(root, "[data-update-message]", "Updates are available. Choose either component or the recommended paired update.");
    } else if (state.core_update_available) {
        setText(root, "[data-update-message]", "A Core update is available.");
    } else if (state.frontend.update_available) {
        setText(root, "[data-update-message]", "A Frontend update is available.");
    } else {
        setText(root, "[data-update-message]", "Core and Frontend are up to date.");
    }
}

async function waitForNewBoot(previousBootId, onPhase = () => {}) {
    const slowAt = Date.now() + UPDATE_SLOW_THRESHOLD_MS;
    let pollDelay = 750;
    let offline = false;
    let slow = false;
    while (true) {
        await new Promise((resolve) => window.setTimeout(resolve, pollDelay));
        let capabilities = null;
        try {
            capabilities = await fetchCapabilities();
        } catch {
            if (!offline) {
                offline = true;
                onPhase("offline");
            }
        }
        if (hasCompletedUpdate(previousBootId, capabilities)) return capabilities;
        if (capabilities?.update_in_progress === false) {
            throw new Error("ComfyUI could not hand off to the update worker. No update was installed.");
        }
        if (!slow && Date.now() >= slowAt) {
            slow = true;
            onPhase("slow");
        }
        pollDelay = nextPollDelay(pollDelay);
    }
}

async function waitForRestartAndReload(record) {
    const capabilities = await waitForNewBoot(record.previousBootId, (phase) => {
        record.phase = phase;
        writeActiveUpdate(record);
        showUpdateProgress(record, phase);
    });
    record.phase = "verifying";
    record.completedBootId = capabilities.boot_id;
    writeActiveUpdate(record);
    showUpdateProgress(record, "restarted");
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    allowAutomaticReload();
    location.reload();
}

async function resumeActiveUpdate() {
    const record = readActiveUpdate();
    if (!record) return;
    showUpdateProgress(record, "resuming");

    try {
        const capabilities = await fetchCapabilities();
        if (record.completedBootId && capabilities.boot_id === record.completedBootId) {
            try {
                const state = await fetchUpdateState(capabilities, false);
                showUpdateResult(record, state.last_operation);
            } catch {
                showUpdateResult(record, null);
            }
            return;
        }
    } catch {
        showUpdateProgress(record, "offline");
    }

    try {
        await waitForRestartAndReload(record);
    } catch (error) {
        showUpdateFailure(record, error);
    }
}

async function confirmUpdate(action, state, rollbackOnConflicts) {
    const compatible = actionKeepsCompatiblePair(action, state);
    const compatibility = compatible
        ? "These versions form the tested pair."
        : "The versions may not be compatible.";
    const dialogs = {
        update_core: {
            title: "Update Core only",
            message: `Install Core ${state.latest.version} and keep Frontend ${state.frontend.installed}? ${compatibility}`,
        },
        update_frontend: {
            title: "Update Frontend only",
            message: `Install Frontend ${state.frontend.target} and keep Core ${state.current.version}? ${compatibility}`,
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
        message: `${dialog.message} Automatic rollback for new package conflicts is ${rollbackOnConflicts ? "enabled" : "disabled"}. The update may take several minutes. ComfyUI will restart automatically and active jobs will be interrupted. Do not close the window after confirming.`,
    });
}

function readRollbackPreference() {
    return localStorage.getItem(ROLLBACK_PREFERENCE_KEY) === "true";
}

function writeRollbackPreference(enabled) {
    localStorage.setItem(ROLLBACK_PREFERENCE_KEY, String(enabled));
}

function renderUpdateSettings() {
    const root = document.createElement("section");
    root.className = "andreszs-update-control";
    root.innerHTML = `
        <header class="andreszs-update-control-heading">
            <div>
                <strong>ComfyUI Updater</strong>
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
                        <span>Stable release</span>
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
        <aside class="andreszs-update-recommendation" data-update-both-card hidden>
            <div>
                <strong>Update both together</strong>
                <span class="andreszs-update-pair-target" data-pair-target>Reading target pair…</span>
            </div>
            <button type="button" class="is-primary" data-update-both hidden>Update both</button>
        </aside>
        <div class="andreszs-update-compatibility" data-compatibility-warning hidden>
            <span></span>
            <button type="button" data-frontend-repair>Restore compatible Frontend</button>
        </div>
        <label class="andreszs-update-safety-option">
            <input type="checkbox" data-rollback-on-conflicts>
            <span>
                <strong>Rollback on new package conflicts</strong>
                <small>Restores previous Core code/requirements or Frontend—not models, nodes, workflows, settings, CUDA/drivers, or the exact Python environment. Failed installs always revert.</small>
            </span>
        </label>
        <aside class="andreszs-environment-health" data-environment-health>
            <header>
                <div>
                    <strong>Environment check</strong>
                </div>
                <span class="andreszs-update-badge is-unknown" data-environment-badge>Checking…</span>
            </header>
            <p data-environment-summary>Checking package compatibility…</p>
            <p class="andreszs-environment-recommendation" data-environment-recommendation></p>
            <details data-environment-details hidden>
                <summary>Technical details — only needed for support</summary>
                <p>You do not need to understand or fix these messages yourself. Copy them only when reporting a problem.</p>
                <ul data-environment-issues></ul>
            </details>
        </aside>
        <div class="andreszs-update-control-status">
            <p class="andreszs-update-control-message" data-update-message>Reading local versions…</p>
            <p class="andreszs-update-control-history" data-update-history></p>
        </div>
    `;

    let capabilities = null;
    let state = null;
    let session = null;
    const rollbackOption = root.querySelector("[data-rollback-on-conflicts]");
    rollbackOption.checked = readRollbackPreference();
    rollbackOption.addEventListener("change", () => {
        writeRollbackPreference(rollbackOption.checked);
    });
    const refresh = async (remote) => {
        session ||= settingsSession(root);
        if (!remote && session.state && session.capabilities) {
            capabilities = session.capabilities;
            state = session.state;
            renderState(root, state);
            return;
        }
        if (!remote && session.pending) {
            setBusy(root, true);
            try {
                const cached = await session.pending;
                capabilities = cached.capabilities;
                state = cached.state;
                renderState(root, state);
            } finally {
                setBusy(root, false);
            }
            return;
        }
        setBusy(root, true);
        setText(root, "[data-update-message]", remote ? "Checking the stable release channel…" : "Reading local versions…");
        const request = (async () => {
            const nextCapabilities = await fetchCapabilities();
            const nextState = await fetchUpdateState(nextCapabilities, remote);
            return { capabilities: nextCapabilities, state: nextState };
        })();
        session.pending = request;
        try {
            const result = await request;
            capabilities = result.capabilities;
            state = result.state;
            session.capabilities = capabilities;
            session.state = state;
            renderState(root, state);
        } catch (error) {
            const updateError = error instanceof Error ? error : new Error(String(error));
            setText(root, "[data-update-message]", updateError.message);
            root.querySelector("[data-update-message]").classList.add("is-error");
        } finally {
            if (session.pending === request) session.pending = null;
            setBusy(root, false);
        }
    };

    const startAction = async (action) => {
        if (!state || !capabilities || !await confirmUpdate(action, state, rollbackOption.checked)) return;
        setBusy(root, true);
        const record = {
            action,
            description: updateDescription(action, state),
            previousBootId: capabilities.boot_id,
            startedAt: new Date().toISOString(),
            phase: "preparing",
        };
        writeActiveUpdate(record);
        showUpdateProgress(record, "preparing");
        try {
            const accepted = await submitUpdate(capabilities, action, rollbackOption.checked);
            record.jobId = accepted.job_id;
            record.phase = "installing";
            writeActiveUpdate(record);
            showUpdateProgress(record, "installing");
            await waitForRestartAndReload(record);
        } catch (error) {
            const updateError = error instanceof Error ? error : new Error(String(error));
            showUpdateFailure(record, updateError);
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
    window.requestAnimationFrame(() => {
        if (root.isConnected) void refresh(false);
    });
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

window.requestAnimationFrame(() => {
    void resumeActiveUpdate();
});


