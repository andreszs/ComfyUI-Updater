from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from json import loads
from pathlib import Path
from unittest.mock import Mock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import update_controller  # noqa: E402
import update_server  # noqa: E402
import update_worker  # noqa: E402


class DeferredThread:
    instances = []

    def __init__(self, *, target, name, daemon):
        self.target = target
        self.name = name
        self.daemon = daemon
        self.started = False
        self.__class__.instances.append(self)

    def start(self):
        self.started = True


class UpdateRuntimeTests(unittest.TestCase):
    def setUp(self):
        DeferredThread.instances.clear()

    def test_handoff_is_single_use_and_preserves_launch_arguments(self):
        runtime = update_server.UpdateRuntime(
            executable="python-test",
            argv=["main.py", "--listen", "127.0.0.1"],
            thread_factory=DeferredThread,
        )

        self.assertEqual(
            runtime.launch_argv(),
            ["main.py", "--listen", "127.0.0.1", "--disable-auto-launch"],
        )
        self.assertTrue(runtime.schedule_handoff(worker_path="worker.py", plan_path="plan.json"))
        self.assertFalse(runtime.schedule_handoff(worker_path="worker.py", plan_path="plan.json"))
        self.assertTrue(DeferredThread.instances[0].started)

    def test_failed_exec_releases_handoff_lock(self):
        runtime = update_server.UpdateRuntime(
            executable="python-test",
            argv=["main.py"],
            delay=0,
            execv=Mock(side_effect=OSError("test stop")),
            sleep=Mock(),
            thread_factory=DeferredThread,
        )

        runtime.schedule_handoff(worker_path="worker.py", plan_path="plan.json")
        with self.assertLogs(update_server.LOGGER, level="ERROR"):
            DeferredThread.instances[0].target()

        self.assertFalse(runtime.handoff_accepted)


class UpdateEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        DeferredThread.instances.clear()
        self.runtime = update_server.UpdateRuntime(
            executable="python-test",
            argv=["main.py"],
            thread_factory=DeferredThread,
        )
        self.updater = Mock()
        self.updater.status.return_value = {"supported": True}
        self.updater.prepare.return_value = {
            "job_id": "job-test",
            "worker_path": "worker.py",
            "plan_path": "plan.json",
        }
        self.runtime_patch = patch.object(update_server, "RUNTIME", self.runtime)
        self.updater_patch = patch.object(update_server, "UPDATER", self.updater)
        self.runtime_patch.start()
        self.updater_patch.start()

        application = web.Application()
        application.router.add_get(update_server.CAPABILITIES_PATH, update_server.capabilities)
        application.router.add_get(update_server.UPDATES_PATH, update_server.updates)
        application.router.add_post(update_server.UPDATE_PATH, update_server.update)
        self.client = TestClient(TestServer(application))
        await self.client.start_server()
        self.origin = str(self.client.make_url("/")).rstrip("/")

    async def asyncTearDown(self):
        await self.client.close()
        self.runtime_patch.stop()
        self.updater_patch.stop()

    async def test_capabilities_expose_per_boot_token_without_caching(self):
        response = await self.client.get(update_server.CAPABILITIES_PATH)
        body = await response.json()

        self.assertEqual(response.status, 200)
        self.assertEqual(body["update_token"], self.runtime.token)
        self.assertEqual(response.headers["Cache-Control"], "no-store, max-age=0")

    async def test_status_requires_token(self):
        missing = await self.client.get(update_server.UPDATES_PATH)
        accepted = await self.client.get(
            f"{update_server.UPDATES_PATH}?refresh=1",
            headers={update_server.TOKEN_HEADER: self.runtime.token},
        )

        self.assertEqual(missing.status, 403)
        self.assertEqual(accepted.status, 200)
        self.updater.status.assert_called_once_with(refresh=True)

    async def test_action_is_strict_same_origin_and_schedules_handoff(self):
        invalid = await self.client.post(
            update_server.UPDATE_PATH,
            json={"action": "update_both", "target": "arbitrary"},
            headers={
                "Origin": self.origin,
                update_server.TOKEN_HEADER: self.runtime.token,
            },
        )
        cross_origin = await self.client.post(
            update_server.UPDATE_PATH,
            json={"action": "update_both"},
            headers={
                "Origin": "https://example.invalid",
                update_server.TOKEN_HEADER: self.runtime.token,
            },
        )
        accepted = await self.client.post(
            update_server.UPDATE_PATH,
            json={"action": "update_both"},
            headers={
                "Origin": self.origin,
                update_server.TOKEN_HEADER: self.runtime.token,
            },
        )

        self.assertEqual(invalid.status, 400)
        self.assertEqual(cross_origin.status, 403)
        self.assertEqual(accepted.status, 202)
        self.assertEqual((await accepted.json())["job_id"], "job-test")
        self.assertTrue(self.runtime.handoff_accepted)


