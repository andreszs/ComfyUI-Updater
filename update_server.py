from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import secrets
import sys
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

from aiohttp import web

try:
    from .update_controller import UpdateController, UpdateError
except ImportError:
    from update_controller import UpdateController, UpdateError

LOGGER = logging.getLogger("comfyui.updater")
CAPABILITIES_PATH = "/comfyui-updater/capabilities"
UPDATES_PATH = "/comfyui-updater/status"
UPDATE_PATH = "/comfyui-updater/apply"
TOKEN_HEADER = "X-ComfyUI-Updater-Token"
HANDOFF_DELAY_SECONDS = 0.75
DISABLE_AUTO_LAUNCH_ARG = "--disable-auto-launch"


class UpdateRuntime:
    def __init__(
        self,
        *,
        executable: str | None = None,
        argv: list[str] | None = None,
        delay: float = HANDOFF_DELAY_SECONDS,
        execv: Callable[[str, list[str]], Any] = os.execv,
        sleep: Callable[[float], Any] = time.sleep,
        thread_factory: Callable[..., threading.Thread] = threading.Thread,
    ) -> None:
        self.boot_id = str(uuid.uuid4())
        self.token = secrets.token_urlsafe(32)
        self.executable = executable or sys.executable
        self.argv = list(sys.argv if argv is None else argv)
        self.delay = delay
        self._execv = execv
        self._sleep = sleep
        self._thread_factory = thread_factory
        self._lock = threading.Lock()
        self._handoff_accepted = False

    @property
    def handoff_accepted(self) -> bool:
        with self._lock:
            return self._handoff_accepted

    def launch_argv(self) -> list[str]:
        argv = list(self.argv)
        if DISABLE_AUTO_LAUNCH_ARG not in argv:
            argv.append(DISABLE_AUTO_LAUNCH_ARG)
        return argv

    def schedule_handoff(self, *, worker_path: str, plan_path: str) -> bool:
        with self._lock:
            if self._handoff_accepted:
                return False
            self._handoff_accepted = True

        thread = self._thread_factory(
            target=lambda: self._replace_with_worker(
                worker_path=worker_path,
                plan_path=plan_path,
            ),
            name="comfyui-updater",
            daemon=True,
        )
        try:
            thread.start()
        except Exception:
            with self._lock:
                self._handoff_accepted = False
            raise
        return True

    def _replace_with_worker(self, *, worker_path: str, plan_path: str) -> None:
        try:
            self._sleep(self.delay)
            LOGGER.warning("Handing off to the ComfyUI update worker")
            self._execv(
                self.executable,
                [self.executable, worker_path, plan_path],
            )
            raise RuntimeError("os.execv returned without starting the update worker")
        except Exception:
            with self._lock:
                self._handoff_accepted = False
            LOGGER.exception("ComfyUI update handoff failed; requests are enabled again")


RUNTIME = UpdateRuntime()
UPDATER = UpdateController(executable=RUNTIME.executable)
_ROUTES_REGISTERED = False


def _json_response(data: dict[str, Any], *, status: int = 200) -> web.Response:
    response = web.json_response(data, status=status)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def _same_origin(request: web.Request) -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        return False
    parsed = urlsplit(origin)
    return (
        parsed.scheme in {"http", "https"}
        and parsed.netloc.casefold() == request.host.casefold()
    )


def _valid_token(request: web.Request) -> bool:
    supplied_token = request.headers.get(TOKEN_HEADER, "")
    return bool(supplied_token) and hmac.compare_digest(supplied_token, RUNTIME.token)


async def capabilities(request: web.Request) -> web.Response:
    return _json_response(
        {
            "available": True,
            "boot_id": RUNTIME.boot_id,
            "update_token": RUNTIME.token,
            "update_in_progress": RUNTIME.handoff_accepted,
        }
    )


async def updates(request: web.Request) -> web.Response:
    if not _valid_token(request):
        return _json_response({"error": "Invalid update token"}, status=403)
    refresh = request.query.get("refresh") == "1"
    state = await asyncio.to_thread(UPDATER.status, refresh=refresh)
    return _json_response(state)


async def update(request: web.Request) -> web.Response:
    if request.content_type != "application/json":
        return _json_response(
            {"error": "Content-Type must be application/json"}, status=415
        )
    if not _same_origin(request):
        return _json_response({"error": "Cross-origin request rejected"}, status=403)
    if not _valid_token(request):
        return _json_response({"error": "Invalid update token"}, status=403)
    try:
        body = await request.json(loads=json.loads)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_response({"error": "Invalid JSON body"}, status=400)
    if (
        not isinstance(body, dict)
        or set(body) != {"action"}
        or body.get("action")
        not in {
            "update_core",
            "update_frontend",
            "update_both",
            "repair_frontend",
        }
    ):
        return _json_response({"error": "Invalid update action"}, status=400)
    if RUNTIME.handoff_accepted:
        return _json_response({"error": "An update is already in progress"}, status=409)

    try:
        plan = await asyncio.to_thread(
            UPDATER.prepare,
            action=body["action"],
            launch_argv=RUNTIME.launch_argv(),
            launch_cwd=os.getcwd(),
        )
    except UpdateError as error:
        return _json_response({"error": str(error)}, status=409)
    except Exception:
        LOGGER.exception("Unable to prepare the ComfyUI update")
        return _json_response({"error": "Unable to prepare update"}, status=500)

    try:
        accepted = RUNTIME.schedule_handoff(
            worker_path=plan["worker_path"],
            plan_path=plan["plan_path"],
        )
    except Exception:
        UPDATER.cancel(plan)
        return _json_response({"error": "Unable to schedule update"}, status=500)
    if not accepted:
        UPDATER.cancel(plan)
        return _json_response({"error": "An update is already in progress"}, status=409)

    return _json_response(
        {
            "accepted": True,
            "job_id": plan["job_id"],
            "boot_id": RUNTIME.boot_id,
            "action": body["action"],
        },
        status=202,
    )


def register_routes() -> None:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return
    from server import PromptServer

    PromptServer.instance.routes.get(CAPABILITIES_PATH)(capabilities)
    PromptServer.instance.routes.get(UPDATES_PATH)(updates)
    PromptServer.instance.routes.post(UPDATE_PATH)(update)
    _ROUTES_REGISTERED = True
