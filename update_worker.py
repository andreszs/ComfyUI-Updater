from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _dependency_issues(output: str) -> list[str]:
    ignored = {"no broken requirements found."}
    return sorted(
        {
            line.strip()
            for line in output.splitlines()
            if line.strip()
            and line.strip().casefold() not in ignored
            and not line.strip().casefold().startswith(("[notice]", "warning:"))
        },
        key=str.casefold,
    )


def _dependency_health(*, executable: str, cwd: Path, log_path: Path) -> dict[str, Any]:
    checked_at = datetime.now(timezone.utc).isoformat()
    command = [executable, "-s", "-m", "pip", "check"]
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {
            "available": False,
            "status": "unavailable",
            "issue_count": None,
            "issues": [],
            "checked_at": checked_at,
            "error": str(error),
        }

    output = "\n".join(
        part.strip() for part in (result.stdout, result.stderr) if part and part.strip()
    )
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"\n> {subprocess.list2cmdline(command)}\n")
        log.write(output + "\n")

    if result.returncode not in {0, 1}:
        return {
            "available": False,
            "status": "unavailable",
            "issue_count": None,
            "issues": [],
            "checked_at": checked_at,
            "error": output or f"Environment check exited with code {result.returncode}",
        }
    issues = _dependency_issues(output)
    return {
        "available": True,
        "status": "healthy" if not issues else "warnings",
        "issue_count": len(issues),
        "issues": issues,
        "checked_at": checked_at,
    }


def _dependency_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    if not before.get("available") or not after.get("available"):
        return {
            "available": False,
            "new_count": None,
            "resolved_count": None,
            "new": [],
            "resolved": [],
        }
    before_issues = set(before.get("issues", []))
    after_issues = set(after.get("issues", []))
    new = sorted(after_issues - before_issues, key=str.casefold)
    resolved = sorted(before_issues - after_issues, key=str.casefold)
    return {
        "available": True,
        "new_count": len(new),
        "resolved_count": len(resolved),
        "new": new,
        "resolved": resolved,
    }


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


def run(
    plan_path: str | Path,
    *,
    runner: Any = _run,
    execv: Any = os.execv,
    dependency_checker: Any = _dependency_health,
) -> None:
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    comfy_root = Path(plan["comfy_root"])
    log_path = Path(plan["log_path"])
    action = plan["action"]
    environment_before = plan.get("environment_before", {"available": False, "issues": []})
    environment_after = None
    environment_delta = None
    _write_status(plan, "running", environment_before=environment_before)

    try:
        if action in {"update_core", "update_both"}:
            backup_branch = f"comfyui-updater-backup-{plan['job_id']}"
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

        environment_after = dependency_checker(
            executable=plan["executable"], cwd=comfy_root, log_path=log_path
        )
        environment_delta = _dependency_delta(environment_before, environment_after)
        if (
            plan.get("rollback_on_conflicts", False)
            and (environment_delta.get("new_count") or 0) > 0
        ):
            raise RuntimeError(
                "The update introduced new Python package compatibility problems"
            )
    except Exception as error:
        rollback_error = None
        rollback_environment = None
        rollback_environment_delta = None
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
            rollback_environment = dependency_checker(
                executable=plan["executable"], cwd=comfy_root, log_path=log_path
            )
            rollback_environment_delta = _dependency_delta(
                environment_before, rollback_environment
            )
            if (rollback_environment_delta.get("new_count") or 0) > 0:
                rollback_error = (
                    "The previous package compatibility state was not fully restored"
                )
        except Exception as rollback_exception:
            rollback_error = str(rollback_exception)
        rollback_state = "rolled_back"
        if rollback_error:
            rollback_state = "rollback_failed"
        elif not rollback_environment_delta or not rollback_environment_delta.get(
            "available"
        ):
            rollback_state = "rollback_unverified"
        _write_status(
            plan,
            rollback_state,
            error=str(error),
            rollback_error=rollback_error,
            environment_before=environment_before,
            environment_after=environment_after,
            environment_delta=environment_delta,
            rollback_environment=rollback_environment,
            rollback_environment_delta=rollback_environment_delta,
        )
        _launch(plan, execv)

    _write_status(
        plan,
        "completed",
        environment_before=environment_before,
        environment_after=environment_after,
        environment_delta=environment_delta,
    )
    _launch(plan, execv)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: update_worker.py PLAN_PATH")
    run(sys.argv[1])


if __name__ == "__main__":
    main()


