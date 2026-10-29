import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    CAPABILITIES_ROUTE,
    TOKEN_HEADER,
    UPDATE_ROUTE,
    UPDATES_ROUTE,
    actionKeepsCompatiblePair,
    hasCompletedUpdate,
    nextPollDelay,
    updateResultSummary,
} from "../../js/update_control_core.mjs";

const frontend = await readFile(
    new URL("../../js/update_control.js", import.meta.url),
    "utf8",
);
const stylesheet = await readFile(
    new URL("../../js/update_control.css", import.meta.url),
    "utf8",
);

test("standalone routes use an isolated namespace", () => {
    assert.equal(CAPABILITIES_ROUTE, "/comfyui-updater/capabilities");
    assert.equal(UPDATES_ROUTE, "/comfyui-updater/status");
    assert.equal(UPDATE_ROUTE, "/comfyui-updater/apply");
    assert.equal(TOKEN_HEADER, "X-ComfyUI-Updater-Token");
});

test("update completion requires a new backend boot", () => {
    assert.equal(hasCompletedUpdate("old", { available: true, boot_id: "old" }), false);
    assert.equal(hasCompletedUpdate("old", { available: true, boot_id: "new" }), true);
    assert.equal(nextPollDelay(5000), 5000);
});

test("individual update confirmations identify compatible target pairs", () => {
    const state = {
        frontend: {
            installed: "1.57.4",
            target: "1.57.4",
            required: "1.45.21",
        },
    };
    assert.equal(actionKeepsCompatiblePair("update_core", state), true);
    assert.equal(actionKeepsCompatiblePair("update_frontend", state), false);
    assert.equal(actionKeepsCompatiblePair("update_both", state), true);
    assert.equal(actionKeepsCompatiblePair("repair_frontend", state), true);
});

test("post-restart summaries distinguish success and recovery outcomes", () => {
    assert.equal(updateResultSummary({ state: "completed" }).tone, "success");
    assert.equal(
        updateResultSummary({
            state: "completed",
            environment_delta: { new_count: 1 },
        }).tone,
        "warning",
    );
    assert.match(updateResultSummary({ state: "rolled_back" }).title, /reverted/i);
    assert.match(updateResultSummary({ state: "rollback_failed" }).title, /failed/i);
});

test("native settings panel exposes only Core and frontend actions", () => {
    assert.match(frontend, /category:\s*\["Updates", "ComfyUI", "Updater"\]/);
    assert.match(frontend, /startAction\("update_core"\)/);
    assert.match(frontend, /startAction\("update_frontend"\)/);
    assert.match(frontend, /startAction\("update_both"\)/);
    assert.doesNotMatch(frontend, /startAction\("(?:update_)?custom|node manager/i);
});

test("cards show status, sourced dates, and concise update actions", () => {
    assert.match(frontend, /"Update needed"/);
    assert.match(frontend, /"Up to date"/);
    assert.match(frontend, /data-core-released/);
    assert.match(frontend, /data-frontend-released/);
    assert.match(frontend, /bothButton\.textContent = "Update both"/);
    assert.match(stylesheet, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
});

test("environment health explains warnings and automatic recovery", () => {
    assert.match(frontend, /Environment check/);
    assert.match(frontend, /warnings already exist/);
    assert.doesNotMatch(frontend, /existing \$\{health\.issue_count/);
    assert.match(frontend, /Update safely reverted/);
    assert.match(frontend, /Results will be compared again after restart/);
    assert.match(frontend, /Technical details .* only needed for support/);
    assert.match(stylesheet, /\.andreszs-environment-health/);
});

test("automatic conflict rollback is an optional persisted choice", () => {
    assert.match(frontend, /data-rollback-on-conflicts/);
    assert.match(frontend, /Rollback on new package conflicts/);
    assert.match(frontend, /previous Core code\/requirements/);
    assert.match(frontend, /exact Python environment/);
    assert.match(frontend, /localStorage\.setItem\(ROLLBACK_PREFERENCE_KEY/);
    assert.doesNotMatch(frontend, /Automatically revert[^\n]*recommended/i);
});

test("successful update state is cached for one Settings dialog session", () => {
    assert.match(frontend, /const SETTINGS_SESSIONS = new WeakMap\(\)/);
    assert.match(frontend, /root\.closest\('\[role="dialog"\], \.p-dialog'\)/);
    assert.match(frontend, /if \(!remote && session\.state && session\.capabilities\)/);
    assert.match(frontend, /session\.pending/);
    assert.match(frontend, /SETTINGS_SESSIONS\.delete\(dialog\)/);
});

test("accepted updates use a persistent global blocking overlay", () => {
    assert.match(frontend, /const UPDATE_SESSION_KEY/);
    assert.match(frontend, /sessionStorage\.setItem\(UPDATE_SESSION_KEY/);
    assert.match(frontend, /aria-modal/);
    assert.match(frontend, /Do not close this window or stop ComfyUI/);
    assert.match(frontend, /window\.addEventListener\("beforeunload"/);
    assert.match(frontend, /ComfyUI is temporarily offline/);
    assert.match(frontend, /taking longer than expected/);
    assert.match(frontend, /showUpdateResult\(record, state\.last_operation\)/);
    assert.match(stylesheet, /\.andreszs-update-overlay/);
    assert.match(stylesheet, /z-index:\s*2147483647/);
});

test("normal update progress has no visible action until a final result", () => {
    assert.match(frontend, /data-update-result-actions hidden/);
    assert.match(frontend, /\[data-update-result-actions\]"\)\.hidden = true/);
    assert.match(frontend, /\[data-update-result-actions\]"\)\.hidden = false/);
    assert.doesNotMatch(frontend, /Timed out while waiting for the updated backend/);
});
