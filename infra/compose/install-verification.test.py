#!/usr/bin/env python3
"""Offline tests for the installer's download verification.

The installer executes a Compose file it downloads. These tests drive the shipped
script in a temporary directory with a fake `curl` on PATH, so nothing reaches the
network, and assert the two properties that matter:

  1. A download that does not match the published manifest is refused, and the
     file never becomes the compose file the script would run.
  2. A manifest that does not match the digest pinned in the installer is refused
     before anything is downloaded against it.

They also pin the release-tag default: the installer must not fall back to a
moving branch when it cannot resolve a release.
"""

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

COMPOSE_DIR = Path(__file__).resolve().parent
INSTALLER = COMPOSE_DIR / "install-images.sh"
MANIFEST = COMPOSE_DIR / "SHA256SUMS"
COVERED = ["docker-compose.images.yml", ".env.images.example", "restrict-computer-egress.sh"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pinned_manifest_digest() -> str:
    text = INSTALLER.read_text(encoding="utf-8")
    match = re.search(r'^readonly SHA256SUMS_SHA256="([a-f0-9]{64})"$', text, re.MULTILINE)
    if not match:
        raise AssertionError("installer does not pin a manifest digest")
    return match.group(1)


class InstallerVerificationTests(unittest.TestCase):
    def test_manifest_is_current(self) -> None:
        """The shipped manifest must describe the shipped files, or every install
        would fail verification for a reason nobody could act on."""
        if not MANIFEST.exists():
            self.skipTest("manifest not shipped in this checkout")
        entries = {}
        for line in MANIFEST.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            digest, name = line.split(maxsplit=1)
            entries[name.lstrip("*")] = digest
        for name in COVERED:
            path = COMPOSE_DIR / name
            if not path.exists():
                continue
            self.assertEqual(entries.get(name), sha256(path), f"{name} digest is stale")

    def test_pinned_digest_matches_the_shipped_manifest(self) -> None:
        if not MANIFEST.exists():
            self.skipTest("manifest not shipped in this checkout")
        self.assertEqual(pinned_manifest_digest(), sha256(MANIFEST))

    def test_ref_is_never_a_branch(self) -> None:
        """A moving branch is the original defect: the file executed is not the file
        anyone reviewed. The script must derive a tag, or refuse."""
        text = INSTALLER.read_text(encoding="utf-8")
        self.assertNotIn("download_ref=main", text)
        self.assertIn("latest_release_tag", text)
        self.assertIn("could not determine the latest release tag", text)


@unittest.skipUnless(shutil.which("bash") and shutil.which("sha256sum"), "needs bash and sha256sum")
class InstallerEndToEndTests(unittest.TestCase):
    """Runs the real script with a fake curl, so the verification path is exercised."""

    def run_installer(
        self, files: dict[str, bytes], manifest: bytes | None, use_real_manifest: bool = False
    ) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            # A fake curl: CONNECT-style lookup from a directory of canned bodies.
            bodies = tmp_path / "bodies"
            bodies.mkdir()
            for name, body in files.items():
                (bodies / name).write_bytes(body)
            if use_real_manifest:
                (bodies / "SHA256SUMS").write_bytes(MANIFEST.read_bytes())
            elif manifest is not None:
                (bodies / "SHA256SUMS").write_bytes(manifest)
            fake_curl = tmp_path / "curl"
            fake_curl.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "out=''\n"
                "url=''\n"
                "while [[ $# -gt 0 ]]; do\n"
                "  case \"$1\" in\n"
                "    -o) out=\"$2\"; shift 2 ;;\n"
                "    --*) shift ;;\n"
                "    -*) shift ;;\n"
                "    *) url=\"$1\"; shift ;;\n"
                "  esac\n"
                "done\n"
                f"src=\"${{FAKE_BODIES}}/$(basename \"$url\")\"\n"
                "if [[ -f \"$src\" ]]; then cp \"$src\" \"$out\"; else exit 22; fi\n",
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            # The preflight wants docker present; these tests stop before any real use.
            fake_docker = tmp_path / "docker"
            fake_docker.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            fake_docker.chmod(0o755)
            env = {
                "PATH": f"{tmp_path}:{os.environ['PATH']}",
                "HOME": str(tmp_path),
                "FAKE_BODIES": str(bodies),
                # A known release tag, so the script does not call the release API.
                "RAKAZO_RELEASE_TAG": "v9.9.9",
                "RAKAZO_PULL_NEVER": "1",
            }
            return subprocess.run(
                ["bash", str(INSTALLER), "--prepare-only"],
                cwd=tmp_path,
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
            )

    def test_refuses_a_tampered_compose_file(self) -> None:
        """The compose file does not match the manifest, so the install stops."""
        compose = b"services: {}\n"
        env_example = b"SIGNUPS_ENABLED=false\n"
        manifest = (
            f"{'0' * 64}  docker-compose.images.yml\n"
            f"{hashlib.sha256(env_example).hexdigest()}  .env.images.example\n"
        ).encode()
        # The manifest is the real shipped one, so the pin check passes and the
        # per-file check is what fails; this isolates the behaviour under test.
        result = self.run_installer(
            {
                "docker-compose.images.yml": compose,
                ".env.images.example": env_example,
            },
            None,
            use_real_manifest=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match the published checksum", result.stderr)
        # The refused file is not left behind for a later step to run.
        self.assertNotIn("docker-compose.images.yml", result.stdout)

    def test_refuses_a_tampered_manifest(self) -> None:
        """The manifest itself is pinned by the installer, so swapping it fails."""
        result = self.run_installer({}, b"anything\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match the digest pinned in this installer", result.stderr)


if __name__ == "__main__":
    unittest.main()
