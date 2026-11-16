"""Run the real boot script offline with stand-ins for Postgres and app processes."""
import contextlib
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import unittest


STUB = r'''#!/usr/bin/env python3
import os, pathlib, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
data = pathlib.Path(os.environ["PREVIEW_DATA_DIR"])
if name == "install":
    pathlib.Path(args[-1]).mkdir(parents=True, exist_ok=True)
elif name == "chown":
    pass
elif name == "gosu":
    os.execvp(args[1], args[1:])
elif name == "initdb":
    (data / "postgres/PG_VERSION").write_text("18")
elif name == "createdb":
    assert not (data / "postgres/.preview-image").exists(), "Stale setup marker"
    (data / "postgres/database").touch()
elif name == "psql":
    if any(a.startswith("owner_email=") for a in args):
        print("t" if (data / "postgres/demo-account").exists() else "f")
    else:
        if (data / "postgres/database").exists(): print("1")
elif name == "node" and any("migrate-database" in a for a in args):
    with (data / "calls").open("a") as f: f.write("migrate\n")
    fail = data / "fail-migrate"
    if fail.exists():
        fail.unlink()
        sys.exit(1)
elif name == "node" and any("bootstrap-owner" in a for a in args):
    with (data / "calls").open("a") as f: f.write("bootstrap\n")
    if (data / "fail-bootstrap").exists(): sys.exit(1)
    (data / "postgres/demo-account").touch()
elif name == "node":
    if "preview" in args:
        (data / "serving").touch()
    time.sleep(60)
'''


