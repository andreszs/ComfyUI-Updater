from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

VERSION_TAG_PATTERN = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
FRONTEND_REQUIREMENT_PATTERN = re.compile(
    r"^comfyui-frontend-package==([^\s;]+)", re.MULTILINE
)
FRONTEND_REQUIREMENT_LINE_PATTERN = re.compile(
    r"^\s*comfyui-frontend-package(?:\s*[=<>!~].*)?$", re.IGNORECASE
)
GITHUB_SSH_PATTERN = re.compile(
    r"^(?:ssh://)?git@github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?$",
    re.IGNORECASE,
)


def frontend_requirement(requirements: str) -> str | None:
    match = FRONTEND_REQUIREMENT_PATTERN.search(requirements)
    return match.group(1) if match else None


def core_requirements(requirements: str) -> str:
    """Return requirements without ComfyUI's separately managed frontend."""
    lines = [
        line
        for line in requirements.splitlines()
        if not FRONTEND_REQUIREMENT_LINE_PATTERN.match(line)
    ]
    return "\n".join(lines) + "\n"


def github_repository(remote: str | None) -> tuple[str, str] | None:
    if not remote:
        return None
    ssh_match = GITHUB_SSH_PATTERN.fullmatch(remote.strip())
    if ssh_match:
        return ssh_match.group("owner"), ssh_match.group("repo")
    parsed = urlparse(remote.strip())
    if parsed.hostname != "github.com":
        return None
    parts = [part for part in parsed.path.strip("/").split("/") if part]
    if len(parts) != 2:
        return None
    return parts[0], parts[1].removesuffix(".git")


def latest_version_tag(tags: list[str]) -> str | None:
    versions = []
    for tag in tags:
        match = VERSION_TAG_PATTERN.fullmatch(tag.strip())
        if match:
            versions.append((tuple(map(int, match.groups())), tag.strip()))
    return max(versions)[1] if versions else None


def _version_key(value: str | None) -> tuple[int, int, int] | None:
    if not value:
        return None
    match = VERSION_TAG_PATTERN.fullmatch(value)
    return tuple(map(int, match.groups())) if match else None


class UpdateError(RuntimeError):
    pass


