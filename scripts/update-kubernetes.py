#!/usr/bin/env python3
"""Update the existing Stiva Browser Deployment with readiness checks and rollback."""

import argparse
import importlib.util
import json
import re
import subprocess
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "deployment_updates", Path(__file__).with_name("update-deployment.py")
)
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


class Kubernetes:
    def __init__(self, args):
        self.args = args
        self.base = [
            "kubectl",
            "--context",
            args.context,
            "--namespace",
            args.namespace,
        ]
        self.state = Path(args.state_dir).resolve()
        self.previous = self.state / "kubernetes-previous.json"

    def command(self, *args, capture=False):
        return helpers.run(
            self.base + list(args), capture=capture, timeout=self.args.timeout + 30
        )

    def wait(self):
        self.command(
            "rollout",
            "status",
            f"deployment/{self.args.deployment}",
            f"--timeout={self.args.timeout}s",
        )

    def patch(self, image):
        payload = {
            "spec": {
                "template": {
                    "spec": {"containers": [{"name": "stiva-browser", "image": image}]}
                }
            }
        }
        self.command(
            "patch",
            "deployment",
            self.args.deployment,
            "--type",
            "strategic",
            "-p",
            json.dumps(payload),
        )
        self.wait()

    def snapshot(self):
        self.wait()
        deployment = json.loads(
            self.command(
                "get", "deployment", self.args.deployment, "-o", "json", capture=True
            )
        )
        labels = deployment["spec"]["selector"]["matchLabels"]
        selector = ",".join(f"{key}={value}" for key, value in labels.items())
        pods = json.loads(
            self.command("get", "pods", "-l", selector, "-o", "json", capture=True)
        )["items"]
        images = set()
        for pod in pods:
            if pod["metadata"].get("deletionTimestamp"):
                continue
            for container in pod.get("status", {}).get("containerStatuses", []):
                if container["name"] == "stiva-browser" and container["ready"]:
                    images.add(container["imageID"].removeprefix("docker-pullable://"))
        if len(images) != 1 or not re.fullmatch(
            r".+@sha256:[0-9a-f]{64}", next(iter(images), "")
        ):
            raise ValueError(
                "Could not identify a single ready image digest for rollback"
            )
        return {
            "context": self.base,
            "deployment": self.args.deployment,
            "image": images.pop(),
        }

    def rollback(self):
        saved = json.loads(self.previous.read_text())
        if saved["context"] != self.base or saved["deployment"] != self.args.deployment:
            raise ValueError(
                "Rollback belongs to a different cluster, namespace or deployment"
            )
        self.patch(saved["image"])
        print("Previous image restored and ready; PVC retained.")

    def update(self, image):
        if not re.fullmatch(r".+@sha256:[0-9a-f]{64}", image):
            raise ValueError(
                "Use an immutable registry image reference with @sha256:digest"
            )
        previous = self.snapshot()
        if previous["image"] == image:
            print("The requested image is already ready.")
            return
        helpers.write_json(self.previous, previous)
        try:
            self.patch(image)
        except (Exception, KeyboardInterrupt) as error:
            try:
                self.rollback()
            except Exception as recovery:
                raise RuntimeError(
                    f"Rollout and recovery failed; operator attention is required: {recovery}"
                ) from error
            raise RuntimeError(
                "Rollout failed; the previous image is ready again"
            ) from error
        print("Update is ready. The previous image is recorded for rollback.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--deployment", default="stiva-browser")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument(
        "--state-dir",
        default=str(Path(__file__).resolve().parents[1] / ".update-state"),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    commands.add_parser("rollback")
    update = commands.add_parser("update")
    update.add_argument("--image", required=True)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    deployment = Kubernetes(args)
    try:
        with helpers.locked(deployment.state):
            if args.command == "status":
                print(json.dumps(deployment.snapshot(), indent=2))
            elif args.command == "rollback":
                deployment.rollback()
            else:
                deployment.update(args.image)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