class PreviewBoot(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.preview = self.root / "infra/preview"
        self.preview.mkdir(parents=True)
        shutil.copy(Path(__file__).with_name("start.sh"), self.preview)
        (self.root / "apps/api").mkdir(parents=True)
        web = self.root / "apps/web/node_modules/.bin"
        web.mkdir(parents=True)
        (self.root / "apps/worker").mkdir(parents=True)
        self.data = self.root / "data"
        self.data.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("install", "chown", "gosu", "initdb", "createdb", "pg_ctl", "psql", "curl", "node"):
            stub = self.bin / name
            stub.write_text(STUB)
            stub.chmod(0o755)
        (web / "vite").write_text('#!/bin/sh\nexec node preview\n')
        (web / "vite").chmod(0o755)
        self.image = self.preview / "image-id"
        self.image.write_text("first-image\n")

    # How long the preview may take to serve. The script itself allows its API 120 seconds, so a
    # loaded runner is a reason to wait, not to fail: the test still requires that it serves.
    READY_TIMEOUT = 60.0
    # SIGTERM first, so the script's own trap runs; then this long for it to finish before the
    # group is killed. A teardown timing out is a fault in this harness, never a result.
    STOP_GRACE = 20.0

    @staticmethod
    def drain(process, collected):
        """Reads the script's output as it arrives, so no part of it depends on when it exits.

        Reading it after signalling (as `communicate` does) makes the verdict depend on how
        quickly every child that inherited the pipe goes away, which is exactly what a loaded
        runner does not promise.
        """
        assert process.stdout is not None
        for line in process.stdout:
            collected.append(line.decode(errors="replace"))

    @staticmethod
    def group_alive(pgid):
        """Whether anything is left in this process group, the script included."""
        try:
            os.killpg(pgid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    @classmethod
    def stop(cls, process):
        """Ends the preview's whole process group, escalating if anything outlives SIGTERM.

        The group is signalled even when the script has already exited: a child it started can
        outlive it — one that inherited the output pipe keeps this test waiting — and killing
        only the script leaves that child running.
        """
        pgid = process.pid
        deadline = time.monotonic() + cls.STOP_GRACE
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                return
            while time.monotonic() < deadline:
                process.poll()
                if not cls.group_alive(pgid):
                    return
                time.sleep(0.02)
            # Escalate: a process that ignored SIGTERM gets SIGKILL.
            deadline = time.monotonic() + 10.0
        # Nothing may hang the suite: reap what can be reaped and move on.
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=5)

    def boot(self, succeeds=True):
        serving = self.data / "serving"
        serving.unlink(missing_ok=True)
        process = subprocess.Popen(
            ["bash", str(self.preview / "start.sh")],
            env={**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                 "PREVIEW_DATA_DIR": str(self.data), "PG_BIN": str(self.bin),
                 "PREVIEW_HOST": "preview.example.test"},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
        )
        collected: list[str] = []
        reader = threading.Thread(target=self.drain, args=(process, collected), daemon=True)
        reader.start()
        try:
            # Polling, with a deadline generous enough for a loaded runner. What is asserted is
            # unchanged: it serves (or does not), and the failure path exits non-zero.
            deadline = time.monotonic() + self.READY_TIMEOUT
            while not serving.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(serving.exists(), succeeds)
            if not succeeds:
                self.assertNotEqual(process.wait(timeout=self.READY_TIMEOUT), 0)
        finally:
            self.stop(process)
            # The reader ends at EOF; a child that outlived the kill cannot hold this up.
            reader.join(timeout=self.STOP_GRACE)
            if succeeds:
                self.assertIn("[preview] Ready", "".join(collected))

    def calls(self):
        return (self.data / "calls").read_text().splitlines()

    def test_first_boot_then_wake_then_new_image_and_rollback(self):
        self.boot()
        self.assertEqual(self.calls(), ["migrate", "bootstrap"])
        self.boot()
        self.assertEqual(self.calls(), ["migrate", "bootstrap"])
        self.image.write_text("second-image\n")
        self.boot()
        self.image.write_text("first-image\n")
        self.boot()
        self.assertEqual(self.calls(), ["migrate", "bootstrap"] * 3)

    def test_failed_setup_is_retried(self):
        (self.data / "fail-bootstrap").touch()
        self.boot(succeeds=False)
        self.assertFalse((self.data / "postgres/.preview-image").exists())
        (self.data / "fail-bootstrap").unlink()
        self.boot()
        self.assertEqual(self.calls(), ["migrate", "bootstrap"] * 2)

    def test_migration_failure_resets_disposable_database(self):
        self.boot()
        self.image.write_text("second-image\n")
        old_file = self.data / "postgres/old-data"
        old_file.touch()
        (self.data / "fail-migrate").touch()
        self.boot()
        self.assertFalse(old_file.exists())
        self.assertEqual(self.calls(), ["migrate", "bootstrap", "migrate", "migrate", "bootstrap"])
        self.boot()
        self.assertEqual(len(self.calls()), 5)

    def test_missing_image_id_keeps_local_boots_working(self):
        self.image.unlink()
        self.boot()
        self.boot()
        self.assertEqual(self.calls(), ["migrate", "bootstrap"] * 2)

    def test_replaced_database_needs_setup_again(self):
        self.boot()
        shutil.rmtree(self.data / "postgres")
        self.boot()
        self.assertEqual(self.calls(), ["migrate", "bootstrap"] * 2)

    def test_recreated_database_in_existing_cluster_needs_setup_again(self):
        self.boot()
        (self.data / "postgres/database").unlink()
        (self.data / "postgres/demo-account").unlink()
        self.assertTrue((self.data / "postgres/.preview-image").exists())
        self.boot()
        self.assertEqual(self.calls(), ["migrate", "bootstrap"] * 2)

    def test_deleted_demo_account_is_restored_without_migrations(self):
        self.boot()
        (self.data / "postgres/demo-account").unlink()
        self.boot()
        self.assertTrue((self.data / "postgres/demo-account").exists())
        self.assertEqual(self.calls(), ["migrate", "bootstrap", "bootstrap"])

    def test_failed_demo_account_recovery_is_retried(self):
        self.boot()
        (self.data / "postgres/demo-account").unlink()
        (self.data / "fail-bootstrap").touch()
        self.boot(succeeds=False)
        self.assertFalse((self.data / "postgres/.preview-image").exists())
        (self.data / "fail-bootstrap").unlink()
        self.boot()
        self.assertTrue((self.data / "postgres/demo-account").exists())
        self.assertEqual(self.calls(), ["migrate", "bootstrap", "bootstrap", "migrate", "bootstrap"])


if __name__ == "__main__":
    unittest.main()