class UpdateController:
    def __init__(
        self,
        *,
        comfy_root: str | Path | None = None,
        state_root: str | Path | None = None,
        executable: str | None = None,
        command_runner: Any = subprocess.run,
        json_fetcher: Any = None,
    ) -> None:
        self.comfy_root = Path(comfy_root or Path(__file__).absolute().parents[2])
        self.state_root = Path(
            state_root
            or self.comfy_root / "user" / "default" / "ComfyUI-Updater" / "updates"
        )
        self.executable = executable or sys.executable
        self._run = command_runner
        self._json_fetcher = json_fetcher or self._fetch_json
        self._last_checked_at: str | None = None

    @staticmethod
    def _fetch_json(url: str) -> dict[str, Any]:
        request = Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "ComfyUI-Updater/0.1.0",
            },
        )
        with urlopen(request, timeout=12) as response:
            payload = json.load(response)
        if not isinstance(payload, dict):
            raise ValueError("Expected a JSON object")
        return payload

    def _command(self, *arguments: str, timeout: int = 120) -> str:
        try:
            result = self._run(
                list(arguments),
                cwd=self.comfy_root,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise UpdateError(str(error)) from error
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "Command failed").strip()
            raise UpdateError(detail)
        return result.stdout.strip()

    def _git(self, *arguments: str, timeout: int = 120) -> str:
        return self._command("git", *arguments, timeout=timeout)

    def _git_optional(self, *arguments: str) -> str | None:
        try:
            return self._git(*arguments)
        except UpdateError:
            return None

    def _installed_frontend(self) -> str | None:
        try:
            return version("comfyui-frontend-package")
        except PackageNotFoundError:
            return None

    def _requirements_at(self, reference: str | None) -> str:
        if reference is None:
            requirements_path = self.comfy_root / "requirements.txt"
            if not requirements_path.is_file():
                raise UpdateError("ComfyUI requirements.txt was not found")
            return requirements_path.read_text(encoding="utf-8")
        return self._git("show", f"{reference}:requirements.txt")

    def _last_operation(self) -> dict[str, Any] | None:
        if not self.state_root.is_dir():
            return None
        statuses = sorted(
            self.state_root.glob("*/status.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        for status_path in statuses:
            try:
                status = json.loads(status_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(status, dict):
                status["log_available"] = status_path.with_name("update.log").is_file()
                return status
        return None

    def _release_dates_cache(self) -> Path:
        return self.state_root / "release_dates.json"

    def _cached_release_dates(
        self,
        *,
        core_version: str,
        frontend_version: str,
    ) -> dict[str, str | None]:
        try:
            cached = json.loads(
                self._release_dates_cache().read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError):
            cached = {}
        core = cached.get("core") if isinstance(cached, dict) else None
        frontend = cached.get("frontend") if isinstance(cached, dict) else None
        return {
            "core": (
                core.get("published_at")
                if isinstance(core, dict) and core.get("version") == core_version
                else None
            ),
            "core_source": (
                core.get("source")
                if isinstance(core, dict) and core.get("version") == core_version
                else None
            ),
            "frontend": (
                frontend.get("published_at")
                if isinstance(frontend, dict)
                and frontend.get("version") == frontend_version
                else None
            ),
            "frontend_source": (
                frontend.get("source")
                if isinstance(frontend, dict)
                and frontend.get("version") == frontend_version
                else None
            ),
        }

    def _refresh_release_dates(
        self,
        *,
        core_version: str,
        frontend_version: str,
        previous: dict[str, str | None],
    ) -> dict[str, str | None]:
        dates = dict(previous)
        repository = github_repository(
            self._git_optional("remote", "get-url", "origin")
        )
        if repository:
            owner, repo = repository
            url = (
                f"https://api.github.com/repos/{quote(owner)}/{quote(repo)}"
                f"/releases/tags/{quote(core_version)}"
            )
            try:
                published_at = self._json_fetcher(url).get("published_at")
                if isinstance(published_at, str):
                    dates["core"] = published_at
                    dates["core_source"] = "github_release"
            except Exception:
                pass

        frontend_url = (
            "https://pypi.org/pypi/comfyui-frontend-package/"
            f"{quote(frontend_version)}/json"
        )
        try:
            files = self._json_fetcher(frontend_url).get("urls", [])
            upload_dates = sorted(
                file["upload_time_iso_8601"]
                for file in files
                if isinstance(file, dict)
                and isinstance(file.get("upload_time_iso_8601"), str)
                and not file.get("yanked", False)
            )
            if upload_dates:
                dates["frontend"] = upload_dates[0]
                dates["frontend_source"] = "pypi"
        except Exception:
            pass

        try:
            self.state_root.mkdir(parents=True, exist_ok=True)
            cache = {
                "core": {
                    "version": core_version,
                    "published_at": dates["core"],
                    "source": dates.get("core_source"),
                },
                "frontend": {
                    "version": frontend_version,
                    "published_at": dates["frontend"],
                    "source": dates.get("frontend_source"),
                },
            }
            temporary_path = self._release_dates_cache().with_suffix(".tmp")
            temporary_path.write_text(json.dumps(cache, indent=2), encoding="utf-8")
            temporary_path.replace(self._release_dates_cache())
        except OSError:
            pass
        return dates

    def status(self, *, refresh: bool = False) -> dict[str, Any]:
        if not (self.comfy_root / ".git").exists():
            return {
                "supported": False,
                "error": "ComfyUI is not installed from Git",
                "last_operation": self._last_operation(),
            }

        try:
            if refresh:
                self._git("fetch", "origin", "--tags", "--prune", timeout=300)
                self._last_checked_at = datetime.now(timezone.utc).isoformat()

            current_commit = self._git("rev-parse", "HEAD")
            current_tag = self._git_optional("describe", "--tags", "--exact-match", "HEAD")
            current_version = current_tag or self._git("describe", "--tags", "--always", "HEAD")
            tags = self._git("tag", "--list", "v[0-9]*").splitlines()
            latest_tag = latest_version_tag(tags)
            if latest_tag is None:
                raise UpdateError("No ComfyUI release tags were found")
            latest_commit = self._git("rev-list", "-n", "1", latest_tag)

            dirty = bool(self._git("status", "--porcelain", "--untracked-files=no"))
            installed_frontend = self._installed_frontend()
            current_frontend = frontend_requirement(self._requirements_at(None))
            target_frontend = frontend_requirement(self._requirements_at(latest_tag))
            if current_frontend is None or target_frontend is None:
                raise UpdateError("The ComfyUI frontend requirement could not be determined")

            release_dates = self._cached_release_dates(
                core_version=latest_tag,
                frontend_version=target_frontend,
            )
            if not release_dates["core"]:
                tag_date = self._git_optional(
                    "for-each-ref",
                    "--format=%(creatordate:iso-strict)",
                    f"refs/tags/{latest_tag}",
                )
                if tag_date:
                    release_dates["core"] = tag_date
                    release_dates["core_source"] = "git_tag"
            if refresh:
                release_dates = self._refresh_release_dates(
                    core_version=latest_tag,
                    frontend_version=target_frontend,
                    previous=release_dates,
                )

            current_key = _version_key(current_tag)
            latest_key = _version_key(latest_tag)
            update_available = current_commit != latest_commit and bool(
                latest_key and (current_key is None or latest_key > current_key)
            )
            frontend_compatible = installed_frontend == current_frontend
            frontend_update_available = installed_frontend != target_frontend
            blocked_reason = None
            if dirty:
                blocked_reason = "ComfyUI has tracked local changes"

            return {
                "supported": True,
                "checked_at": self._last_checked_at,
                "current": {
                    "version": current_version,
                    "commit": current_commit,
                    "dirty": dirty,
                },
                "latest": {
                    "version": latest_tag,
                    "frontend": target_frontend,
                    "published_at": release_dates["core"],
                    "date_source": release_dates["core_source"],
                },
                "frontend": {
                    "installed": installed_frontend,
                    "required": current_frontend,
                    "target": target_frontend,
                    "target_published_at": release_dates["frontend"],
                    "target_date_source": release_dates["frontend_source"],
                    "compatible": frontend_compatible,
                    "update_available": frontend_update_available,
                },
                "core_update_available": update_available,
                "core_update_allowed": update_available and not dirty,
                "frontend_update_allowed": frontend_update_available,
                "combined_update_available": (
                    update_available or frontend_update_available
                ),
                "combined_update_allowed": (
                    (update_available or frontend_update_available) and not dirty
                ),
                "update_available": update_available,
                "update_allowed": update_available and not dirty,
                "blocked_reason": blocked_reason,
                "last_operation": self._last_operation(),
            }
        except UpdateError as error:
            return {
                "supported": False,
                "error": str(error),
                "checked_at": self._last_checked_at,
                "last_operation": self._last_operation(),
            }

    def prepare(
        self,
        *,
        action: str,
        launch_argv: list[str],
        launch_cwd: str,
    ) -> dict[str, str]:
        core_actions = {"update_core", "update_both"}
        frontend_actions = {"update_frontend", "repair_frontend"}
        if action not in core_actions | frontend_actions:
            raise UpdateError("Unsupported update action")
        if not launch_argv or not all(isinstance(argument, str) for argument in launch_argv):
            raise UpdateError("The ComfyUI launch command is unavailable")

        state = self.status(refresh=action != "repair_frontend")
        if not state.get("supported"):
            raise UpdateError(state.get("error", "Update check failed"))
        if action in core_actions and state["current"]["dirty"]:
            raise UpdateError("ComfyUI has tracked local changes; update cancelled")
        if action == "update_core" and not state["core_update_available"]:
            raise UpdateError("ComfyUI is already on the latest stable release")
        if action == "update_frontend" and not state["frontend"]["update_available"]:
            raise UpdateError("The frontend is already on the latest stable target")
        if action == "update_both" and not state["combined_update_available"]:
            raise UpdateError("Core and frontend are already up to date")

        required_frontend = (
            state["latest"]["frontend"]
            if action != "repair_frontend"
            else state["frontend"]["required"]
        )
        if not required_frontend or not re.fullmatch(r"[A-Za-z0-9_.+-]+", required_frontend):
            raise UpdateError("The required frontend version is invalid")

        job_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
        job_root = self.state_root / job_id
        job_root.mkdir(parents=True, exist_ok=False)
        requirements_before = job_root / "requirements.before.txt"
        shutil.copy2(self.comfy_root / "requirements.txt", requirements_before)
        worker_path = job_root / "update_worker.py"
        shutil.copy2(Path(__file__).with_name("update_worker.py"), worker_path)
        core_requirements_path = None
        if action == "update_core":
            core_requirements_path = job_root / "requirements.core.txt"
            core_requirements_path.write_text(
                core_requirements(self._requirements_at(state["latest"]["version"])),
                encoding="utf-8",
            )

        plan = {
            "job_id": job_id,
            "action": action,
            "comfy_root": str(self.comfy_root.resolve()),
            "executable": self.executable,
            "launch_argv": launch_argv,
            "launch_cwd": str(Path(launch_cwd).resolve()),
            "previous_commit": state["current"]["commit"],
            "previous_frontend": state["frontend"]["installed"],
            "requirements_before": str(requirements_before.resolve()),
            "target_ref": (
                state["latest"]["version"] if action in core_actions else None
            ),
            "required_frontend": required_frontend,
            "core_requirements": (
                str(core_requirements_path.resolve())
                if core_requirements_path is not None
                else None
            ),
            "status_path": str((job_root / "status.json").resolve()),
            "log_path": str((job_root / "update.log").resolve()),
        }
        plan_path = job_root / "plan.json"
        plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
        self._write_status(
            plan["status_path"],
            {
                "job_id": job_id,
                "action": action,
                "state": "scheduled",
                "target": plan["target_ref"],
                "frontend": required_frontend,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        return {
            "job_id": job_id,
            "worker_path": str(worker_path.resolve()),
            "plan_path": str(plan_path.resolve()),
        }

    def cancel(self, plan: dict[str, str]) -> None:
        plan_path = Path(plan["plan_path"])
        status_path = plan_path.with_name("status.json")
        self._write_status(
            status_path,
            {
                "job_id": plan["job_id"],
                "state": "cancelled",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )

    @staticmethod
    def _write_status(path: str | Path, status: dict[str, Any]) -> None:
        status_path = Path(path)
        temporary_path = status_path.with_suffix(".tmp")
        temporary_path.write_text(json.dumps(status, indent=2), encoding="utf-8")
        temporary_path.replace(status_path)


