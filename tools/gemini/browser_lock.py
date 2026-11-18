"""The one lock on the owner's browser, taken by every driver of it.

The Chrome on `--remote-debugging-port=9222` is one browser, and two drivers in
it ruin each other's asks: a music ask's tab may be closed mid-track and its
quota spent for nothing (Ants of Neque, the audit of 2026-10-03). So every
driver here (`gemini_web.py`, `music_web.py`, and through them the queue)
takes this lock before it attaches.

**The file is the one Ants of Neque's drivers take**, in the system's temporary
folder: the owner drives the same Chrome from both projects, so the two
projects' queues must wait for each other too, not only the worktrees of one.

- A driver that is killed leaves its lock behind; the next one sees the
  process gone and takes it over.
- The lock is dropped at exit (`atexit`) whatever ends the process short of a
  kill, so a driver that raises never strands it.
- A driver that finds it held may wait (`take(wait=...)`).

Nothing here touches the browser: the lock is a file, and waiting on it reads
that file, never the page.
"""

from __future__ import annotations

import atexit
import ctypes
import datetime
import json
import os
import sys
import tempfile
import time

LOCK = os.path.join(tempfile.gettempdir(), "ants_of_neque_gemini_browser.lock")
## How often a held lock is looked at again while waiting.
POLL_SECONDS = 5.0
## A lock file this young that does not read yet is one being written by the
## driver that just took it, not one left behind.
FRESH_SECONDS = 10.0


def alive(pid: int) -> bool:
    """Whether a process is running. **Never `os.kill(pid, 0)` on Windows**:
    there it is TerminateProcess, and asking would kill the driver it asked
    about."""
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    kernel = ctypes.windll.kernel32  # type: ignore[attr-defined]
    handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    code = ctypes.c_ulong()
    try:
        kernel.GetExitCodeProcess(handle, ctypes.byref(code))
    finally:
        kernel.CloseHandle(handle)
    return code.value == 259  # STILL_ACTIVE


def holder(path: str = LOCK) -> dict:
    """What the lock file says about who holds it, or {} when there is none or
    it does not read."""
    try:
        with open(path, encoding="utf-8") as held:
            owner = json.load(held)
    except (OSError, ValueError):
        return {}
    return owner if isinstance(owner, dict) else {}


def _pid(owner: dict) -> int:
    try:
        return int(owner.get("pid", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _try(path: str) -> dict | None:
    """One attempt: None when the lock is now this process's, or what the
    holder's file says when another live driver has it."""
    for _attempt in range(2):
        try:
            handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            owner = holder(path)
            pid = _pid(owner)
            if pid == os.getpid():
                return None
            if alive(pid):
                return owner
            if not owner:
                try:
                    young = time.time() - os.path.getmtime(path) < FRESH_SECONDS
                except OSError:
                    continue
                if young:
                    return {"pid": "?", "note": "being written"}
            try:
                os.remove(path)
            except OSError:
                pass
            continue
        with os.fdopen(handle, "w", encoding="utf-8") as mine:
            json.dump(
                {
                    "pid": os.getpid(),
                    "since": datetime.datetime.now().isoformat(timespec="seconds"),
                    "argv": [os.path.basename(sys.argv[0])] + sys.argv[1:3],
                    "project": "neques-realm",
                },
                mine,
            )
        atexit.register(drop, path)
        return None
    return {"pid": "?", "note": "lost the race twice"}


def take(wait: float = 0.0, path: str = LOCK, say=print) -> bool:
    """Takes the browser for this process, waiting up to `wait` seconds for a
    driver that holds it. True when taken, False when it is still held."""
    deadline = time.time() + max(wait, 0.0)
    said = False
    while True:
        owner = _try(path)
        if owner is None:
            return True
        if time.time() >= deadline:
            say("another driver holds the browser: %s" % json.dumps(owner))
            return False
        if not said:
            say("another driver holds the browser (%s); waiting up to %.0f s" % (json.dumps(owner), wait))
            said = True
        time.sleep(min(POLL_SECONDS, max(deadline - time.time(), 0.1)))


def drop(path: str = LOCK) -> None:
    """Gives the browser back, if this process holds it."""
    if _pid(holder(path)) != os.getpid():
        return
    try:
        os.remove(path)
    except OSError:
        pass
