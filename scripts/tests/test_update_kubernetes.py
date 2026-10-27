import argparse
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "kubernetes_updates", ROOT / "scripts/update-kubernetes.py"
)
updates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updates)
OLD = "registry/app@sha256:" + "a" * 64
NEW = "registry/app@sha256:" + "b" * 64


class KubernetesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        args = argparse.Namespace(
            context="test",
            namespace="test",
            deployment="stiva-browser",
            state_dir=temporary.name,
            timeout=10,
        )
        self.deployment = updates.Kubernetes(args)
        self.previous = {
            "context": self.deployment.base,
            "deployment": "stiva-browser",
            "image": OLD,
        }
        self.deployment.snapshot = Mock(return_value=self.previous)
        self.deployment.patch = Mock()

    def test_update_and_explicit_rollback_use_exact_digests(self):
        self.deployment.update(NEW)
        self.deployment.patch.assert_called_once_with(NEW)
        self.assertEqual(
            json.loads(self.deployment.previous.read_text()), self.previous
        )
        self.deployment.rollback()
        self.deployment.patch.assert_called_with(OLD)

    def test_failed_rollout_restores_previous_digest(self):
        self.deployment.patch.side_effect = [RuntimeError("not ready"), None]
        with self.assertRaisesRegex(RuntimeError, "previous image is ready"):
            self.deployment.update(NEW)
        self.assertEqual(self.deployment.patch.call_args_list[1].args, (OLD,))

    def test_mutable_tags_are_rejected_before_cluster_access(self):
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.deployment.update("registry/app:latest")
        self.deployment.snapshot.assert_not_called()

    def test_unchanged_image_does_not_destroy_rollback_point(self):
        self.deployment.update(OLD)
        self.deployment.patch.assert_not_called()
        self.assertFalse(self.deployment.previous.exists())

    def test_cross_cluster_rollback_is_rejected(self):
        self.deployment.previous.write_text(
            json.dumps({**self.previous, "context": ["other"]})
        )
        with self.assertRaisesRegex(ValueError, "different cluster"):
            self.deployment.rollback()
        self.deployment.patch.assert_not_called()

    def test_snapshot_records_running_digest_instead_of_mutable_spec(self):
        self.deployment.snapshot = updates.Kubernetes.snapshot.__get__(self.deployment)
        self.deployment.wait = Mock()
        self.deployment.command = Mock(
            side_effect=[
                json.dumps(
                    {"spec": {"selector": {"matchLabels": {"app": "stiva-browser"}}}}
                ),
                json.dumps(
                    {
                        "items": [
                            {
                                "metadata": {},
                                "status": {
                                    "containerStatuses": [
                                        {
                                            "name": "stiva-browser",
                                            "ready": True,
                                            "imageID": "docker-pullable://" + OLD,
                                        }
                                    ]
                                },
                            }
                        ]
                    }
                ),
            ]
        )
        self.assertEqual(self.deployment.snapshot()["image"], OLD)

    def test_patch_changes_only_app_image_and_waits_for_readiness(self):
        self.deployment.patch = updates.Kubernetes.patch.__get__(self.deployment)
        self.deployment.command = Mock()
        self.deployment.patch(NEW)
        command = self.deployment.command.call_args_list[0].args
        payload = json.loads(command[-1])
        self.assertEqual(
            payload["spec"]["template"]["spec"]["containers"],
            [{"name": "stiva-browser", "image": NEW}],
        )
        self.assertEqual(
            self.deployment.command.call_args_list[1].args[0:2], ("rollout", "status")
        )


if __name__ == "__main__":
    unittest.main()