class UpdateControllerTests(unittest.TestCase):
    @staticmethod
    def _update_state():
        return {
            "supported": True,
            "current": {"version": "v1.0.0", "commit": "abc123", "dirty": False},
            "latest": {"version": "v1.1.0", "frontend": "1.1.0"},
            "frontend": {
                "installed": "1.0.0",
                "required": "1.0.0",
                "target": "1.1.0",
                "compatible": True,
                "update_available": True,
            },
            "core_update_available": True,
            "combined_update_available": True,
        }

    def test_requirement_release_and_remote_parsing(self):
        requirements = "comfyui-frontend-package==1.57.4\nnumpy\n"

        self.assertEqual(update_controller.frontend_requirement(requirements), "1.57.4")
        self.assertEqual(update_controller.core_requirements(requirements), "numpy\n")
        self.assertEqual(
            update_controller.latest_version_tag(
                ["v0.9.0", "v0.10.0", "nightly", "v0.10.0-rc1"]
            ),
            "v0.10.0",
        )
        self.assertEqual(
            update_controller.github_repository(
                "git@github.com:comfyanonymous/ComfyUI.git"
            ),
            ("comfyanonymous", "ComfyUI"),
        )

    def test_release_dates_use_github_and_first_non_yanked_pypi_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def fetch_json(url):
                if "api.github.com" in url:
                    return {"published_at": "2026-10-20T12:00:00Z"}
                return {
                    "urls": [
                        {
                            "upload_time_iso_8601": "2026-10-19T09:00:00Z",
                            "yanked": True,
                        },
                        {"upload_time_iso_8601": "2026-10-21T10:00:00Z"},
                        {"upload_time_iso_8601": "2026-10-21T09:00:00Z"},
                    ]
                }

            controller = update_controller.UpdateController(
                comfy_root=root,
                state_root=root / "state",
                json_fetcher=fetch_json,
            )
            with patch.object(
                controller,
                "_git_optional",
                return_value="https://github.com/comfyanonymous/ComfyUI",
            ):
                dates = controller._refresh_release_dates(
                    core_version="v1.1.0",
                    frontend_version="1.1.0",
                    previous={"core": None, "frontend": None},
                )

            self.assertEqual(dates["core"], "2026-10-20T12:00:00Z")
            self.assertEqual(dates["core_source"], "github_release")
            self.assertEqual(dates["frontend"], "2026-10-21T09:00:00Z")

    def test_prepare_core_only_filters_frontend_requirement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "requirements.txt").write_text(
                "comfyui-frontend-package==1.0.0\nnumpy\n", encoding="utf-8"
            )
            controller = update_controller.UpdateController(
                comfy_root=root,
                state_root=root / "state",
                executable="python-test",
            )
            target_requirements = "comfyui-frontend-package==1.1.0\ntorch\n"
            with (
                patch.object(controller, "status", return_value=self._update_state()),
                patch.object(controller, "_requirements_at", return_value=target_requirements),
            ):
                plan_info = controller.prepare(
                    action="update_core",
                    launch_argv=["main.py"],
                    launch_cwd=directory,
                )

            plan = loads(Path(plan_info["plan_path"]).read_text(encoding="utf-8"))
            self.assertEqual(
                Path(plan["core_requirements"]).read_text(encoding="utf-8"),
                "torch\n",
            )


class UpdateWorkerTests(unittest.TestCase):
    def _plan(self, root: Path, action: str = "update_both") -> Path:
        plan = {
            "job_id": "job-test",
            "action": action,
            "comfy_root": str(root),
            "executable": "python-test",
            "launch_argv": ["main.py", "--disable-auto-launch"],
            "launch_cwd": str(root),
            "previous_commit": "old-commit",
            "previous_frontend": "1.0.0",
            "requirements_before": str(root / "requirements.before.txt"),
            "target_ref": "v1.1.0",
            "required_frontend": "1.1.0",
            "core_requirements": str(root / "requirements.core.txt"),
            "status_path": str(root / "status.json"),
            "log_path": str(root / "update.log"),
        }
        plan_path = root / "plan.json"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        return plan_path

    def test_frontend_only_does_not_touch_git(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = Mock()
            execv = Mock(side_effect=SystemExit)
            previous_cwd = Path.cwd()
            try:
                with self.assertRaises(SystemExit):
                    update_worker.run(
                        self._plan(root, action="update_frontend"),
                        runner=runner,
                        execv=execv,
                    )
            finally:
                os.chdir(previous_cwd)

            commands = [call.args[0] for call in runner.call_args_list]
            self.assertEqual(len(commands), 1)
            self.assertIn("comfyui-frontend-package==1.1.0", commands[0])

    def test_failed_paired_update_rolls_back_commit_and_requirements(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = []

            def runner(command, **kwargs):
                commands.append(command)
                if command[:4] == ["python-test", "-s", "-m", "pip"] and command[-1].endswith(
                    "requirements.txt"
                ):
                    raise RuntimeError("pip failed")

            previous_cwd = Path.cwd()
            try:
                with self.assertRaises(SystemExit):
                    update_worker.run(
                        self._plan(root),
                        runner=runner,
                        execv=Mock(side_effect=SystemExit),
                    )
            finally:
                os.chdir(previous_cwd)

            self.assertIn(["git", "checkout", "--detach", "old-commit"], commands)
            self.assertEqual(loads((root / "status.json").read_text())["state"], "rolled_back")


if __name__ == "__main__":
    unittest.main()
