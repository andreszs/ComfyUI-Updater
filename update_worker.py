from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _write_status(plan: dict[str, Any], state: str, **details: Any) -> None:
    status = {
        "job_id": plan["job_id"],
        "action": plan["action"],
        "state": state,
        "target": plan.get("target_ref"),
        "frontend": plan["required_frontend"],
        "updated_at": datetime.now(timezone.utc).isoformat(),
        **details,
    }
    status_path = Path(plan["status_path"])
    temporary_path = status_path.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(status, indent=2), encoding="utf-8")
    temporary_path.replace(status_path)


def _run(command: list[str], *, cwd: Path, log_path: Path) -> None:
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"\n> {subprocess.list2cmdline(command)}\n")
        log.flush()
        result = subprocess.run(
            command,
            cwd=cwd,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {result.returncode}")


def _launch(plan: dict[str, Any], execv: Any) -> None:
    os.chdir(plan["launch_cwd"])
    executable = plan["executable"]
    try:
        execv(executable, [executable, *plan["launch_argv"]])
    except OSError as error:
        _write_status(plan, "launch_failed", error=str(error))
        raise
    raise RuntimeError("Unable to relaunch ComfyUI")


def run(plan_path: str | Path, *, runner: Any = _run, execv: Any = os.execv) -> None:
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    comfy_root = Path(plan["comfy_root"])
    log_path = Path(plan["log_path"])
    action = plan["action"]
    _write_status(plan, "running")

    try:
        if action in {"update_core", "update_both"}:
            backup_branch = f"restart-control-backup-{plan['job_id']}"
            requirements_path = (
                plan["core_requirements"]
                if action == "update_core"
                else str(comfy_root / "requirements.txt")
            )
            runner(
                ["git", "branch", backup_branch, plan["previous_commit"]],
                cwd=comfy_root,
                log_path=log_path,
            )
            runner(
                ["git", "checkout", "--detach", plan["target_ref"]],
                cwd=comfy_root,
                log_path=log_path,
            )
            runner(
                [
                    plan["executable"],
                    "-s",
                    "-m",
                    "pip",
                    "install",
                    "-r",
                    requirements_path,
                ],
                cwd=comfy_root,
                log_path=log_path,
            )
        elif action in {"update_frontend", "repair_frontend"}:
            runner(
                [
                    plan["executable"],
                    "-s",
                    "-m",
                    "pip",
                    "install",
                    "--upgrade",
                    "--force-reinstall",
                    f"comfyui-frontend-package=={plan['required_frontend']}",
                ],
                cwd=comfy_root,
                log_path=log_path,
            )
        else:
            raise RuntimeError("Unsupported update action")
    except Exception as error:
        rollback_error = None
        try:
            if action in {"update_core", "update_both"}:
                runner(
                    ["git", "checkout", "--detach", plan["previous_commit"]],
                    cwd=comfy_root,
                    log_path=log_path,
                )
                runner(
                    [
                        plan["executable"],
                        "-s",
                        "-m",
                        "pip",
                        "install",
                        "-r",
                        plan["requirements_before"],
                    ],
                    cwd=comfy_root,
                    log_path=log_path,
                )
            elif plan.get("previous_frontend"):
                runner(
                    [
                        plan["executable"],
                        "-s",
                        "-m",
                        "pip",
                        "install",
                        "--force-reinstall",
                        f"comfyui-frontend-package=={plan['previous_frontend']}",
                    ],
                    cwd=comfy_root,
                    log_path=log_path,
                )
        except Exception as rollback_exception:
            rollback_error = str(rollback_exception)
        _write_status(
            plan,
            "rollback_failed" if rollback_error else "rolled_back",
            error=str(error),
            rollback_error=rollback_error,
        )
        _launch(plan, execv)

    _write_status(plan, "completed")
    _launch(plan, execv)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: update_worker.py PLAN_PATH")
    run(sys.argv[1])


if __name__ == "__main__":
    main()


