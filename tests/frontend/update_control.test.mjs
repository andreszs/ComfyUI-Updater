import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    CAPABILITIES_ROUTE,
    TOKEN_HEADER,
    UPDATE_ROUTE,
    UPDATES_ROUTE,
    hasCompletedUpdate,
    nextPollDelay,
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

test("native settings panel exposes only Core and frontend actions", () => {
    assert.match(frontend, /category:\s*\["Updates", "ComfyUI", "Updater"\]/);
    assert.match(frontend, /startAction\("update_core"\)/);
    assert.match(frontend, /startAction\("update_frontend"\)/);
    assert.match(frontend, /startAction\("update_both"\)/);
    assert.doesNotMatch(frontend, /custom nodes|node manager/i);
});

test("cards show status, sourced dates, and concise update actions", () => {
    assert.match(frontend, /"Update needed"/);
    assert.match(frontend, /"Up to date"/);
    assert.match(frontend, /data-core-released/);
    assert.match(frontend, /data-frontend-released/);
    assert.match(frontend, /bothButton\.textContent = "Update both"/);
    assert.match(stylesheet, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
});
